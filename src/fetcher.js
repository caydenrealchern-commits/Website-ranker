/**
 * URL normalisation, validation and a single, well-behaved page fetch.
 *
 * Build sequence step 1. Everything downstream assumes this module either
 * hands back HTML with timing metadata, or throws an AuditError carrying a
 * code the front end knows how to explain.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { FETCH } from './config.js';

export class AuditError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Accepts what a business owner actually types: "acme.com", "ACME.com/",
 * "www.acme.com ", "https://acme.com?utm_source=x".
 */
export function normaliseUrl(input) {
  if (typeof input !== 'string') {
    throw new AuditError('invalid_url', 'Enter a website address.');
  }

  let raw = input.trim();
  if (!raw) throw new AuditError('invalid_url', 'Enter a website address.');
  if (raw.length > 2000) throw new AuditError('invalid_url', 'That address is too long.');

  // Reject anything that is clearly not a web address before we guess a scheme.
  if (/^(javascript|data|file|ftp|mailto|tel):/i.test(raw)) {
    throw new AuditError('invalid_url', 'That is not a website address.');
  }
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AuditError('invalid_url', 'That does not look like a website address.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AuditError('invalid_url', 'Only http and https addresses can be audited.');
  }
  if (url.username || url.password) {
    throw new AuditError('invalid_url', 'Remove the username and password from the address.');
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    throw new AuditError('invalid_url', 'Only standard web ports can be audited.');
  }

  const host = url.hostname.toLowerCase();
  // A hostname with no dot is either a local machine name or a typo.
  if (!host.includes('.') || host.endsWith('.')) {
    throw new AuditError('invalid_url', 'That does not look like a full domain name.');
  }
  if (!/^[a-z0-9.-]+$/.test(host) && !host.startsWith('xn--')) {
    try {
      url.hostname = new URL('https://' + host).hostname; // punycode via WHATWG URL
    } catch {
      throw new AuditError('invalid_url', 'That domain name is not valid.');
    }
  }
  if (/^[0-9.]+$/.test(host) || net.isIP(host)) {
    throw new AuditError('invalid_url', 'Enter a domain name rather than an IP address.');
  }

  url.hash = '';
  return url.toString();
}

/** True for addresses no public tool should be pointed at. */
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||            // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||  // CGNAT
      a >= 224                                // multicast / reserved
    );
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    // IPv4-mapped, e.g. ::ffff:127.0.0.1
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return true;
}

/**
 * Resolves the host and refuses anything on the internal network. Runs on
 * every redirect hop, not just the first, because a redirect is the obvious
 * way to smuggle a public-looking URL onto a private address.
 */
async function assertPublicHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.home.arpa')) {
    throw new AuditError('blocked_host', 'That address is not a public website.');
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true });
  } catch (err) {
    if (err && (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' || err.code === 'ENODATA')) {
      throw new AuditError('dns', "We couldn't reach that address. Check the spelling and try again.");
    }
    throw new AuditError('dns', "We couldn't reach that address.");
  }

  if (!records.length) {
    throw new AuditError('dns', "We couldn't reach that address.");
  }
  if (records.some((r) => isPrivateAddress(r.address))) {
    throw new AuditError('blocked_host', 'That address resolves to a private network.');
  }
}

export function looksLikeBotWall(status, html) {
  if (status === 403 || status === 401 || status === 429 || status === 503) return true;
  const probe = (html || '').slice(0, 4000).toLowerCase();
  return (
    probe.includes('just a moment') ||
    probe.includes('checking your browser') ||
    probe.includes('cf-browser-verification') ||
    probe.includes('cf_chl_opt') ||
    probe.includes('enable javascript and cookies to continue') ||
    probe.includes('access denied') ||
    probe.includes('attention required! | cloudflare') ||
    probe.includes('request unsuccessful. incapsula') ||
    probe.includes('_incapsula_resource') ||
    probe.includes('perimeterx') ||
    probe.includes('are you a robot')
  );
}

/**
 * Reads the body with a hard deadline. If the deadline hits after some bytes
 * have arrived we keep them and flag the result truncated, so a slow site
 * still yields a partial report instead of nothing (section 5).
 */
async function readWithDeadline(response, deadlineAt) {
  const reader = response.body?.getReader();
  if (!reader) return { text: await response.text(), truncated: false };

  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) { truncated = true; break; }

      const step = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), remaining))
      ]);

      if (step.timedOut) { truncated = true; break; }
      if (step.done) break;

      bytes += step.value.byteLength;
      text += decoder.decode(step.value, { stream: true });
      if (bytes > FETCH.max_bytes) { truncated = true; break; }
    }
    text += decoder.decode();
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }

  return { text, truncated };
}

/**
 * Fetches one page. One page only - no crawling, ever (section 6).
 * Returns { html, finalUrl, status, elapsedMs, truncated, redirected, contentType }.
 */
export async function fetchPage(startUrl, opts = {}) {
  const timeout = opts.timeoutMs ?? FETCH.timeout_ms;
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeout;

  let current = startUrl;
  let redirects = 0;
  let response;

  for (;;) {
    const target = new URL(current);
    await assertPublicHost(target.hostname);

    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw new AuditError('timeout', 'That site took too long to respond.', { elapsedMs: Date.now() - startedAt });
    }

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), remaining);

    try {
      response = await fetch(target.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': FETCH.user_agent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-GB,en;q=0.9'
        }
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new AuditError('timeout', 'That site took too long to respond.', { elapsedMs: Date.now() - startedAt });
      }
      if (err instanceof AuditError) throw err;
      const cause = err?.cause?.code || err?.code || '';
      if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
        throw new AuditError('dns', "We couldn't reach that address. Check the spelling and try again.");
      }
      if (String(cause).startsWith('ERR_TLS') || String(cause).includes('CERT')) {
        throw new AuditError('tls', "That site's security certificate could not be verified.");
      }
      throw new AuditError('network', "We couldn't connect to that site.");
    } finally {
      clearTimeout(abortTimer);
    }

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      if (++redirects > FETCH.max_redirects) {
        throw new AuditError('too_many_redirects', 'That address redirects in a loop.');
      }
      try {
        current = new URL(location, target).toString();
      } catch {
        throw new AuditError('network', 'That site sent an invalid redirect.');
      }
      try { await response.body?.cancel(); } catch { /* nothing buffered */ }
      continue;
    }
    break;
  }

  const finalUrl = response.url || current;
  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  if (contentType && !/(text\/html|application\/xhtml|text\/plain|^$)/.test(contentType)) {
    try { await response.body?.cancel(); } catch { /* nothing buffered */ }
    throw new AuditError('not_html', 'That address is not a web page we can read.', { contentType });
  }

  const { text: html, truncated } = await readWithDeadline(response, deadlineAt);
  const elapsedMs = Date.now() - startedAt;

  if (looksLikeBotWall(response.status, html)) {
    throw new AuditError('blocked', 'That site blocks automated access, so we cannot read it.', {
      status: response.status, finalUrl
    });
  }
  if (response.status >= 400) {
    throw new AuditError('http_error', `That page returned an error (${response.status}).`, {
      status: response.status, finalUrl
    });
  }
  if (!html || html.trim().length < 200) {
    if (truncated) {
      throw new AuditError('timeout', 'That site took too long to send its page.', { elapsedMs });
    }
    throw new AuditError('empty', 'That page came back empty.', { finalUrl });
  }
  if (!/<html|<body|<head|<div|<meta/i.test(html)) {
    throw new AuditError('not_html', 'That address is not a web page we can read.', { contentType });
  }

  return {
    html,
    finalUrl,
    requestedUrl: startUrl,
    redirected: new URL(finalUrl).hostname !== new URL(startUrl).hostname,
    status: response.status,
    contentType,
    elapsedMs,
    truncated
  };
}
