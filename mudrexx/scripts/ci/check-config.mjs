#!/usr/bin/env node
/**
 * PRE-DEPLOY CONFIGURATION GUARD
 *
 * Reads the REAL wrangler configuration from the repository and verifies the
 * target environment is coherent before anything is deployed. It never invents
 * a worker name, a D1 database id, a binding or a route — every value checked
 * here is read from `wrangler.jsonc`.
 *
 * It also enforces environment separation (§6): a production deploy must
 * resolve to the production worker, the production D1 database and
 * ENVIRONMENT=production. Staging config can never be shipped to production.
 *
 * Usage:
 *   node scripts/ci/check-config.mjs --target production --out artifacts/config.json
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StageReport, parseArgs, readJsonc, SKIPPED } from './lib.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const args = parseArgs();
const target = String(args.target ?? 'production');
const configPath = resolve(ROOT, String(args.config ?? 'wrangler.jsonc'));

const PLACEHOLDER_IDS = new Set([
  '00000000-0000-0000-0000-000000000000',
  'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
  '',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const report = new StageReport('config', `Configuration guard (${target})`);
console.log(`\nMUDREXX configuration guard\nTarget environment: ${target}\nConfig: ${configPath}\n`);

if (!existsSync(configPath)) {
  report.ok('wrangler config present', false, `${configPath} not found`);
  report.finish({ out: args.out });
}

const config = readJsonc(configPath);
report.ok('wrangler config parses', true, configPath.replace(`${ROOT}/`, ''));

/* ------------------------------------------------------------------ *
 * Resolve the effective configuration for the target environment.
 * Wrangler semantics: the top level IS the production/default env;
 * `env.<name>` overrides it. We resolve exactly the same way.
 * ------------------------------------------------------------------ */
const isTopLevel = target === 'production';
const envBlock = isTopLevel ? config : (config.env ?? {})[target];

if (!envBlock) {
  report.ok(
    `environment "${target}" is defined`,
    false,
    `wrangler.jsonc has no env.${target} block. Available: ${Object.keys(config.env ?? {}).join(', ') || 'none'}`,
  );
  report.finish({ out: args.out });
}
report.ok(`environment "${target}" is defined`, true, isTopLevel ? 'top-level (default) environment' : `env.${target}`);

/* -------------------------------- worker -------------------------------- */
const workerName = envBlock.name ?? (isTopLevel ? config.name : `${config.name}-${target}`);
report.ok('worker name resolved from config', Boolean(workerName), workerName ?? 'missing');

const mainEntry = envBlock.main ?? config.main;
report.ok(
  'worker entrypoint exists',
  Boolean(mainEntry) && existsSync(join(ROOT, mainEntry)),
  mainEntry ?? 'missing "main"',
);

report.ok(
  'compatibility_date set',
  Boolean(envBlock.compatibility_date ?? config.compatibility_date),
  envBlock.compatibility_date ?? config.compatibility_date ?? 'missing',
);

/* ------------------------------ environment ------------------------------ */
const vars = envBlock.vars ?? {};
const declaredEnv = vars.ENVIRONMENT;
report.ok(
  'vars.ENVIRONMENT matches the deploy target',
  declaredEnv === target,
  `vars.ENVIRONMENT=${declaredEnv ?? 'unset'} target=${target}`,
);

/* --------------------------------- D1 ----------------------------------- */
const d1 = envBlock.d1_databases ?? (isTopLevel ? config.d1_databases : undefined);
report.ok('D1 binding declared', Array.isArray(d1) && d1.length > 0, `${d1?.length ?? 0} database binding(s)`);

for (const db of d1 ?? []) {
  const label = `D1 "${db.binding}" (${db.database_name})`;
  report.ok(`${label}: binding name present`, Boolean(db.binding), db.binding ?? 'missing');
  report.ok(`${label}: database_name present`, Boolean(db.database_name), db.database_name ?? 'missing');

  const id = String(db.database_id ?? '');
  const isPlaceholder = PLACEHOLDER_IDS.has(id) || /^0+$/.test(id.replace(/-/g, ''));
  report.ok(
    `${label}: database_id is a real provisioned id`,
    !isPlaceholder && UUID_RE.test(id),
    isPlaceholder
      ? 'still the placeholder id — run `npx wrangler d1 list` and set the real id before deploying'
      : UUID_RE.test(id)
        ? `${id.slice(0, 8)}…`
        : `not a valid D1 id: ${id}`,
  );

  const migrationsDir = db.migrations_dir ?? 'migrations';
  report.ok(
    `${label}: migrations_dir exists`,
    existsSync(join(ROOT, migrationsDir)),
    migrationsDir,
  );

  /* Environment separation (§6): production must not point at staging/dev data. */
  if (target === 'production') {
    const name = String(db.database_name ?? '').toLowerCase();
    report.ok(
      `${label}: is not a staging/dev database`,
      !/(staging|stage|dev|test|preview)/.test(name),
      db.database_name,
    );
  } else {
    const prodDbs = (config.d1_databases ?? []).map((p) => String(p.database_id));
    report.ok(
      `${label}: does not reuse the production database id`,
      !prodDbs.includes(String(db.database_id)) || PLACEHOLDER_IDS.has(String(db.database_id)),
      PLACEHOLDER_IDS.has(String(db.database_id))
        ? 'placeholder id (not yet provisioned)'
        : 'distinct from production',
    );
  }
}

/* ------------------------- no secrets in the repo ------------------------- */
/*
 * Cloudflare `vars` are PUBLIC (they are baked into the deployed worker).
 * Anything credential-shaped must be a Worker secret / GitHub secret instead.
 */
const SECRET_NAME_RE =
  /(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL|_SID|AUTH_TOKEN|DSN|CONNECTION_STRING)/i;

const leakedVars = Object.entries(vars).filter(
  ([k, v]) => SECRET_NAME_RE.test(k) && typeof v === 'string' && v.trim() !== '',
);
report.ok(
  'no credentials in plaintext wrangler vars',
  leakedVars.length === 0,
  leakedVars.length ? `credential-shaped vars with values: ${leakedVars.map(([k]) => k).join(', ')}` : 'clean',
);

report.ok(
  '.dev.vars is not committed',
  !existsSync(join(ROOT, '.dev.vars')),
  existsSync(join(ROOT, '.dev.vars')) ? '.dev.vars exists in the checkout — it must stay gitignored' : 'absent',
);

/* ------------------- deploy credentials come from secrets ------------------- */
const hasToken = Boolean(process.env.CLOUDFLARE_API_TOKEN);
const hasAccount = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID);
if (args['require-credentials']) {
  report.ok('CLOUDFLARE_API_TOKEN provided by the environment', hasToken, hasToken ? 'present (value never logged)' : 'missing — add it as a GitHub secret');
  report.ok('CLOUDFLARE_ACCOUNT_ID provided by the environment', hasAccount, hasAccount ? 'present (value never logged)' : 'missing — add it as a GitHub secret');
} else {
  report.note(
    'Cloudflare credentials',
    hasToken && hasAccount ? 'PASS' : SKIPPED,
    hasToken && hasAccount ? 'present (values never logged)' : 'not required for this stage — the deploy job re-runs this guard with --require-credentials',
  );
}

/* ------------------------------- routes ---------------------------------- */
const routes = envBlock.routes ?? envBlock.route;
if (routes) {
  report.ok('routes read from config (not invented)', true, JSON.stringify(routes));
} else {
  report.note(
    'custom routes',
    'SKIPPED',
    'none declared — the worker is served on its workers.dev / configured hostname',
  );
}

report.finish({ out: args.out });
