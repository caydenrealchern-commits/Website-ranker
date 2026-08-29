/**
 * Audit a real site from the command line.
 *
 *   node test/cli.js acme.com
 *   node test/cli.js acme.com --json
 *   node test/cli.js --list test/real-sites.txt
 *
 * This is the tool for build step 4 - the step the spec says the actual
 * quality comes from. Read the output next to the real page and disagree with
 * it out loud; every disagreement is either a check to tune or a bug.
 */

import { readFileSync } from 'node:fs';
import { auditUrl, errorResponse } from '../src/audit.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const listFlag = args.indexOf('--list');

const targets = listFlag >= 0
  ? readFileSync(args[listFlag + 1], 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  : args.filter((a) => !a.startsWith('--'));

if (!targets.length) {
  console.error('usage: node test/cli.js <url> [--json]   |   node test/cli.js --list <file>');
  process.exit(2);
}

const SYMBOL = { pass: '  OK ', fail: ' FAIL', unknown: '  ?  ' };

function printReport(r) {
  const line = '-'.repeat(74);
  console.log('\n' + line);
  console.log(r.url.audited);
  if (r.url.redirected) console.log(`  (redirected from ${r.url.requested})`);
  console.log(line);

  if (r.scoreable) {
    console.log(`SCORE  ${r.score}/100   ${r.band}`);
  } else {
    console.log('SCORE  withheld - not enough of this site could be read');
  }
  console.log(`CONF   ${r.confidence.level} (${r.confidence.value}/100)  ${r.confidence.platforms.join(', ') || 'no platform detected'}`);
  console.log(`       ${r.confidence.reason}`);
  console.log(`POINTS earned ${r.points.earned} / verifiable ${r.points.verifiable} / unverified ${r.points.unverified}`);
  console.log(`META   ${r.meta.status}, ${r.meta.elapsedMs}ms, ${(r.meta.bytes / 1024).toFixed(0)}kb${r.meta.truncated ? ', TRUNCATED' : ''}`);
  console.log(`       text ${r.confidence.metrics.textLength} chars, ${r.confidence.metrics.meaningfulLinks} links, ${r.confidence.metrics.scriptCount} scripts`);
  console.log('');

  let group = null;
  for (const c of r.checks) {
    if (c.group !== group) {
      group = c.group;
      console.log(`  ${c.groupLabel}`);
    }
    const via = c.via ? ` [${c.via}]` : '';
    console.log(`   ${SYMBOL[c.status]} ${String(c.points).padStart(2)}  ${c.label}`);
    console.log(`          ${c.status === 'unknown' ? c.message : (c.evidence || c.message)}${via}`);
  }

  if (r.fixList.length) {
    console.log('\n  Fix in this order:');
    for (const f of r.fixList) console.log(`   ${f.rank}. (${f.points} pts) ${f.label}`);
  }
  console.log('');
}

let exitCode = 0;
for (const target of targets) {
  try {
    // Local tool, run by the owner - always the full report.
    const result = await auditUrl(target, { unlocked: true });
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else printReport(result);
  } catch (err) {
    const body = errorResponse(err);
    if (asJson) {
      console.log(JSON.stringify({ target, ...body }, null, 2));
    } else {
      console.log(`\n${'-'.repeat(74)}\n${target}\n${'-'.repeat(74)}`);
      console.log(`ERROR  ${body.error.code}: ${body.error.title}`);
      console.log(`       ${body.error.message}`);
      console.log(`       manual review offered: ${body.error.manualReview}\n`);
    }
    exitCode = 1;
  }
}
process.exit(exitCode);
