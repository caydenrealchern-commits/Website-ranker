/**
 * Fixture tests, weighted heavily towards section 5.
 *
 * The tests that matter most are the two invariants at the bottom of this
 * file. Everything else is a specific case; those two are the promise the
 * tool makes to the person reading a report.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseDocument, isPlausiblePhone, usablePhone, textFromMarkup } from '../src/extract.js';
import { assessConfidence } from '../src/confidence.js';
import { runChecks } from '../src/checks.js';
import { scoreAudit } from '../src/score.js';
import { normaliseUrl, looksLikeBotWall, AuditError } from '../src/fetcher.js';
import { CHECKS, FIXES, GATE, RATE_LIMIT, USER_AGENT } from '../src/config.js';
import { buildReport, redactLocked } from '../src/audit.js';
import { createRateLimiter, MemoryStore } from '../src/ratelimit.js';
import handler, { allowedOrigin, isUnlocked } from '../netlify/functions/audit.js';

process.env.AUDIT_LOG = 'off';   // the handler logs; the suite should not

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');

let passed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
  } else {
    failures.push(`${name}${detail ? ' -- ' + detail : ''}`);
  }
}

function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function throws(name, fn, code) {
  try {
    fn();
    failures.push(`${name} -- expected to throw ${code}, returned normally`);
  } catch (err) {
    ok(name, err instanceof AuditError && err.code === code, `expected ${code}, got ${err?.code || err?.message}`);
  }
}

/** Runs the whole pipeline over a fixture without touching the network. */
function auditFixture(file, opts = {}) {
  const html = readFileSync(join(FIXTURES, file), 'utf8');
  const finalUrl = opts.finalUrl || 'https://example.test/';
  const doc = parseDocument(html, finalUrl);
  const fetchMeta = { truncated: Boolean(opts.truncated), elapsedMs: opts.elapsedMs ?? 800 };
  const confidence = assessConfidence(doc, fetchMeta);
  const raw = runChecks(doc, { finalUrl, elapsedMs: fetchMeta.elapsedMs, truncated: fetchMeta.truncated });
  const scored = scoreAudit(raw, confidence);
  return { doc, confidence, raw, scored, html };
}

const byId = (scored, id) => scored.checks.find((c) => c.id === id);
const defById = Object.fromEntries(CHECKS.map((c) => [c.id, c]));

// ===========================================================================
// URL handling
// ===========================================================================
eq('normalise: bare domain gets https', normaliseUrl('acme.com'), 'https://acme.com/');
eq('normalise: trims and lowercases host', normaliseUrl('  WWW.Acme.CO.UK/Path  '), 'https://www.acme.co.uk/Path');
eq('normalise: strips the fragment', normaliseUrl('acme.com/page#pricing'), 'https://acme.com/page');
eq('normalise: keeps an explicit http scheme', normaliseUrl('http://acme.com'), 'http://acme.com/');
throws('normalise: rejects javascript:', () => normaliseUrl('javascript:alert(1)'), 'invalid_url');
throws('normalise: rejects a bare hostname', () => normaliseUrl('localhost'), 'invalid_url');
throws('normalise: rejects a raw IP', () => normaliseUrl('127.0.0.1'), 'invalid_url');
throws('normalise: rejects a non-standard port', () => normaliseUrl('acme.com:8080'), 'invalid_url');
throws('normalise: rejects credentials in the URL', () => normaliseUrl('http://a:b@acme.com'), 'invalid_url');
throws('normalise: rejects an empty string', () => normaliseUrl('   '), 'invalid_url');

// ===========================================================================
// Bot walls are refused before anything gets scored
// ===========================================================================
ok('bot wall: cloudflare interstitial is detected',
  looksLikeBotWall(200, readFileSync(join(FIXTURES, 'cloudflare-wall.html'), 'utf8')));
ok('bot wall: a 403 is treated as blocked', looksLikeBotWall(403, '<html><body>nope</body></html>'));
ok('bot wall: an ordinary page is not', !looksLikeBotWall(200, readFileSync(join(FIXTURES, 'plain-html.html'), 'utf8')));

// ===========================================================================
// Phone plausibility - the filter that stops dates and IDs scoring as numbers
// ===========================================================================
ok('phone: accepts an international number', isPlausiblePhone('+44 118 946 0958'));
ok('phone: accepts a national number', isPlausiblePhone('(0118) 946 0958'));
ok('phone: rejects a run of one digit', !isPlausiblePhone('000 000 0000'));
ok('phone: rejects a short number', !isPlausiblePhone('946 0958'));
ok('phone: rejects an epoch timestamp', !isPlausiblePhone('1735689600000'));
ok('phone: rejects SVG path coordinates', !isPlausiblePhone('223.052 24.12'));
ok('phone: rejects a coordinate pair with a sign', !isPlausiblePhone('69 0 3.034-.48'));
ok('phone: rejects a CSS-ish triple', !isPlausiblePhone('001-.666-.588-1.04'));
ok('phone: accepts a dotted US number', isPlausiblePhone('555.123.4567'));
ok('phone: rejects the 0123456789 template placeholder', !isPlausiblePhone('0123456789'));
ok('phone: rejects 1234567890', !isPlausiblePhone('1234567890'));
ok('phone: rejects a descending run', !isPlausiblePhone('9876543210'));

// Structured data skips the candidate regex entirely, so it needs its own
// guard - facts.phones decides the wording of the report's headline.
ok('phone: structured empty string is not a usable number', !usablePhone(''));
ok('phone: structured whitespace is not a usable number', !usablePhone('   '));
ok('phone: structured placeholder is not usable', !usablePhone('0123456789'));
ok('phone: a real structured number is usable', usablePhone('+44 118 946 0958'));
ok('phone: a tel: prefix is tolerated', usablePhone('tel:+441189460958'));

// Markup stripping. A slice cut mid-tag must not leak attribute values as
// prose - that is where the SVG phone-number false positives came from.
ok('markup: drops a complete svg', !textFromMarkup('<p>hi</p><svg><path d="M223.052 24.12"/></svg>').includes('223'));
ok('markup: drops an svg left unterminated by the slice',
  !textFromMarkup('<p>hi</p><svg viewBox="0 0 10 10"><path d="M223.052 24.12a.23.23').includes('223'));
ok('markup: drops a tag cut mid-attribute',
  !textFromMarkup('<p>hi</p><path d="M223.052 24.12a.23').includes('223'));
ok('markup: keeps the actual words', textFromMarkup('<p>Call 0118 946 0958</p>').includes('0118 946 0958'));

// ===========================================================================
// Case: plain static small-business site
// ===========================================================================
{
  const { confidence, scored } = auditFixture('plain-html.html');
  eq('plain: confidence is high', confidence.level, 'high');
  eq('plain: score is published', scored.scoreable, true);
  eq('plain: everything is verifiable', scored.verifiablePoints, 100);
  eq('plain: click-to-call passes', byId(scored, 'tel_link').status, 'pass');
  eq('plain: phone in header passes', byId(scored, 'phone_in_header').status, 'pass');
  eq('plain: address passes', byId(scored, 'physical_address').status, 'pass');
  eq('plain: email passes', byId(scored, 'email_or_contact_link').status, 'pass');
  eq('plain: contact page passes', byId(scored, 'contact_page_linked').status, 'pass');
  eq('plain: no chat widget is a stated failure', byId(scored, 'chat_widget').status, 'fail');
  eq('plain: no booking link is a stated failure', byId(scored, 'booking_link').status, 'fail');
  eq('plain: no form is a stated failure', byId(scored, 'form_present').status, 'fail');
  ok('plain: lands mid-range', scored.score >= 40 && scored.score < 80, `score ${scored.score}`);
}

// ===========================================================================
// Case: well-built site
// ===========================================================================
{
  const { scored, confidence } = auditFixture('well-built.html');
  eq('well-built: confidence is high', confidence.level, 'high');
  eq('well-built: chat widget found', byId(scored, 'chat_widget').status, 'pass');
  eq('well-built: booking link found', byId(scored, 'booking_link').status, 'pass');
  eq('well-built: form found', byId(scored, 'form_present').status, 'pass');
  eq('well-built: form is short', byId(scored, 'form_fields_lean').status, 'pass');
  eq('well-built: hidden inputs are not counted as fields',
    byId(scored, 'form_fields_lean').evidence.includes('3 field'), true);
  eq('well-built: address comes from structured data', byId(scored, 'physical_address').via, 'structured');
  eq('well-built: CTA found', byId(scored, 'cta_text').status, 'pass');
  ok('well-built: scores Strong', scored.score >= 80, `score ${scored.score}, band ${scored.band}`);
}

// ===========================================================================
// Case: the empty React shell - THE case section 5 exists for
// ===========================================================================
{
  const { confidence, scored } = auditFixture('react-shell.html');
  eq('react shell: confidence is low', confidence.level, 'low');
  eq('react shell: failures may not be reported', confidence.canReportFailures, false);
  eq('react shell: no score is published', scored.scoreable, false);
  eq('react shell: score is null', scored.score, null);

  const renderFails = scored.checks.filter((c) => c.status === 'fail' && defById[c.id].renderSensitive);
  eq('react shell: zero render-sensitive failures reported', renderFails.length, 0);

  // The checks that do not depend on rendering are still answered.
  eq('react shell: viewport still verified', byId(scored, 'viewport_meta').status, 'pass');
  eq('react shell: https still verified', byId(scored, 'https').status, 'pass');
  eq('react shell: load time still verified', byId(scored, 'load_under_3s').status, 'pass');
  eq('react shell: only 17 points were verifiable', scored.verifiablePoints, 17);
  eq('react shell: 83 points unverified', scored.unverifiedPoints, 83);
  ok('react shell: the reason names the cause',
    /javascript|browser/i.test(confidence.reason), confidence.reason);
}

// ===========================================================================
// Case: Next.js that DOES server-render - the mirror bug
// ===========================================================================
{
  const { confidence, scored } = auditFixture('next-ssr.html');
  ok('next SSR: __NEXT_DATA__ alone does not lower confidence',
    confidence.level === 'high', `level ${confidence.level}, score ${confidence.score}`);
  eq('next SSR: platform is still named', confidence.platforms.includes('Next.js'), true);
  eq('next SSR: a score is published', scored.scoreable, true);
  eq('next SSR: click-to-call passes', byId(scored, 'tel_link').status, 'pass');
  eq('next SSR: CTA passes', byId(scored, 'cta_text').status, 'pass');
  eq('next SSR: real gaps are still reported', byId(scored, 'chat_widget').status, 'fail');
}

// ===========================================================================
// Case: Wix that server-renders - most real Wix sites
// ===========================================================================
{
  const { confidence, scored } = auditFixture('wix-ssr.html');
  eq('wix SSR: confidence is high', confidence.level, 'high');
  eq('wix SSR: platform named as Wix', confidence.platforms.includes('Wix'), true);
  eq('wix SSR: a score is published', scored.scoreable, true);
  eq('wix SSR: click-to-call passes', byId(scored, 'tel_link').status, 'pass');
  eq('wix SSR: address passes', byId(scored, 'physical_address').status, 'pass');
}

// ===========================================================================
// Case: shell whose payload still carries the contact details
// ===========================================================================
{
  const { confidence, scored } = auditFixture('spa-with-payload.html');
  eq('spa payload: confidence is low', confidence.level, 'low');
  eq('spa payload: click-to-call found in the payload', byId(scored, 'tel_link').status, 'pass');
  eq('spa payload: and it is labelled as coming from the payload', byId(scored, 'tel_link').via, 'embedded');
  eq('spa payload: booking link found in the payload', byId(scored, 'booking_link').status, 'pass');
  eq('spa payload: email found in the payload', byId(scored, 'email_or_contact_link').status, 'pass');
  eq('spa payload: address found in the payload', byId(scored, 'physical_address').status, 'pass');
  eq('spa payload: chat is unknown, not failed', byId(scored, 'chat_widget').status, 'unknown');
  eq('spa payload: unknown reason is the rendering', byId(scored, 'chat_widget').unknownReason, 'render');

  const renderFails = scored.checks.filter((c) => c.status === 'fail' && defById[c.id].renderSensitive);
  eq('spa payload: zero render-sensitive failures reported', renderFails.length, 0);
  ok('spa payload: more was verified than on a bare shell', scored.verifiablePoints > 17,
    `verifiable ${scored.verifiablePoints}`);
}

// ===========================================================================
// Case: a readable page that genuinely has no contact route
// ===========================================================================
{
  const { confidence, scored } = auditFixture('no-contact.html');
  eq('no contact: confidence is high', confidence.level, 'high');
  eq('no contact: click-to-call is a stated failure', byId(scored, 'tel_link').status, 'fail');
  eq('no contact: form is a stated failure', byId(scored, 'form_present').status, 'fail');
  eq('no contact: viewport is a stated failure', byId(scored, 'viewport_meta').status, 'fail');
  eq('no contact: nothing is unknown', scored.counts.unknown, 0);
  eq('no contact: the worst failure is the heaviest one', scored.worstFailure.id, 'tel_link');
  ok('no contact: band is Poor', scored.band === 'Poor', `band ${scored.band}, score ${scored.score}`);

  // The dependent check explains itself rather than reading like a bug.
  const lean = byId(scored, 'form_fields_lean');
  eq('no contact: short-form check names the real reason', lean.status, 'fail');
  ok('no contact: and does not claim the form is too long',
    lean.message.includes('no form'), lean.message);
}

// ===========================================================================
// Case: the small honest brochure page - the rescue
// ===========================================================================
{
  const { confidence, scored } = auditFixture('tiny-brochure.html');
  eq('tiny page: thin but readable is still high confidence', confidence.level, 'high');
  eq('tiny page: a score is published', scored.scoreable, true);
  eq('tiny page: click-to-call passes', byId(scored, 'tel_link').status, 'pass');
  eq('tiny page: missing form is a stated failure', byId(scored, 'form_present').status, 'fail');
}

// ===========================================================================
// Scoring arithmetic
// ===========================================================================
{
  const { scored } = auditFixture('spa-with-payload.html');
  eq('score: verifiable + unverified = 100', scored.verifiablePoints + scored.unverifiedPoints, 100);
  const sumPass = scored.checks.filter((c) => c.status === 'pass').reduce((n, c) => n + c.points, 0);
  eq('score: earned equals the sum of passing points', scored.earnedPoints, sumPass);
  const sumKnown = scored.checks.filter((c) => c.status !== 'unknown').reduce((n, c) => n + c.points, 0);
  eq('score: verifiable equals the sum of known points', scored.verifiablePoints, sumKnown);
}
{
  const { scored } = auditFixture('well-built.html');
  eq('score: at full confidence the score is the plain total',
    scored.score, Math.round((scored.earnedPoints / 100) * 100));
}

// ===========================================================================
// Slow and truncated responses
// ===========================================================================
{
  const { scored } = auditFixture('plain-html.html', { elapsedMs: 4200 });
  eq('slow site: load time fails', byId(scored, 'load_under_3s').status, 'fail');
  ok('slow site: the failure says how slow', byId(scored, 'load_under_3s').evidence.includes('4.2s'));
}
{
  const { confidence, scored } = auditFixture('plain-html.html', { truncated: true, elapsedMs: 6000 });
  ok('truncated: confidence is reduced', confidence.score < 100, `confidence ${confidence.score}`);
  eq('truncated: load time is still reported as failed', byId(scored, 'load_under_3s').status, 'fail');
  ok('truncated: the note says the page was cut off',
    byId(scored, 'load_under_3s').evidence.includes('still sending'));
}
{
  const { scored } = auditFixture('plain-html.html', { finalUrl: 'http://example.test/' });
  eq('http site: https check fails', byId(scored, 'https').status, 'fail');
}

// ===========================================================================
// Rate limiting
//
// The endpoint fetches arbitrary URLs on demand, so this is the control that
// stops it being used as someone else's scanner and stops a spike running up
// a bill. A clock is injected so the windows can be tested without waiting.
// ===========================================================================
{
  let clock = 1_000_000;
  const limiter = createRateLimiter({ requests: 3, windowMs: 1000, now: () => clock });

  const allow = async (ip, n) => {
    const out = [];
    for (let i = 0; i < n; i += 1) out.push((await limiter.check(ip)).ok);
    return out;
  };

  eq('limit: lets the first three through', JSON.stringify(await allow('1.1.1.1', 3)), '[true,true,true]');
  eq('limit: blocks the fourth', (await limiter.check('1.1.1.1')).ok, false);
  eq('limit: names the reason', (await limiter.check('1.1.1.1')).reason, 'ip');
  eq('limit: a different IP is unaffected', (await limiter.check('2.2.2.2')).ok, true);

  clock += 1001;
  eq('limit: the window slides open again', (await limiter.check('1.1.1.1')).ok, true);
}

{
  // The per-instance cap is what stops a rotating-IP flood, which the per-IP
  // limit alone does nothing about.
  let clock = 2_000_000;
  const limiter = createRateLimiter({ requests: 100, windowMs: 1000, instanceRequests: 5, now: () => clock });
  for (let i = 0; i < 5; i += 1) await limiter.check(`10.0.0.${i}`);
  const blocked = await limiter.check('10.0.0.99');
  eq('limit: a fresh IP is still capped by the instance budget', blocked.ok, false);
  eq('limit: and says which layer stopped it', blocked.reason, 'instance');
}

{
  // Layer 3. Two limiters standing in for two lambdas sharing one store -
  // the case the old in-memory Map got wrong.
  let clock = 3_000_000;
  const store = new MemoryStore();
  const opts = { requests: 2, windowMs: 1000, globalRequests: 100, store, now: () => clock };
  const lambdaA = createRateLimiter(opts);
  const lambdaB = createRateLimiter(opts);

  ok('limit: shared store is detected', lambdaA.hasSharedStore);
  eq('limit: first instance admits two', JSON.stringify([(await lambdaA.check('5.5.5.5')).ok, (await lambdaA.check('5.5.5.5')).ok]), '[true,true]');
  const crossed = await lambdaB.check('5.5.5.5');
  eq('limit: a second instance sees the first instance count', crossed.ok, false);
  eq('limit: and blames the shared layer', crossed.reason, 'ip-shared');
}

{
  // The wallet guard: a site-wide ceiling regardless of how many IPs appear.
  let clock = 4_000_000;
  const store = new MemoryStore();
  const limiter = createRateLimiter({ requests: 50, windowMs: 1000, globalRequests: 4, store, now: () => clock });
  for (let i = 0; i < 4; i += 1) await limiter.check(`7.7.7.${i}`);
  const over = await limiter.check('7.7.7.200');
  eq('limit: the site-wide ceiling holds', over.ok, false);
  eq('limit: and is reported as global', over.reason, 'global');
}

{
  // The old key-per-caller design left a blob behind for every visitor for
  // ever. Exactly one window key should be live at a time.
  let clock = 4_500_000;
  const store = new MemoryStore();
  const limiter = createRateLimiter({ requests: 50, windowMs: 1000, globalRequests: 500, store, now: () => clock });
  for (let i = 0; i < 20; i += 1) await limiter.check(`3.3.3.${i}`);
  eq('limit: one shared key per window, not one per caller', store.size, 1);
  clock += 1001;
  await limiter.check('3.3.3.99');
  await new Promise((r) => setTimeout(r, 0));   // the tidy-up is fire-and-forget
  eq('limit: the previous window is deleted on rollover', store.size, 1);
}

{
  // A store outage must degrade, not fail the request.
  let clock = 5_000_000;
  const broken = { get: async () => { throw new Error('blobs down'); }, set: async () => { throw new Error('blobs down'); } };
  const limiter = createRateLimiter({ requests: 2, windowMs: 1000, store: broken, now: () => clock });
  eq('limit: a broken store still admits traffic', (await limiter.check('8.8.8.8')).ok, true);
  await limiter.check('8.8.8.8');
  eq('limit: and the in-instance layer still applies', (await limiter.check('8.8.8.8')).ok, false);
}

// ===========================================================================
// CORS: the endpoint must not be a free URL fetcher for other people's sites
// ===========================================================================
{
  const saved = { SITE_URL: process.env.SITE_URL, URL: process.env.URL };
  process.env.SITE_URL = 'https://audit.example.com';
  delete process.env.URL;

  eq('cors: no Origin at all is not a CORS request', allowedOrigin(null), null);
  eq('cors: our own origin is echoed', allowedOrigin('https://audit.example.com'), 'https://audit.example.com');
  eq('cors: localhost is allowed for development', allowedOrigin('http://localhost:8888'), 'http://localhost:8888');
  eq('cors: another site is refused', allowedOrigin('https://evil.example'), false);
  eq('cors: a lookalike origin is refused', allowedOrigin('https://audit.example.com.evil.test'), false);
  eq('cors: http on our own host is refused', allowedOrigin('http://audit.example.com'), false);

  process.env.SITE_URL = saved.SITE_URL ?? '';
  // A 204 may not carry a body. Constructing one that does throws, which
  // would have broken every cross-origin preflight in production.
  const preflight = new Response(null, { status: 204, headers: { vary: 'Origin' } });
  eq('cors: a 204 preflight can be constructed', preflight.status, 204);
  if (saved.URL) process.env.URL = saved.URL;
  if (!saved.SITE_URL) delete process.env.SITE_URL;
}

// ===========================================================================
// The HTTP handler
//
// Everything above tests the audit; none of it tested the endpoint in front
// of it. These paths all short-circuit before any network call, so the suite
// stays offline.
// ===========================================================================
{
  const saved = process.env.SITE_URL;
  process.env.SITE_URL = 'https://audit.example.com';

  let n = 0;
  const call = (opts = {}) => handler(
    new Request('http://x/.netlify/functions/audit', {
      method: opts.method || 'POST',
      headers: { 'content-type': 'application/json', ...(opts.origin ? { origin: opts.origin } : {}) },
      body: ['GET', 'HEAD', 'OPTIONS'].includes(opts.method) ? undefined
            : (opts.rawBody ?? JSON.stringify(opts.body ?? { url: 'not a url at all' }))
    }),
    { ip: opts.ip || `handler-test-${n++}` }
  );

  {
    const res = await call({ method: 'OPTIONS', origin: 'https://audit.example.com' });
    eq('handler: preflight returns 204', res.status, 204);
    eq('handler: preflight echoes the origin', res.headers.get('access-control-allow-origin'), 'https://audit.example.com');
    eq('handler: preflight carries no body', await res.text(), '');
  }

  {
    const res = await call({ origin: 'https://someone-else.example' });
    eq('handler: a foreign origin is refused', res.status, 403);
    eq('handler: and gets no CORS header', res.headers.get('access-control-allow-origin'), null);
  }

  {
    const res = await call({ method: 'GET' });
    eq('handler: GET is rejected', res.status, 405);
  }

  {
    const res = await call({ rawBody: '{not json' });
    const body = await res.json();
    eq('handler: a malformed body is a 400', res.status, 400);
    eq('handler: and names the problem', body.error.code, 'invalid_url');
  }

  {
    const res = await call({ body: {} });
    const body = await res.json();
    eq('handler: a missing url is a 400', res.status, 400);
    eq('handler: with an ok:false envelope', body.ok, false);
  }

  {
    const res = await call({ body: { url: 'http://127.0.0.1/admin' } });
    const body = await res.json();
    eq('handler: a private address is refused', body.ok, false);
    ok('handler: without revealing why it is special',
      body.error.code === 'invalid_url' || body.error.code === 'blocked_host', body.error.code);
  }

  {
    // Same caller every time - the limiter should stop it.
    const ip = 'handler-hammer';
    const statuses = [];
    for (let i = 0; i < RATE_LIMIT.requests + 2; i += 1) statuses.push((await call({ ip })).status);
    ok('handler: the limiter eventually returns 429', statuses.includes(429), statuses.join(','));
    const last = await call({ ip });
    eq('handler: a limited response says when to retry', last.headers.get('retry-after'), String(Math.ceil(RATE_LIMIT.window_ms / 1000)));
  }

  {
    eq('handler: no cross-origin caching of a varying response',
      (await call({ ip: 'vary-test' })).headers.get('vary'), 'Origin');
    eq('handler: responses are never cached',
      (await call({ ip: 'cache-test' })).headers.get('cache-control'), 'no-store');
  }

  if (saved === undefined) delete process.env.SITE_URL; else process.env.SITE_URL = saved;
}

// ===========================================================================
// The unlock key
// ===========================================================================
{
  const saved = process.env.AUDIT_UNLOCK_KEY;

  delete process.env.AUDIT_UNLOCK_KEY;
  eq('unlock: with no key configured, nothing unlocks', isUnlocked('anything'), false);
  eq('unlock: not even an empty key', isUnlocked(''), false);

  process.env.AUDIT_UNLOCK_KEY = 'a-long-random-string';
  eq('unlock: the right key unlocks', isUnlocked('a-long-random-string'), true);
  eq('unlock: a wrong key does not', isUnlocked('a-long-random-strinh'), false);
  eq('unlock: a prefix does not', isUnlocked('a-long-random-strin'), false);
  eq('unlock: an empty attempt does not', isUnlocked(''), false);
  eq('unlock: a missing attempt does not', isUnlocked(undefined), false);

  if (saved === undefined) delete process.env.AUDIT_UNLOCK_KEY; else process.env.AUDIT_UNLOCK_KEY = saved;
}

// ===========================================================================
// The scanner identifies itself honestly
// ===========================================================================
{
  ok('agent: names the tool', USER_AGENT.startsWith('FlashbackLeadAudit/'));
  ok('agent: does not pretend to be a browser',
    !/Mozilla|Chrome|Safari|WebKit/i.test(USER_AGENT), USER_AGENT);
  ok('agent: never advertises a placeholder domain',
    !/\.example|example\.com|localhost/.test(USER_AGENT), USER_AGENT);

  // The scanner tells every site it touches who it is. It must never do that
  // by publishing a personal inbox into a stranger's server log, where
  // address harvesters read it.
  ok('agent: carries no email address at all', !/@/.test(USER_AGENT), USER_AGENT);

  // With an address to point at, it links there instead - the Googlebot
  // pattern. Re-imported with a cache-buster because the module reads the
  // environment once, at load.
  const savedUrl = process.env.URL;
  process.env.URL = 'https://audit.example.test';
  const withUrl = await import('../src/config.js?case=site-url');
  eq('agent: links to the site when the address is known',
    withUrl.USER_AGENT, 'FlashbackLeadAudit/1.0 (+https://audit.example.test; one page per request)');
  ok('agent: still carries no address when linking', !/@/.test(withUrl.USER_AGENT));

  process.env.AUDIT_CONTACT = 'audit@flashback.test';
  const withContact = await import('../src/config.js?case=contact');
  ok('agent: an explicitly configured contact is honoured',
    withContact.USER_AGENT.includes('contact audit@flashback.test'), withContact.USER_AGENT);

  delete process.env.AUDIT_CONTACT;
  if (savedUrl === undefined) delete process.env.URL; else process.env.URL = savedUrl;
}

// ===========================================================================
// The lock is server-side
//
// The blur in the browser is cosmetic. These assertions are the actual lock:
// the copy behind it must not be in the payload at all. A test that only
// checked a flag would pass while the text sat in the JSON.
// ===========================================================================
function reportFor(file, opts = {}) {
  const { confidence, scored } = auditFixture(file, opts);
  return buildReport({
    requestedUrl: 'https://example.test/',
    fetched: { finalUrl: 'https://example.test/', redirected: false, status: 200,
               elapsedMs: 800, truncated: false, html: 'x'.repeat(1000) },
    confidence,
    scored
  });
}

{
  const full = reportFor('plain-html.html');
  const locked = redactLocked(reportFor('plain-html.html'), ['costs', 'fixes']);

  ok('lock: the full report has costs', full.checks.some((c) => c.cost));
  ok('lock: the full report has fixes', full.fixList.some((f) => f.fix));

  eq('lock: no check carries a cost once redacted', locked.checks.some((c) => c.cost), false);
  eq('lock: no fix survives redaction', locked.fixList.some((f) => f.fix), false);
  eq('lock: the locked list is declared', JSON.stringify(locked.locked), '["costs","fixes"]');

  // The whole serialised payload, not just the fields we remembered to null.
  const wire = JSON.stringify(locked);
  const leakedFixes = Object.values(FIXES).filter((text) => wire.includes(text));
  ok('lock: no fix instruction appears anywhere in the payload', leakedFixes.length === 0,
    leakedFixes.slice(0, 2).join(' | '));

  // Every cost string except the one deliberately used as the public teaser.
  const teaser = locked.worstFailure ? locked.worstFailure.cost : null;
  const leakedCosts = CHECKS.map((c) => c.cost).filter((text) => text !== teaser && wire.includes(text));
  ok('lock: no costed explanation leaks beyond the teaser', leakedCosts.length === 0,
    leakedCosts.slice(0, 2).join(' | '));

  // The teaser is meant to survive - it is the ungated headline.
  ok('lock: the worst failure keeps its cost as the teaser', Boolean(teaser));

  // Sections 1-3 must still name every issue, or the product is pointless.
  eq('lock: every check still has its label', locked.checks.every((c) => c.label), true);
  eq('lock: every check still has its status', locked.checks.every((c) => c.status), true);
  eq('lock: failures still carry their evidence',
    locked.checks.filter((c) => c.status === 'fail').every((c) => c.evidence), true);
  eq('lock: the fix list keeps its shape for the placeholder',
    locked.fixList.every((f) => f.label && f.points && f.rank), true);
}

{
  // Redaction is driven by config, not hardcoded.
  const onlyFixes = redactLocked(reportFor('plain-html.html'), ['fixes']);
  ok('lock: locking only fixes leaves costs intact', onlyFixes.checks.some((c) => c.cost));
  eq('lock: locking only fixes removes the fixes', onlyFixes.fixList.some((f) => f.fix), false);

  const nothing = redactLocked(reportFor('plain-html.html'), []);
  ok('lock: an empty lock list redacts nothing', nothing.checks.some((c) => c.cost));
  eq('lock: and declares nothing locked', nothing.locked, undefined);
}

{
  // A site with no score still routes to a booking, and has nothing to lock.
  const shell = redactLocked(reportFor('react-shell.html'), GATE.locked_sections);
  eq('lock: an unscoreable report has no fix list to lock', shell.fixList.length, 0);
  eq('lock: and no failures to cost', shell.counts.failed, 0);
}

// ===========================================================================
// THE INVARIANTS
// These are the promise. Every fixture, every time.
// ===========================================================================
const ALL = readdirSync(FIXTURES).filter((f) => f.endsWith('.html') && f !== 'cloudflare-wall.html');

for (const file of ALL) {
  const { confidence, raw, scored } = auditFixture(file);

  // 1. No render-sensitive failure is ever published unless we know we read
  //    the page. This is the false-negative guarantee.
  const leaked = scored.checks.filter(
    (c) => c.status === 'fail' && defById[c.id].renderSensitive && !confidence.canReportFailures
  );
  ok(`INVARIANT no false failures [${file}]`, leaked.length === 0,
    leaked.map((c) => c.id).join(', '));

  // 2. Anything we positively found stays found, at any confidence. A pass is
  //    never downgraded, because how a page renders cannot un-find a thing.
  const lost = Object.entries(raw).filter(
    ([id, r]) => r.status === 'pass' && byId(scored, id).status !== 'pass'
  );
  ok(`INVARIANT passes survive [${file}]`, lost.length === 0, lost.map(([id]) => id).join(', '));

  // 3. A published score is never built on less than the minimum evidence.
  ok(`INVARIANT score only when verified [${file}]`,
    !scored.scoreable || scored.verifiablePoints >= 60,
    `scoreable ${scored.scoreable} on ${scored.verifiablePoints} points`);

  // 4. A suppressed failure carries no leftover failure text. The sentence we
  //    decided we were not entitled to say must not survive anywhere on the
  //    object for a renderer to find and print.
  const leaky = scored.checks.filter(
    (c) => c.status === 'unknown' && c.unknownReason === 'render' && (c.evidence || c.cost || c.fix)
  );
  ok(`INVARIANT unknowns carry no failure text [${file}]`, leaky.length === 0,
    leaky.map((c) => `${c.id}: ${c.evidence}`).join(', '));

  // 5. Every check ends in exactly one of the three states, with copy to show.
  const malformed = scored.checks.filter(
    (c) => !['pass', 'fail', 'unknown'].includes(c.status) || !c.message
  );
  ok(`INVARIANT every check resolves [${file}]`, malformed.length === 0,
    malformed.map((c) => c.id).join(', '));
}

// ===========================================================================
console.log('');
if (failures.length) {
  console.log(`${passed} passed, ${failures.length} FAILED\n`);
  for (const f of failures) console.log('  FAIL  ' + f);
  console.log('');
  process.exit(1);
}
console.log(`${passed} assertions passed.\n`);
