/**
 * Rate limiting for a public endpoint that fetches arbitrary URLs.
 *
 * The first version of this was a Map in module scope. That is per-lambda,
 * and Netlify runs many lambdas at once, so the real limit was 8 x however
 * many instances happened to be warm - which is to say, no limit at all
 * during exactly the traffic spike it existed to survive.
 *
 * Three layers now, cheapest first:
 *
 *   1. per-IP, in this instance    catches one person hammering the form,
 *                                  with no I/O at all
 *   2. per-instance total          caps what any single lambda can spend,
 *                                  even if every request has a fresh IP
 *   3. per-IP and site-wide,       the real cross-instance limit, and the
 *      in a shared store           one that guards the bill
 *
 * Layer 3 needs a store. If none is available - locally, or from the CLI -
 * the limiter degrades to 1 and 2 and says so, rather than pretending.
 *
 * Layers 1 and 2 use a sliding window. Layer 3 uses a fixed window, because
 * a shared store has no atomic increment and fixed buckets keep the read and
 * the write to one key. The cost is that a burst straddling a boundary can
 * reach 2x the limit for a moment, which is an acceptable trade for a form
 * that a human presses.
 */

/** In-process store. Also the fallback when no shared store is configured. */
export class MemoryStore {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) ?? null; }
  async set(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
  get size() { return this.map.size; }
}

export function createRateLimiter({
  requests,
  windowMs,
  instanceRequests = 0,
  globalRequests = 0,
  store = null,
  now = () => Date.now()
} = {}) {
  const perIp = new Map();      // caller -> timestamps, sliding
  let instance = [];            // all timestamps, sliding
  let lastBucket = null;        // for tidying the previous shared window
  let shared = store;           // may arrive later - see useStore()

  const prune = (times, at) => times.filter((t) => at - t < windowMs);

  return {
    get hasSharedStore() { return Boolean(shared); },

    /**
     * Attach the shared store after construction.
     *
     * Netlify injects the Blobs context per invocation, not at module load,
     * so a store opened while the module is initialising is not configured
     * and never works. The caller resolves it on the first request and hands
     * it over here.
     */
    useStore(next) { shared = next || null; },

    async check(ip) {
      const at = now();
      const retryAfter = Math.ceil(windowMs / 1000);

      // --- 1. per-IP, this instance -----------------------------------------
      const mine = prune(perIp.get(ip) || [], at);
      if (mine.length >= requests) {
        perIp.set(ip, mine);
        return { ok: false, reason: 'ip', retryAfter };
      }

      // --- 2. per-instance total --------------------------------------------
      instance = prune(instance, at);
      if (instanceRequests && instance.length >= instanceRequests) {
        return { ok: false, reason: 'instance', retryAfter };
      }

      // --- 3. shared, across every instance ---------------------------------
      //
      // One document per window, not one key per caller. A key per caller
      // would leave a blob behind for every visitor for ever, because the
      // store has no expiry - a slow leak that nobody notices until the
      // bill does. This way there is exactly one live key, and the previous
      // window's key is deleted as soon as the bucket rolls over.
      if (shared) {
        const bucket = Math.floor(at / windowMs);
        const key = `w:${bucket}`;
        try {
          const doc = (await shared.get(key)) || { total: 0, callers: {} };
          const seen = doc.callers[ip] || 0;

          if (seen >= requests) return { ok: false, reason: 'ip-shared', retryAfter };
          if (globalRequests && doc.total >= globalRequests) {
            return { ok: false, reason: 'global', retryAfter };
          }

          doc.total += 1;
          // Bound the document. Past this many distinct callers in one window
          // the site-wide ceiling is doing the work anyway.
          if (seen || Object.keys(doc.callers).length < 5000) doc.callers[ip] = seen + 1;
          await shared.set(key, doc);

          if (bucket !== lastBucket) {
            lastBucket = bucket;
            Promise.resolve(shared.delete?.(`w:${bucket - 1}`)).catch(() => {});
          }
        } catch {
          // A store outage must not take the tool down with it. Layers 1 and 2
          // still apply, and they are the ones that stop the obvious abuse.
        }
      }

      // --- record and admit --------------------------------------------------
      mine.push(at);
      perIp.set(ip, mine);
      instance.push(at);

      // Keep the per-IP map from growing without bound on a long-lived instance.
      if (perIp.size > 5000) {
        for (const [key, times] of perIp) {
          if (!prune(times, at).length) perIp.delete(key);
        }
      }

      return { ok: true };
    }
  };
}
