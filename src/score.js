/**
 * Applies the section 5 rule to raw check results, then scores what is left.
 *
 * This is the only place in the codebase allowed to turn a `fail` into an
 * `unknown`. Keeping that in one function is what makes the guarantee
 * testable: no render-sensitive failure is ever published as a fact unless
 * confidence.canReportFailures is true.
 */

import { CHECKS, BANDS, FIXES, GROUPS, TOTAL_POINTS } from './config.js';

/**
 * Below this many verifiable points the report would be more gap than
 * finding, so we withhold the score and route to a manual review instead of
 * publishing a number built on a third of the evidence.
 */
export const MIN_SCOREABLE_POINTS = 60;

const UNKNOWN_COPY = {
  render:
    'We could not verify this. This site builds its content in the browser, so a plain read of the page cannot tell us whether it is there.',
  dependency:
    'We could not verify this, because the check it depends on could not be verified either.',
  embedded:
    'We could not verify this from outside the third-party embed it lives in.'
};

export function bandFor(score) {
  return BANDS.find((b) => score >= b.min) || BANDS[BANDS.length - 1];
}

export function scoreAudit(rawResults, confidence) {
  const byId = {};

  // --- pass 1: apply the confidence rule to each check independently ---------
  for (const def of CHECKS) {
    const raw = rawResults[def.id] || { status: 'unknown', evidence: 'check did not run' };
    let { status, via, evidence } = raw;
    let unknownReason = null;
    // A check may override its own failure sentence when one fixed string
    // would misdescribe what was actually found.
    let failMessage = raw.failMessage || null;
    let failCost = raw.failCost || null;

    if (status === 'unknown') {
      unknownReason = raw.unknownReason || 'embedded';
    } else if (status === 'fail' && def.renderSensitive && !confidence.canReportFailures) {
      // The rule. A negative finding is only a fact when we know we saw the
      // page. Everything that passed above stays passed - a thing we found
      // cannot be un-found by how the page renders.
      status = 'unknown';
      unknownReason = 'render';
      // Drop the evidence with it. "No click-to-call link found" is the exact
      // sentence we have decided we are not entitled to say, and leaving it on
      // the object invites a renderer to print it next to the unknown marker.
      evidence = null;
      failMessage = null;
      failCost = null;
    }

    byId[def.id] = { def, status, via: via || null, evidence: evidence || '', unknownReason, failMessage, failCost };
  }

  // --- pass 2: dependencies -------------------------------------------------
  for (const def of CHECKS) {
    if (!def.dependsOn) continue;
    const parent = byId[def.dependsOn];
    const self = byId[def.id];
    if (!parent) continue;

    if (parent.status === 'unknown' && self.status !== 'pass') {
      self.status = 'unknown';
      self.unknownReason = self.unknownReason || 'dependency';
    } else if (parent.status === 'fail' && self.status === 'fail' && def.failNoDependency) {
      self.dependencyFailed = true;
    }
  }

  // --- pass 3: arithmetic ---------------------------------------------------
  let earned = 0;
  let verifiable = 0;
  const checks = [];

  for (const def of CHECKS) {
    const r = byId[def.id];
    if (r.status !== 'unknown') verifiable += def.points;
    if (r.status === 'pass') earned += def.points;

    checks.push({
      id: def.id,
      group: def.group,
      groupLabel: GROUPS[def.group].label,
      label: def.label,
      points: def.points,
      status: r.status,
      via: r.via,
      evidence: r.evidence,
      // What the visitor reads on each row.
      message:
        r.status === 'pass' ? def.pass
        : r.status === 'fail' ? (
            r.dependencyFailed && def.failNoDependency ? def.failNoDependency
            : r.failMessage || def.fail
          )
        : UNKNOWN_COPY[r.unknownReason] || UNKNOWN_COPY.render,
      cost: r.status === 'fail' ? (r.failCost || def.cost) : null,
      fix: r.status === 'fail' ? FIXES[def.id] : null,
      unknownReason: r.unknownReason
    });
  }

  const unverifiedPoints = TOTAL_POINTS - verifiable;
  const scoreable = verifiable >= MIN_SCOREABLE_POINTS;
  const score = scoreable ? Math.round((earned / verifiable) * 100) : null;
  const band = scoreable ? bandFor(score) : null;

  const failed = checks
    .filter((c) => c.status === 'fail')
    .sort((a, b) => b.points - a.points);
  const unknown = checks.filter((c) => c.status === 'unknown');
  const passed = checks.filter((c) => c.status === 'pass');

  const groups = Object.entries(GROUPS).map(([id, g]) => {
    const rows = checks.filter((c) => c.group === id);
    const groupVerifiable = rows.filter((c) => c.status !== 'unknown').reduce((n, c) => n + c.points, 0);
    const groupEarned = rows.filter((c) => c.status === 'pass').reduce((n, c) => n + c.points, 0);
    return {
      id,
      label: g.label,
      points: g.points,
      earned: groupEarned,
      verifiable: groupVerifiable,
      unverified: g.points - groupVerifiable
    };
  });

  return {
    score,
    band: band ? band.label : null,
    bandMessage: band ? band.message : null,
    scoreable,
    earnedPoints: earned,
    verifiablePoints: verifiable,
    unverifiedPoints,
    totalPoints: TOTAL_POINTS,
    // The ungated view shows only this one, plus the count of the rest.
    worstFailure: failed[0] || null,
    remainingIssueCount: Math.max(0, failed.length - 1),
    counts: { passed: passed.length, failed: failed.length, unknown: unknown.length },
    checks,
    fixList: failed.map((c, i) => ({
      rank: i + 1,
      id: c.id,
      label: c.label,
      points: c.points,
      cost: c.cost,
      fix: c.fix
    })),
    groups
  };
}
