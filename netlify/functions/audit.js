/**
 * POST /.netlify/functions/audit   { "url": "acme.com" }
 *
 * Netlify Functions v2 (Request in, Response out).
 */

import { createHash, timingSafeEqual } from 'node:crypto';

import { auditUrl, errorResponse } from '../../src/audit.js';
import { RATE_LIMIT } from '../../src/config.js';
import { createRateLimiter } from '../../src/ratelimit.js';

/**
 * The unlock key for the locked sections.
 *
 * Set AUDIT_UNLOCK_KEY in the Netlify environment to a long random string.
 * A request carrying it in `x-audit-key` (or `key` in the body) gets the
 * full report; everyone else gets it redacted server-side.
 *
 * Unset means nobody can unlock over HTTP, which is the safe default - a
 * missing variable must never open the gate. The owner's own runs go through
 * `npm run audit`, which calls the audit directly and is always unlocked.
 */
export function isUnlocked(provided) {
  const expected = process.env.AUDIT_UNLOCK_KEY || '';
  if (!expected || !provided) return false;

  // Hash both sides first so the comparison is fixed-length and the check
  // leaks neither the key's length nor where it first differs.
  const a = createHash('sha256').update(String(provided)).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * The rate limiter needs to tell callers apart. It does not need to know who
 * they are, so it never sees a raw address: this is what goes into the store,
 * and it is deleted with the rest of the window a minute later.
 *
 * Set RATE_SALT to make the hash secret-keyed. Without it the hash still
 * keeps plaintext addresses out of storage, which is the point.
 */
function callerKey(ip) {
  const salt = process.env.RATE_SALT || process.env.AUDIT_UNLOCK_KEY || 'lead-capture-audit';
  return createHash('sha256').update(salt).update('|').update(ip).digest('hex').slice(0, 20);
}

/**
 * The shared store behind layer 3 of the rate limiter.
 *
 * Netlify Blobs is part of the platform - no external service, no schema,
 * nothing to provision. Off Netlify (local dev, the CLI) `getStore` throws,
 * and the limiter falls back to its two in-instance layers rather than
 * failing the request.
 */
async function openSharedStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    const blob = getStore({ name: 'rate-limit', consistency: 'strong' });
    // Prove it actually works before trusting it with the limit.
    await blob.get('__probe', { type: 'text' });
    return {
      get: (key) => blob.get(key, { type: 'json' }),
      set: (key, value) => blob.setJSON(key, value),
      delete: (key) => blob.delete(key)
    };
  } catch {
    return null;
  }
}

const limiter = createRateLimiter({
  requests: RATE_LIMIT.requests,
  windowMs: RATE_LIMIT.window_ms,
  instanceRequests: RATE_LIMIT.instance_requests,
  globalRequests: RATE_LIMIT.global_requests
});

/**
 * Opens the shared store once, on the first request rather than at module
 * load, and hands it to the limiter.
 *
 * This ordering is the whole point. Netlify injects the Blobs context per
 * invocation, so a store opened while the module is still initialising is
 * unconfigured, throws, and leaves that instance falling back to per-instance
 * counting for its entire life. Measured in production: 16 parallel requests
 * against a limit of 8 let 15 through.
 */
let storeReady = null;
function ensureSharedStore() {
  if (!storeReady) {
    storeReady = openSharedStore().then((store) => {
      limiter.useStore(store);
      log('store', {
        sharedRateLimit: Boolean(store),
        saltConfigured: Boolean(process.env.RATE_SALT),
        unlockConfigured: Boolean(process.env.AUDIT_UNLOCK_KEY)
      });
      return store;
    });
  }
  return storeReady;
}

/**
 * Structured logs, so Netlify's function log is a funnel you can actually
 * read and alert on without adding a third-party script to the page.
 *
 * The scanned URL is never in here, and must never be: the footer promises
 * we keep no record of what you scanned, and a log line is a record. Score
 * and duration carry no identity and are what you actually want to know.
 */
function log(evt, fields = {}) {
  if (process.env.AUDIT_LOG === 'off') return;      // the test suite
  const line = JSON.stringify({ evt, at: new Date().toISOString(), ...fields });
  if (fields.level === 'error') console.error(line);
  else console.log(line);
}

const LIMIT_COPY = {
  ip: `That is more than ${RATE_LIMIT.requests} scans in a minute. Give it a minute and try again.`,
  'ip-shared': `That is more than ${RATE_LIMIT.requests} scans in a minute. Give it a minute and try again.`,
  instance: 'We are handling a lot of scans right now. Try again in a minute.',
  global: 'We are handling a lot of scans right now. Try again in a minute.'
};

/**
 * Origins allowed to call this endpoint from a browser.
 *
 * `*` used to be here, which made the function a free URL fetcher anyone
 * could bolt onto their own site. The allowlist is derived from the
 * environment Netlify already provides, so it needs no configuration:
 * the live site, the branch/deploy preview, and localhost for development.
 *
 * Note what this does and does not buy: it stops a browser on someone else's
 * page using your function. It does not stop a script, which can simply omit
 * the Origin header. The control for that is the rate limiter.
 */
export function allowedOrigin(origin) {
  if (!origin) return null;                       // curl, server-side - no CORS involved
  const allowed = [process.env.SITE_URL, process.env.URL, process.env.DEPLOY_PRIME_URL]
    .filter(Boolean)
    .map((u) => u.replace(/\/+$/, ''));

  if (allowed.includes(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return false;                                   // present, and not ours
}

const json = (body, status = 200, origin = null) => {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    vary: 'Origin'
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-headers'] = 'content-type, x-audit-key';
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-max-age'] = '86400';
  }
  // 204 must not carry a body, and constructing one that does throws.
  if (status === 204) {
    delete headers['content-type'];
    return new Response(null, { status, headers });
  }
  return new Response(JSON.stringify(body), { status, headers });
};

export default async function handler(request, context) {
  const origin = allowedOrigin(request.headers.get('origin'));

  // An Origin that is present and is not ours means a browser on someone
  // else's page. Refuse it outright rather than merely withholding the CORS
  // header - there is no legitimate caller in that shape.
  if (origin === false) {
    log('forbidden_origin', { origin: request.headers.get('origin') });
    return json({ ok: false, error: { code: 'forbidden_origin', title: 'Not allowed', message: 'This endpoint only serves its own site.' } }, 403);
  }

  if (request.method === 'OPTIONS') {
    return json({ ok: true }, 204, origin);
  }
  if (request.method !== 'POST') {
    return json({ ok: false, error: { code: 'method', title: 'Not allowed', message: 'Use POST.' } }, 405, origin);
  }

  const ip =
    request.headers.get('x-nf-client-connection-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
    context?.ip ||
    'unknown';

  // Must happen inside the request: see ensureSharedStore().
  await ensureSharedStore();

  const allowance = await limiter.check(callerKey(ip));
  if (!allowance.ok) {
    log('rate_limited', { reason: allowance.reason, shared: limiter.hasSharedStore });
    const response = json(
      {
        ok: false,
        error: {
          code: 'rate_limited',
          title: 'Slow down a moment',
          message: LIMIT_COPY[allowance.reason] || LIMIT_COPY.ip,
          manualReview: false
        }
      },
      429,
      origin
    );
    response.headers.set('retry-after', String(allowance.retryAfter));
    return response;
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: { code: 'invalid_url', title: 'No address received', message: 'Enter a website address.' } }, 400, origin);
  }

  const startedAt = Date.now();
  try {
    const unlocked = isUnlocked(request.headers.get('x-audit-key') || payload?.key);
    const result = await auditUrl(payload?.url, { unlocked });

    log('audit', {
      score: result.score,
      band: result.band,
      scoreable: result.scoreable,
      confidence: result.confidence.level,
      platforms: result.confidence.platforms,
      failed: result.counts.failed,
      unknown: result.counts.unknown,
      fetchMs: result.meta.elapsedMs,
      totalMs: Date.now() - startedAt,
      truncated: result.meta.truncated,
      unlocked
    });

    return json(result, 200, origin);
  } catch (err) {
    const body = errorResponse(err);
    const status = body.error.code === 'invalid_url' ? 400 : 200;
    const unexpected = body.error.code === 'unexpected';
    log('audit_failed', {
      code: body.error.code,
      totalMs: Date.now() - startedAt,
      level: unexpected ? 'error' : 'info',
      ...(unexpected ? { stack: err?.stack } : {})
    });
    return json(body, status, origin);
  }
}
