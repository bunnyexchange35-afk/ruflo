#!/usr/bin/env node
/**
 * DEPLOYMENT RESULT  (§11, §14)
 *
 * Aggregates every stage report into the single status block the pipeline must
 * publish, and decides the overall outcome.
 *
 * Rules:
 *   - A stage that never ran is reported as SKIPPED / NOT RUN — never PASS.
 *   - "deployed successfully" is only printed when DEPLOYMENT, HEALTH and
 *     DATABASE all passed and nothing else failed.
 *   - NOT_AUTOMATED is surfaced verbatim; it is not silently upgraded to PASS.
 *
 * Usage:
 *   node scripts/ci/report.mjs --dir artifacts --commit $GITHUB_SHA --worker mudrexx-backend --version-id ... --url https://...
 */

import { parseArgs, loadStages, appendSummary, PASS, FAIL, NOT_AUTOMATED, SKIPPED } from './lib.mjs';

const args = parseArgs();
const dir = String(args.dir ?? 'artifacts');
const stages = loadStages(dir);
const byName = new Map(stages.map((s) => [s.stage, s]));

/** The canonical, ordered pipeline. */
const ORDER = [
  ['build', 'BUILD'],
  ['test', 'TEST'],
  ['config', 'CONFIG'],
  ['database', 'DATABASE'],
  ['deployment', 'DEPLOYMENT'],
  ['health', 'HEALTH'],
  ['crm', 'CRM'],
  ['ai', 'AI'],
  ['auth', 'AUTH'],
];

const NOT_RUN = 'NOT RUN';

function statusOf(key) {
  const s = byName.get(key);
  if (!s) return NOT_RUN;
  return s.status ?? NOT_RUN;
}

function label(status) {
  if (status === NOT_AUTOMATED) return 'NOT AUTOMATED';
  if (status === SKIPPED) return 'SKIPPED';
  return status;
}

function icon(status) {
  switch (status) {
    case PASS:
      return '✅';
    case FAIL:
      return '❌';
    case NOT_AUTOMATED:
      return '⚠️';
    case SKIPPED:
      return '➖';
    default:
      return '⬜';
  }
}

const commit = String(args.commit ?? process.env.GITHUB_SHA ?? 'unknown');
const worker = String(args.worker ?? 'unknown');
const versionId = String(args['version-id'] ?? '') || null;
const deploymentUrl = String(args.url ?? '') || null;
const environment = String(args.environment ?? 'production');

/* --------------------------- overall outcome --------------------------- */
/* Any stage that failed counts — including stages not in the display table, so
 * a failing gate can never be hidden from the overall result. */
const anyFail = stages.some((s) => s.status === FAIL);
/* Stages that MUST have actually passed for a deployment to be called good. */
const REQUIRED = String(args.required ?? 'build,test,config,database,deployment,health')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const requiredMissing = REQUIRED.filter((k) => {
  const s = statusOf(k);
  return s !== PASS && !(k === 'database' && (s === SKIPPED || s === NOT_AUTOMATED));
});

const overall = anyFail || requiredMissing.length > 0 ? FAIL : PASS;

/* ------------------------------- console ------------------------------- */
const lines = [];
lines.push('');
lines.push('========================================================');
lines.push(`MUDREXX DEPLOYMENT RESULT — ${environment.toUpperCase()}`);
lines.push('========================================================');
lines.push('');
for (const [key, title] of ORDER) {
  lines.push(`${title.padEnd(12)} ${label(statusOf(key))}`);
}
lines.push('');
lines.push('--------------------------------------------------------');
lines.push(`Commit:      ${commit}`);
lines.push(`Worker:      ${worker}`);
lines.push(`Version:     ${versionId ?? 'not reported by wrangler'}`);
lines.push(`URL:         ${deploymentUrl ?? 'not reported'}`);
lines.push(`Environment: ${environment}`);
lines.push('--------------------------------------------------------');
lines.push('');
lines.push(`DEPLOYMENT RESULT: ${overall === PASS ? 'SUCCESS' : 'FAILED'}`);
if (overall !== PASS) {
  if (anyFail) lines.push(`Failed stages: ${stages.filter((s) => s.status === FAIL).map((s) => s.title ?? s.stage).join(', ')}`);
  if (requiredMissing.length) lines.push(`Required stages that did not pass: ${requiredMissing.join(', ')}`);
  lines.push('This deployment is NOT verified. Do not report it as successful.');
}
const notAutomated = ORDER.filter(([k]) => statusOf(k) === NOT_AUTOMATED).map(([, t]) => t);
const REQUIRED_LABEL = REQUIRED.join(', ');
if (notAutomated.length) {
  lines.push('');
  lines.push(`NOT AUTOMATED (requires a controlled manual smoke test): ${notAutomated.join(', ')}`);
}
console.log(lines.join('\n'));

/* ---------------------------- failure detail ---------------------------- */
for (const s of stages) {
  const failed = (s.checks ?? []).filter((c) => c.status === FAIL);
  if (failed.length) {
    console.log(`\n${s.title ?? s.stage} — failed checks:`);
    for (const c of failed) console.log(`  - ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  }
}

/* --------------------------- job summary (md) --------------------------- */
const md = [];
md.push(`## MUDREXX deployment — \`${environment}\``);
md.push('');
md.push(`**Result: ${overall === PASS ? '✅ SUCCESS' : '❌ FAILED'}**`);
md.push('');
md.push('| Stage | Status |');
md.push('| --- | --- |');
for (const [key, title] of ORDER) {
  const st = statusOf(key);
  md.push(`| ${title} | ${icon(st)} ${label(st)} |`);
}
md.push('');
md.push('| | |');
md.push('| --- | --- |');
md.push(`| Commit | \`${commit}\` |`);
md.push(`| Worker | \`${worker}\` |`);
md.push(`| Version | \`${versionId ?? 'not reported'}\` |`);
md.push(`| URL | ${deploymentUrl ? `<${deploymentUrl}>` : 'not reported'} |`);
md.push('');
for (const s of stages) {
  const checks = s.checks ?? [];
  if (!checks.length) continue;
  md.push(`<details><summary>${icon(s.status)} ${s.title ?? s.stage} — ${label(s.status)}</summary>`);
  md.push('');
  md.push('| Check | Status | Detail |');
  md.push('| --- | --- | --- |');
  for (const c of checks) {
    md.push(`| ${c.name} | ${icon(c.status)} ${label(c.status)} | ${String(c.detail ?? '').replace(/\|/g, '\\|')} |`);
  }
  md.push('');
  md.push('</details>');
  md.push('');
}
if (notAutomated.length) {
  md.push(`> ⚠️ **NOT AUTOMATED:** ${notAutomated.join(', ')} — verify with a controlled manual smoke test.`);
  md.push('');
}
appendSummary(`${md.join('\n')}\n`);

/* ------------------------------- outputs ------------------------------- */
if (process.env.GITHUB_OUTPUT) {
  const { writeFileSync } = await import('node:fs');
  const out = [
    `result=${overall === PASS ? 'success' : 'failed'}`,
    ...ORDER.map(([k, t]) => `${t.toLowerCase()}=${statusOf(k)}`),
  ].join('\n');
  writeFileSync(process.env.GITHUB_OUTPUT, `${out}\n`, { flag: 'a' });
}

if (args.out) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(
    args.out,
    `${JSON.stringify({ overall, environment, commit, worker, versionId, deploymentUrl, stages }, null, 2)}\n`,
  );
}

process.exit(overall === PASS ? 0 : 1);
