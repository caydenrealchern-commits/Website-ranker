/**
 * Section 5. This module decides whether the audit is allowed to call
 * something a failure.
 *
 * THE PROBLEM
 * A plain fetch of a client-rendered site returns an empty shell. Run the
 * checks over it naively and every one of them fails, so the tool tells an
 * owner their site has no phone number when the number is right there on the
 * page. One report like that and nothing else the tool says is believed.
 *
 * THE ASYMMETRY THAT SOLVES IT
 * Findings are not equally trustworthy in both directions:
 *
 *   A PASS is always safe.   We found a tel: link. It is there. How the page
 *                            renders cannot make a thing we found stop existing.
 *   A FAIL is conditional.   We did not find a tel: link. That means "there is
 *                            no tel: link" only if we are confident we saw the
 *                            real page.
 *
 * So confidence is not a global switch that turns the report off. It is a
 * qualifier on negative findings only. When confidence is low, failures on
 * render-sensitive checks become `unknown` - reported as unverified, never as
 * a fault, and excluded from the score's denominator. Everything we positively
 * found is still reported, because it is still true.
 *
 * WHAT IS NOT A SIGNAL
 * The presence of a framework marker. Next.js, Wix, Squarespace and Webflow
 * all server-render most of the time. Treating `__NEXT_DATA__` as proof of a
 * shell would put a low-confidence label on thousands of perfectly readable
 * sites - the mirror of the bug we are trying to avoid. Markers only name the
 * platform, and only explain a shell we have already detected by other means.
 *
 * WHAT IS A SIGNAL
 * Evidence about the response itself: how much human-readable text came back,
 * how many real links, whether a known mount point came back empty, whether
 * the page ships the "you need to enable JavaScript" noscript block.
 */

import { SPA_MARKERS } from './config.js';

/** Confidence at or above this may report render-sensitive failures as facts. */
const HIGH_THRESHOLD = 70;
/** Below this, too little was verified to publish a score at all. */
const LOW_THRESHOLD = 40;

/** Mount points whose emptiness is the single strongest shell signal. */
const MOUNT_SELECTORS = ['#root', '#app', '#__next', '#__nuxt', '#q-app', 'app-root', '[data-reactroot]'];

const CSR_NOSCRIPT = [
  'you need to enable javascript',
  'enable javascript to run this app',
  'please enable javascript',
  'javascript is required',
  'this site requires javascript',
  "we're sorry but",
  'doesn’t work properly without javascript'
];

function scale(value, floor, ceiling, maxPoints) {
  if (value <= floor) return 0;
  if (value >= ceiling) return maxPoints;
  return Math.round(((value - floor) / (ceiling - floor)) * maxPoints);
}

function detectPlatforms(lowerRaw) {
  const found = [];
  for (const marker of SPA_MARKERS) {
    if (marker.match.some((m) => lowerRaw.includes(m.toLowerCase()))) found.push(marker.name);
  }
  return found;
}

export function assessConfidence(doc, fetchMeta = {}) {
  const { $, raw, lowerRaw, visibleText, anchors, scriptSrcs, inlineScripts } = doc;
  const signals = [];
  const add = (name, delta, detail) => signals.push({ name, delta, detail });

  // ---------------------------------------------------------------------------
  // Evidence FOR the page having arrived intact.
  // ---------------------------------------------------------------------------
  const textLength = visibleText.length;
  const meaningfulLinks = anchors.filter(
    (a) => a.href && !a.href.startsWith('#') && !/^javascript:/i.test(a.href)
  ).length;

  let headings = 0;
  $('h1, h2, h3').each((_, el) => {
    if (($(el).text() || '').trim().length > 2) headings += 1;
  });

  let landmarks = 0;
  for (const sel of ['header', 'nav', 'main', 'footer', 'section', 'article']) {
    $(sel).each((_, el) => {
      if (($(el).text() || '').replace(/\s+/g, ' ').trim().length > 40) landmarks += 1;
    });
  }

  const title = ($('title').first().text() || '').trim();
  const description = ($('meta[name="description"]').attr('content') || '').trim();

  const textPoints = scale(textLength, 120, 2500, 45);
  const linkPoints = scale(meaningfulLinks, 1, 20, 25);
  const structPoints = Math.min(20, scale(headings, 0, 6, 12) + scale(landmarks, 0, 4, 8));
  const metaPoints = (title ? 6 : 0) + (description ? 4 : 0);

  add('rendered_text', textPoints, `${textLength} characters of readable text`);
  add('links', linkPoints, `${meaningfulLinks} real links`);
  add('structure', structPoints, `${headings} headings, ${landmarks} content regions`);
  add('page_meta', metaPoints, title ? 'title present' : 'no title');

  let score = textPoints + linkPoints + structPoints + metaPoints;

  // ---------------------------------------------------------------------------
  // Evidence AGAINST - each one is about the response, never about the framework.
  // ---------------------------------------------------------------------------
  const shellReasons = [];

  // An empty mount node is close to proof. A populated one is proof of the
  // opposite, which is why we test the contents and not the selector.
  let emptyMount = null;
  let populatedMount = false;
  for (const sel of MOUNT_SELECTORS) {
    const $node = $(sel).first();
    if (!$node.length) continue;
    const inner = ($node.html() || '').trim();
    if (inner.length < 200) {
      emptyMount = sel;
    } else {
      populatedMount = true;
    }
  }
  if (emptyMount && !populatedMount) {
    score -= 35;
    shellReasons.push(`its main content container (${emptyMount}) arrived empty`);
    add('empty_mount', -35, `${emptyMount} came back empty`);
  } else if (populatedMount) {
    add('populated_mount', 0, 'app container arrived with content in it');
  }

  const noscriptText = $('noscript').text().toLowerCase();
  if (CSR_NOSCRIPT.some((phrase) => noscriptText.includes(phrase))) {
    score -= 25;
    shellReasons.push('the page itself says it needs JavaScript to display');
    add('csr_noscript', -25, 'noscript block asks for JavaScript to be enabled');
  }

  const scriptBytes = inlineScripts.reduce((n, s) => n + s.length, 0) + scriptSrcs.join('').length;
  const scriptRatio = raw.length ? scriptBytes / raw.length : 0;
  if (scriptRatio > 0.6 && textLength < 1200) {
    score -= 15;
    shellReasons.push('almost all of what the server sent was script rather than content');
    add('script_dominance', -15, `${Math.round(scriptRatio * 100)}% of the response was script`);
  }

  if (fetchMeta.truncated) {
    score -= 20;
    shellReasons.push('the page was still loading when our time limit ran out');
    add('truncated', -20, 'response cut short at the time limit');
  }

  // ---------------------------------------------------------------------------
  // The rescue: a small, honest, static page.
  //
  // A one-page brochure site can have 300 characters of text and still be
  // completely readable - there is simply nothing more to see. Without this,
  // the thin-text penalty would wrongly withhold a score from exactly the kind
  // of site this tool exists to help. If nothing suggests a shell and the page
  // barely uses script, we saw everything there was to see.
  // ---------------------------------------------------------------------------
  const scriptCount = scriptSrcs.length + inlineScripts.length;
  const simpleStaticPage =
    shellReasons.length === 0 && scriptCount <= 6 && raw.length < 120000 && textLength > 80;
  if (simpleStaticPage && score < HIGH_THRESHOLD) {
    add('simple_static_page', HIGH_THRESHOLD - score, 'small static page with little script - nothing hidden behind rendering');
    score = HIGH_THRESHOLD;
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const level = score >= HIGH_THRESHOLD ? 'high' : score >= LOW_THRESHOLD ? 'medium' : 'low';

  // Only high confidence earns the right to state a negative as a fact.
  const canReportFailures = level === 'high';

  const platforms = detectPlatforms(lowerRaw);

  let reason;
  if (canReportFailures) {
    reason = 'We read the full page as a visitor would see it.';
  } else if (shellReasons.length) {
    const builtOn = platforms.length ? `This site is built on ${platforms[0]} and b` : 'This site b';
    reason = `${builtOn}uilds its content in the browser rather than sending it ready-made - ${shellReasons[0]}. ` +
      'We can confirm what we did find, but we cannot say that anything is missing.';
  } else {
    reason = 'The page returned very little we could read, so we can confirm what we found but cannot say anything is missing.';
  }

  return {
    level,
    score,
    canReportFailures,
    platforms,
    shellReasons,
    reason,
    signals,
    metrics: {
      textLength,
      meaningfulLinks,
      headings,
      landmarks,
      scriptCount,
      scriptRatio: Math.round(scriptRatio * 100) / 100,
      truncated: Boolean(fetchMeta.truncated)
    }
  };
}

export { HIGH_THRESHOLD, LOW_THRESHOLD };
