#!/usr/bin/env node
/**
 * Records the outcome of a pipeline stage that is executed by the workflow
 * itself (build, test, deployment) so the final report can aggregate every
 * stage from one place.
 *
 * The status must be supplied by the caller from the REAL step outcome
 * (`${{ steps.x.outcome }}` / `${{ job.status }}`) — this script does not
 * guess, and it maps anything that is not an explicit success to FAIL.
 *
 * Usage:
 *   node scripts/ci/record-stage.mjs --stage build --title Build --status success --detail "tsc --noEmit" --out artifacts/build.json
 */

import { StageReport, parseArgs, PASS, FAIL, NOT_AUTOMATED, SKIPPED } from './lib.mjs';

const args = parseArgs();
const stage = String(args.stage ?? '');
if (!stage) {
  console.error('--stage is required');
  process.exit(2);
}

const raw = String(args.status ?? '').toLowerCase();
const status =
  raw === 'success' || raw === 'pass' || raw === 'passed'
    ? PASS
    : raw === 'skipped' || raw === 'skip'
      ? SKIPPED
      : raw === 'not_automated' || raw === 'not-automated'
        ? NOT_AUTOMATED
        : FAIL;

const report = new StageReport(stage, String(args.title ?? stage));
report.note(String(args.check ?? args.title ?? stage), status, String(args.detail ?? ''));

for (const extra of [].concat(args.also ?? [])) {
  if (typeof extra === 'string' && extra.includes('=')) {
    const [name, value] = extra.split('=');
    report.note(name, value.toUpperCase(), '');
  }
}

const payload = report.toJSON();
if (args.out) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`);
}
console.log(`${stage}: ${payload.status}`);
/* Recording a result must not itself fail the job — the gate that produced the
 * failure already failed. The final report is what enforces the overall status. */
