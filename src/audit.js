/**
 * Orchestrator. Turns a URL a business owner typed into the report shape the
 * front end renders.
 *
 * The locked sections are removed from the payload here, not hidden in the
 * browser - see redactLocked(). A caller that has not unlocked never receives
 * the copy the blur covers.
 */

import { normaliseUrl, fetchPage, AuditError } from './fetcher.js';
import { parseDocument } from './extract.js';
import { assessConfidence } from './confidence.js';
import { runChecks } from './checks.js';
import { scoreAudit } from './score.js';
import { BRAND, GATE } from './config.js';

/** Errors where a human looking at the site is the sensible next step. */
const MANUAL_REVIEW_CODES = new Set([
  'blocked', 'timeout', 'tls', 'network', 'empty', 'too_many_redirects', 'http_error'
]);

const ERROR_TITLES = {
  invalid_url: 'That address does not look right',
  dns: "We couldn't reach that address",
  blocked_host: 'That address is not a public website',
  blocked: 'That site blocks automated visitors',
  timeout: 'That site took too long to respond',
  tls: 'That site has a certificate problem',
  network: "We couldn't connect to that site",
  not_html: 'That address is not a web page',
  empty: 'That page came back empty',
  http_error: 'That page returned an error',
  too_many_redirects: 'That address redirects in a loop'
};

export function errorResponse(err) {
  const code = err instanceof AuditError ? err.code : 'unexpected';
  const manualReview = MANUAL_REVIEW_CODES.has(code);
  return {
    ok: false,
    error: {
      code,
      title: ERROR_TITLES[code] || 'Something went wrong',
      message: err instanceof AuditError ? err.message : 'Something went wrong running that audit.',
      manualReview,
      // A manual review is a booking, not a report.
      cta: manualReview ? { text: BRAND.cta_text, url: BRAND.cta_url } : null
    }
  };
}

/**
 * Strips the locked sections out of a finished report.
 *
 * The blur in the browser is cosmetic. This is the actual lock: the copy it
 * covers never leaves the server for a visitor who has not unlocked, so
 * opening devtools finds nothing to read.
 *
 * What survives redaction, deliberately:
 *   - every check's label, status, points and evidence. Sections 1-3 name
 *     every issue on the site, and hiding those would defeat the product.
 *   - `worstFailure.cost`. That single sentence is the ungated teaser the
 *     spec asks for, and it is rendered on screen anyway.
 *   - the fix list's labels, points and ranks, so the locked section can be
 *     drawn at the right size without inventing anything.
 */
export function redactLocked(report, lockedSections = []) {
  const locked = new Set(lockedSections);
  if (!locked.size) return report;

  if (locked.has('costs')) {
    report.checks = report.checks.map((c) => ({ ...c, cost: null }));
  }
  if (locked.has('fixes')) {
    report.checks = report.checks.map((c) => ({ ...c, fix: null }));
  }
  report.fixList = report.fixList.map((f) => ({
    ...f,
    cost: locked.has('costs') ? null : f.cost,
    fix: locked.has('fixes') ? null : f.fix
  }));

  report.locked = [...locked];
  return report;
}

/** Builds the full, unredacted report. */
export function buildReport({ requestedUrl, fetched, confidence, scored }) {
  // A report with no score is not a failure - it is the honest outcome for a
  // site we could not read. It routes to a booking rather than a number.
  const manualReview = !scored.scoreable;

  return {
    ok: true,
    url: {
      requested: requestedUrl,
      audited: fetched.finalUrl,
      redirected: fetched.redirected
    },
    score: scored.score,
    band: scored.band,
    bandMessage: scored.bandMessage,
    scoreable: scored.scoreable,
    manualReview,
    headline: buildHeadline(scored, confidence, manualReview),
    confidence: {
      level: confidence.level,
      value: confidence.score,
      canReportFailures: confidence.canReportFailures,
      reason: confidence.reason,
      platforms: confidence.platforms,
      metrics: confidence.metrics
    },
    points: {
      earned: scored.earnedPoints,
      verifiable: scored.verifiablePoints,
      unverified: scored.unverifiedPoints,
      total: scored.totalPoints
    },
    counts: scored.counts,
    worstFailure: scored.worstFailure
      ? {
          id: scored.worstFailure.id,
          label: scored.worstFailure.label,
          points: scored.worstFailure.points,
          message: scored.worstFailure.message,
          cost: scored.worstFailure.cost
        }
      : null,
    remainingIssueCount: scored.remainingIssueCount,
    checks: scored.checks,
    fixList: scored.fixList,
    groups: scored.groups,
    cta: { text: BRAND.cta_text, url: BRAND.cta_url },
    // Which sections the browser should draw as locked. The copy for them is
    // removed from this payload by redactLocked() unless the caller unlocked.
    gate: { enabled: GATE.enabled, lockedSections: GATE.locked_sections },
    meta: {
      status: fetched.status,
      elapsedMs: fetched.elapsedMs,
      truncated: fetched.truncated,
      bytes: fetched.html.length,
      scannedAt: new Date().toISOString()
    }
  };
}

/**
 * Runs an audit. `opts.unlocked` returns the whole report; without it the
 * locked sections are stripped before the payload is returned.
 */
export async function auditUrl(input, opts = {}) {
  const requestedUrl = normaliseUrl(input);
  const fetched = await fetchPage(requestedUrl, opts);
  const doc = parseDocument(fetched.html, fetched.finalUrl);

  const confidence = assessConfidence(doc, fetched);
  const rawResults = runChecks(doc, {
    finalUrl: fetched.finalUrl,
    elapsedMs: fetched.elapsedMs,
    truncated: fetched.truncated
  });
  const scored = scoreAudit(rawResults, confidence);

  const report = buildReport({ requestedUrl, fetched, confidence, scored });
  report.meta.unlocked = Boolean(opts.unlocked);

  if (opts.unlocked || !GATE.enabled) return report;
  return redactLocked(report, GATE.locked_sections);
}

function buildHeadline(scored, confidence, manualReview) {
  if (manualReview) {
    return {
      title: 'We could not read enough of this site to score it',
      detail: confidence.reason,
      verified: scored.counts.passed
    };
  }
  if (!scored.worstFailure) {
    return {
      title: 'Nothing is leaking on this page',
      detail: 'Every check we could run came back clean.',
      verified: scored.counts.passed
    };
  }
  return {
    title: scored.worstFailure.label,
    detail: `${scored.worstFailure.message} ${scored.worstFailure.cost}`,
    verified: scored.counts.passed
  };
}
