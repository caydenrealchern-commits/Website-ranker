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
 * Layers 1 and 2 use a sliding window. Layer 3 uses a fixed window in one
 * document per bucket, updated by compare-and-swap.
 *
 * An earlier version read the document, incremented, and wrote it back. That
 * is a race, and not a theoretical one: measured against the live site, 16
 * simultaneous requests on a cold fleet all read the same zero and all
 * admitted themselves, against a limit of 8. The store does support
 * conditional writes, so the write now only lands if the document has not
 * changed since the read, and a losing writer retries against the new value.
 */

/**
 * In-process store, and the stand-in for the real one in tests.
 *
 * Implements the same compare-and-swap contract as the Netlify Blobs
 * adapter: `read` hands back an etag, and a write only lands if the etag
 * still matches. That is what lets the tests reproduce a lost update.
 */
export class MemoryStore {
  constructor() { this.map = new Map(); this.etags = new Map(); this.seq = 0; }

  async read(key) {
    const stored = this.map.get(key);
    return {
      // Deep copy, because the real store hands back freshly parsed JSON.
      // Returning the live object would let a caller whose conditional write
      // is about to FAIL still mutate the shared document - a corruption the
      // network makes impossible, and which a test double must not invent.
      value: stored === undefined ? null : structuredClone(stored),
      etag: this.etags.get(key) ?? null
    };
  }

  async writeIfMatch(key, value, etag) {
    if ((this.etags.get(key) ?? null) !== etag) return false;
    this.map.set(key, structuredClone(value));
    this.etags.set(key, `v${++this.seq}`);
    return true;
  }

  async writeIfNew(key, value) {
    if (this.map.has(key)) return false;
    this.map.set(key, structuredClone(value));
    this.etags.set(key, `v${++this.seq}`);
    return true;
  }

  async delete(key) { this.map.delete(key); this.etags.delete(key); }
  get size() { return this.map.size; }
}

/** Retries before a contended write gives up and refuses. */
const CAS_ATTEMPTS = 6;

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
          // Compare-and-swap. A losing writer re-reads and tries again rather
          // than clobbering the winner's count.
          let verdict = null;
          for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
            const { value, etag } = await shared.read(key);
            const doc = value || { total: 0, callers: {} };
            const seen = doc.callers[ip] || 0;

            if (seen >= requests) { verdict = 'ip-shared'; break; }
            if (globalRequests && doc.total >= globalRequests) { verdict = 'global'; break; }

            doc.total += 1;
            // Bound the document. Past this many distinct callers in one
            // window the site-wide ceiling is doing the work anyway.
            if (seen || Object.keys(doc.callers).length < 5000) doc.callers[ip] = seen + 1;

            const won = etag
              ? await shared.writeIfMatch(key, doc, etag)
              : await shared.writeIfNew(key, doc);
            if (won) { verdict = 'ok'; break; }
          }

          // Exhausting the retries means heavy contention, which is itself a
          // reason to refuse rather than wave the request through.
          if (verdict === null) return { ok: false, reason: 'contended', retryAfter };
          if (verdict !== 'ok') return { ok: false, reason: verdict, retryAfter };

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
