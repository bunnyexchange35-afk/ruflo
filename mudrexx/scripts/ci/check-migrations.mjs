#!/usr/bin/env node
/**
 * DATABASE / SCHEMA CHECK  (§4)
 *
 * This stage NEVER applies a destructive migration automatically.
 *
 *   1. detect   — list migration files and, when credentials are available,
 *                 ask D1 which ones are still pending.
 *   2. validate — statically reject any migration containing a destructive
 *                 statement (DROP DATABASE / DROP TABLE / TRUNCATE /
 *                 unqualified DELETE / destructive ALTER).
 *   3. apply    — only when the operator explicitly opts in (--apply) AND
 *                 validation passed. Additive migrations only.
 *   4. verify   — re-read the applied list and confirm nothing is pending.
 *
 * Usage:
 *   node scripts/ci/check-migrations.mjs --target production --out artifacts/database.json
 *   node scripts/ci/check-migrations.mjs --target production --apply --out ...
 *   node scripts/ci/check-migrations.mjs --offline --out ...   # validation only
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StageReport, parseArgs, readJsonc, redact, NOT_AUTOMATED, SKIPPED } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const args = parseArgs();
const target = String(args.target ?? 'production');
const apply = Boolean(args.apply);
const offline = Boolean(args.offline) || !process.env.CLOUDFLARE_API_TOKEN;

const report = new StageReport('database', `Database / schema check (${target})`);
console.log(`\nMUDREXX database & migration gate\nTarget: ${target}\nMode: ${offline ? 'offline (validation only)' : apply ? 'detect + validate + apply + verify' : 'detect + validate + verify'}\n`);

/* ----------------------------------------------------------------- *
 * Destructive statement detection.
 * Comments and string literals are stripped first so that a migration
 * documenting "-- we never DROP TABLE here" does not trip the gate.
 * ----------------------------------------------------------------- */
const DESTRUCTIVE = [
  { name: 'DROP DATABASE', re: /\bDROP\s+DATABASE\b/i },
  { name: 'DROP TABLE', re: /\bDROP\s+TABLE\b/i },
  { name: 'DROP SCHEMA', re: /\bDROP\s+SCHEMA\b/i },
  { name: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/i },
  { name: 'TRUNCATE', re: /\bTRUNCATE\b/i },
  { name: 'DELETE without WHERE', re: /\bDELETE\s+FROM\s+[`"[\]\w.]+\s*(?:;|$)/im },
  { name: 'ALTER TABLE ... RENAME TO', re: /\bALTER\s+TABLE\s+[`"[\]\w.]+\s+RENAME\s+TO\b/i },
];

/** Removes -- line comments, block comments and quoted strings. */
function stripNoise(sql) {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/* --------------------------- 1. detect --------------------------- */
const config = readJsonc(join(ROOT, 'wrangler.jsonc'));
const isTopLevel = target === 'production';
const envBlock = isTopLevel ? config : (config.env ?? {})[target];

if (!envBlock) {
  report.ok(`environment "${target}" exists in wrangler.jsonc`, false, 'cannot resolve the D1 binding');
  report.finish({ out: args.out });
}

const db = (envBlock.d1_databases ?? config.d1_databases ?? [])[0];
if (!db) {
  report.ok('D1 database binding found in wrangler.jsonc', false, 'no d1_databases entry');
  report.finish({ out: args.out });
}
report.ok('D1 database binding found in wrangler.jsonc', true, `${db.binding} -> ${db.database_name}`);

const migrationsDir = join(ROOT, db.migrations_dir ?? 'migrations');
if (!existsSync(migrationsDir)) {
  report.note('migrations directory', SKIPPED, `${db.migrations_dir ?? 'migrations'} does not exist — nothing to migrate`);
  report.finish({ out: args.out });
}

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
report.ok('migrations discovered', true, files.length ? files.join(', ') : 'none');

if (files.length === 0) {
  report.note('pending migrations', SKIPPED, 'no migration files present');
  report.finish({ out: args.out });
}

/* -------------------------- 2. validate -------------------------- */
let destructiveFound = false;
for (const file of files) {
  const sql = stripNoise(readFileSync(join(migrationsDir, file), 'utf8'));
  const hits = DESTRUCTIVE.filter((d) => d.re.test(sql)).map((d) => d.name);
  if (hits.length) destructiveFound = true;
  report.ok(
    `validate ${file}: no destructive statements`,
    hits.length === 0,
    hits.length ? `BLOCKED — contains ${hits.join(', ')}` : 'additive only',
  );
}

if (destructiveFound) {
  report.ok(
    'automatic migration is safe to run',
    false,
    'destructive statements must be reviewed and applied manually by an operator — automatic deployment will not run them',
  );
  report.finish({ out: args.out });
}

/* --------------- pending detection against the real DB --------------- */
function wrangler(subcommand) {
  const cmd = ['wrangler', ...subcommand];
  if (!isTopLevel) cmd.push('--env', target);
  return execFileSync('npx', cmd, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    timeout: 300_000,
  });
}

if (offline) {
  report.note(
    'pending migration detection',
    NOT_AUTOMATED,
    'no CLOUDFLARE_API_TOKEN in this context — static validation only, D1 was not contacted',
  );
  report.finish({ out: args.out });
}

let pendingBefore = '';
try {
  pendingBefore = wrangler(['d1', 'migrations', 'list', db.database_name, '--remote']);
  console.log(pendingBefore.trim().split('\n').map((l) => `      ${l}`).join('\n'));
} catch (err) {
  report.ok(
    'query D1 for pending migrations',
    false,
    redact(err.stderr || err.stdout || err.message),
  );
  report.finish({ out: args.out });
}

const noPending = /no migrations to apply|✅|no unapplied/i.test(pendingBefore);
const pendingNames = pendingBefore
  .split('\n')
  .map((l) => l.match(/(\d{4}_[\w-]+\.sql)/)?.[1])
  .filter(Boolean);

report.ok('query D1 for pending migrations', true, noPending && !pendingNames.length ? 'schema already up to date' : `pending: ${pendingNames.join(', ') || 'see log'}`);

if (noPending && !pendingNames.length) {
  report.ok('schema matches the repository', true, 'no migration needed');
  report.finish({ out: args.out });
}

/* ---------------------------- 3. apply ---------------------------- */
if (!apply) {
  report.note(
    'apply pending migrations',
    NOT_AUTOMATED,
    `${pendingNames.length || 'some'} migration(s) pending. Approve them by re-running with APPLY_MIGRATIONS=true — deployment continues without touching the schema.`,
  );
  report.finish({ out: args.out });
}

try {
  const out = wrangler(['d1', 'migrations', 'apply', db.database_name, '--remote']);
  console.log(out.trim().split('\n').map((l) => `      ${l}`).join('\n'));
  report.ok('apply approved (non-destructive) migrations', true, `${pendingNames.join(', ') || 'applied'}`);
} catch (err) {
  report.ok('apply approved (non-destructive) migrations', false, redact(err.stderr || err.stdout || err.message));
  report.finish({ out: args.out });
}

/* ---------------------------- 4. verify ---------------------------- */
try {
  const after = wrangler(['d1', 'migrations', 'list', db.database_name, '--remote']);
  const clean = /no migrations to apply|no unapplied/i.test(after) || !/(\d{4}_[\w-]+\.sql)/.test(after);
  report.ok('verify schema after migration', clean, clean ? 'no migrations pending' : 'migrations still pending after apply');
} catch (err) {
  report.ok('verify schema after migration', false, redact(err.stderr || err.stdout || err.message));
}

report.finish({ out: args.out });
