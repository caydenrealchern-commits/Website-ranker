/**
 * Turns raw HTML into the single document view that confidence.js and
 * checks.js both read from.
 *
 * The important part is that it looks in three places, not one:
 *   1. the rendered DOM        - what a plain fetch can see
 *   2. structured data         - JSON-LD, microdata, meta tags
 *   3. embedded state          - __NEXT_DATA__, Wix warmup, inline JSON
 *
 * A client-rendered site usually still ships its phone number, address and
 * booking link inside (2) and (3). Mining those is what stops the audit from
 * telling an owner their site has no phone number when it plainly does.
 */

import * as cheerio from 'cheerio';

const MAX_EMBEDDED_CHARS = 600000;

const STRIP_TAGS = 'script, style, noscript, template, svg, iframe, head';

/** Candidate phone shapes, filtered hard afterwards. */
const PHONE_CANDIDATE = /[+(]?\d[\d\s().\-‐-―]{7,20}\d/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;
const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;
const US_CITY_STATE_ZIP = /\b[A-Za-z.'-]+,\s*(?:A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])\s+\d{5}(?:-\d{4})?\b/;
const STREET_RE = /\b\d{1,6}[A-Za-z]?[,\s]+(?:[A-Za-z0-9.'’-]+[\s,]+){0,4}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd|highway|hwy|parkway|pkwy|way|court|ct|place|pl|square|sq|terrace|crescent|close|parade|gardens|walk|row|circle|cir|trail|suite|ste|unit)\b\.?/i;
const AU_NZ_STATE = /\b(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}\b/;

const CONTACT_WORDS = ['contact', 'contact us', 'get in touch', 'enquiries', 'enquiry', 'inquiries', 'reach us', 'find us', 'talk to us', 'kontakt'];

/**
 * Rejects everything that merely looks numeric. The set that matters most is
 * SVG path data - `223.052 24.12` reads as a phone number to a loose regex,
 * and one of those is enough to tell an owner their phone number is not
 * clickable when they never had one on the page at all.
 */
function isPlausiblePhone(candidate) {
  const raw = candidate.trim();
  const digits = raw.replace(/\D/g, '');

  if (digits.length < 9 || digits.length > 15) return false;
  if (/^0+$/.test(digits)) return false;
  if (/^(\d)\1+$/.test(digits)) return false;            // 000000000, 111111111
  if (/^(?:19|20)\d{2}(?:0[1-9]|1[0-2])/.test(digits) && digits.length <= 10) return false; // dates
  if (/^\d{13,}$/.test(digits) && !raw.startsWith('+')) return false;                       // epoch ms, ids
  if (new Set(digits).size <= 2) return false;

  // Template placeholders. "0123456789" and "1234567890" ship in more themes
  // than anyone would guess, and they have ten distinct digits, so the
  // variety check above waves them straight through.
  const runs = (step) => digits.split('').every((d, i, a) => i === 0 || Number(d) === (Number(a[i - 1]) + step) % 10);
  if (runs(1) || runs(9)) return false;

  // Coordinate and decimal noise: punctuation that is not acting as a
  // separator, or a separator hanging off either end.
  if (/[-+.]\s*[-+.]/.test(raw)) return false;
  if (/^[.\-)]/.test(raw) || /[.\-(+]$/.test(raw)) return false;
  if (raw.indexOf('+') > 0) return false;

  // A written phone number picks one separator and sticks to it: "555.123.4567"
  // or "+44 20 7946 0958", never both. Mixed dots and spaces is coordinate
  // data ("223.052 24.12"), not a number anyone dials.
  if (/\./.test(raw) && /\s/.test(raw)) return false;

  // Group shape. Real numbers break into groups of two to five digits. SVG
  // coordinates and version strings do not. A single-digit group is only ever
  // a country code, and only directly after a leading +.
  const groups = raw.replace(/[()]/g, ' ').split(/[\s.\-‐-―]+/).filter(Boolean);
  if (groups.length > 6) return false;
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i].replace(/\+/g, '');
    if (!/^\d+$/.test(g)) return false;
    if (g.length > 5) {
      if (groups.length > 1) return false;
      continue;
    }
    if (g.length === 1 && !(i === 0 && raw.startsWith('+'))) return false;
  }

  return true;
}

/**
 * Human-readable text from a slice of raw markup. Removes the *contents* of
 * script, style and svg - not just their tags - because that is where the
 * digit soup that fakes a phone number lives.
 *
 * The slice is cut at a character offset, so it routinely ends part-way
 * through a tag or an element. An unterminated `<svg>` leaves its path data
 * exposed as if it were prose, and `M223.052 24.12` is shaped exactly like a
 * phone number. Everything unterminated is therefore dropped to the end of
 * the slice rather than left to be read as text.
 */
function textFromMarkup(markup) {
  return markup
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    // Whatever is left open runs to the end of the slice.
    .replace(/<(?:script|style|svg)\b[\s\S]*$/i, ' ')
    // A tag cut mid-attribute.
    .replace(/<[^>]*$/, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ');
}

function collectPhones(text, into) {
  if (!text) return;
  const matches = text.match(PHONE_CANDIDATE);
  if (!matches) return;
  for (const m of matches) {
    const trimmed = m.trim();
    if (isPlausiblePhone(trimmed)) into.add(trimmed.replace(/\s+/g, ' '));
    if (into.size > 40) return;
  }
}

function collectEmails(text, into) {
  if (!text) return;
  const matches = text.match(EMAIL_RE);
  if (!matches) return;
  for (const m of matches) {
    const lower = m.toLowerCase();
    // Skip the fake addresses that ship inside libraries and placeholder markup.
    if (/(example|sentry|wixpress|\.png|\.jpg|\.svg|\.js|@2x|domain\.com|email\.com|yourdomain)/.test(lower)) continue;
    into.add(lower);
    if (into.size > 20) return;
  }
}

/** A published number is only usable if it has enough digits to dial. */
function usablePhone(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const digits = trimmed.replace(/\D/g, '');
  return digits.length >= 7 && isPlausiblePhone(trimmed.replace(/^tel:/i, '').trim());
}

function hasAddressShape(text) {
  if (!text) return false;
  return UK_POSTCODE.test(text) || US_CITY_STATE_ZIP.test(text) || AU_NZ_STATE.test(text) || STREET_RE.test(text);
}

/** Walks parsed JSON of any shape and pulls every string out of it. */
function flattenStrings(value, out, budget = { chars: 0 }) {
  if (budget.chars > MAX_EMBEDDED_CHARS) return out;
  if (typeof value === 'string') {
    if (value.length < 4000) { out.push(value); budget.chars += value.length; }
    return out;
  }
  if (typeof value === 'number') { out.push(String(value)); return out; }
  if (Array.isArray(value)) {
    for (const item of value) flattenStrings(item, out, budget);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      out.push(key);
      flattenStrings(value[key], out, budget);
    }
  }
  return out;
}

/** Every node in a JSON-LD graph, flattened, whatever nesting it arrived in. */
function jsonLdNodes(parsed, out = []) {
  if (Array.isArray(parsed)) {
    parsed.forEach((n) => jsonLdNodes(n, out));
    return out;
  }
  if (parsed && typeof parsed === 'object') {
    out.push(parsed);
    if (parsed['@graph']) jsonLdNodes(parsed['@graph'], out);
    for (const key of ['contactPoint', 'contactPoints', 'address', 'location', 'potentialAction', 'target', 'subOrganization', 'department', 'makesOffer', 'publisher', 'author', 'provider']) {
      if (parsed[key]) jsonLdNodes(parsed[key], out);
    }
  }
  return out;
}

function textOf(node) {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).filter(Boolean).join(', ');
  if (node && typeof node === 'object') {
    return ['streetAddress', 'addressLocality', 'addressRegion', 'postalCode', 'addressCountry', 'name']
      .map((k) => (typeof node[k] === 'string' ? node[k] : ''))
      .filter(Boolean)
      .join(', ');
  }
  return '';
}

export function parseDocument(html, finalUrl) {
  const $ = cheerio.load(html, { decodeEntities: true });
  const raw = html;
  const lowerRaw = raw.toLowerCase();

  // --- rendered text ---------------------------------------------------------
  const $body = $('body').length ? $('body').clone() : $.root().clone();
  $body.find(STRIP_TAGS).remove();
  const visibleText = $body.text().replace(/\s+/g, ' ').trim();

  // --- position markers for "header" and "above the fold" --------------------
  const bodyStart = (() => {
    const m = /<body[^>]*>/i.exec(raw);
    return m ? m.index + m[0].length : 0;
  })();
  const bodyLength = Math.max(1, raw.length - bodyStart);

  // --- scripts ---------------------------------------------------------------
  const scriptSrcs = [];
  const inlineScripts = [];
  $('script').each((_, el) => {
    const src = $(el).attr('src');
    if (src) {
      scriptSrcs.push(src);
    } else {
      const body = $(el).html() || '';
      if (body.length < 200000) inlineScripts.push(body);
    }
  });

  // --- structured + embedded data -------------------------------------------
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const body = ($(el).html() || '').trim();
    if (!body || body.length > 400000) return;
    try {
      jsonLd.push(...jsonLdNodes(JSON.parse(body)));
    } catch {
      // Malformed JSON-LD is common; its raw text still gets mined below.
      inlineScripts.push(body);
    }
  });

  const embeddedParts = [];
  for (const node of jsonLd) embeddedParts.push(...flattenStrings(node, []));
  for (const body of inlineScripts) {
    // Inline scripts hold the state blobs (__NEXT_DATA__, warmupData, config).
    // Keep the JSON-looking parts and drop minified logic.
    if (/[{[]/.test(body)) embeddedParts.push(body.slice(0, 200000));
  }
  $('noscript').each((_, el) => embeddedParts.push($(el).text()));
  $('meta').each((_, el) => {
    const content = $(el).attr('content');
    if (content) embeddedParts.push(content);
  });
  $('[itemprop]').each((_, el) => {
    embeddedParts.push($(el).attr('content') || $(el).text() || '');
  });

  let embeddedText = embeddedParts.join('\n');
  if (embeddedText.length > MAX_EMBEDDED_CHARS) embeddedText = embeddedText.slice(0, MAX_EMBEDDED_CHARS);

  // --- normalised contact facts ---------------------------------------------
  const phones = new Set();
  const emails = new Set();
  const addresses = new Set();
  const bookingUrls = new Set();

  for (const node of jsonLd) {
    const type = [].concat(node['@type'] || []).join(' ').toLowerCase();
    // Structured data does not go through the candidate regex, so an empty
    // or junk `telephone` would otherwise land in facts unchecked - and it
    // is facts.phones that decides the wording of the report's headline.
    if (typeof node.telephone === 'string' && usablePhone(node.telephone)) {
      phones.add(node.telephone.trim());
    }
    if (typeof node.email === 'string') emails.add(node.email.replace(/^mailto:/i, '').trim().toLowerCase());
    if (node.address) {
      const a = textOf(node.address);
      if (a) addresses.add(a);
    }
    if (type.includes('postaladdress')) {
      const a = textOf(node);
      if (a) addresses.add(a);
    }
    if (type.includes('reserveaction') || type.includes('scheduleaction') || type.includes('orderaction')) {
      const t = node.target;
      const url = typeof t === 'string' ? t : t && (t.urlTemplate || t.url);
      if (typeof url === 'string') bookingUrls.add(url);
    }
  }

  $('[itemtype*="PostalAddress" i]').each((_, el) => {
    const a = $(el).text().replace(/\s+/g, ' ').trim();
    if (a) addresses.add(a);
  });
  $('[itemprop="telephone"]').each((_, el) => {
    const v = ($(el).attr('content') || $(el).text() || '').trim();
    if (usablePhone(v)) phones.add(v);
  });

  collectPhones(visibleText, phones);
  collectEmails(visibleText, emails);

  // Phones and emails that only exist in the embedded state - kept separate so
  // checks can tell "verified on the page" from "the site clearly has one".
  const embeddedPhones = new Set();
  const embeddedEmails = new Set();
  collectPhones(embeddedText, embeddedPhones);
  collectEmails(embeddedText, embeddedEmails);

  // --- links -----------------------------------------------------------------
  const anchors = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    const text = ($(el).text() || '').replace(/\s+/g, ' ').trim();
    const aria = ($(el).attr('aria-label') || '').trim();
    anchors.push({ href, text, aria, lower: (text + ' ' + aria).toLowerCase() });
  });

  // --- forms -----------------------------------------------------------------
  const forms = [];
  $('form').each((_, el) => {
    const $f = $(el);
    const fields = $f.find('input, textarea, select').filter((__, f) => {
      const type = ($(f).attr('type') || '').toLowerCase();
      return !['hidden', 'submit', 'button', 'image', 'reset'].includes(type);
    });
    const action = ($f.attr('action') || '').toLowerCase();
    const cls = (($f.attr('class') || '') + ' ' + ($f.attr('id') || '') + ' ' + ($f.attr('role') || '')).toLowerCase();
    const isSearch = /search/.test(action) || /search/.test(cls) ||
      $f.find('input[type="search"]').length > 0 ||
      (fields.length === 1 && /search|query|^s$|^q$/.test(($f.find('input').first().attr('name') || '').toLowerCase()));
    forms.push({ fieldCount: fields.length, isSearch, action });
  });

  return {
    $,
    raw,
    lowerRaw,
    finalUrl,
    visibleText,
    visibleTextLower: visibleText.toLowerCase(),
    embeddedText,
    embeddedTextLower: embeddedText.toLowerCase(),
    bodyStart,
    bodyLength,
    scriptSrcs,
    inlineScripts,
    jsonLd,
    anchors,
    forms,
    facts: {
      phones: [...phones],
      emails: [...emails],
      addresses: [...addresses],
      bookingUrls: [...bookingUrls],
      embeddedPhones: [...embeddedPhones],
      embeddedEmails: [...embeddedEmails]
    },
    hasAddressShape,
    CONTACT_WORDS
  };
}

export { hasAddressShape, isPlausiblePhone, usablePhone, textFromMarkup, CONTACT_WORDS };
