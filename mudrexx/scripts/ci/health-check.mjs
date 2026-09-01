#!/usr/bin/env node
/**
 * POST-DEPLOYMENT HEALTH CHECK  (§7)
 *
 * Runs against the REAL deployed URL and reports exactly what came back.
 *   GET /api/health      -> HTTP 200, valid JSON, service identity, environment
 *   GET /api/health/db   -> HTTP 200, valid JSON, D1 reachable
 *
 * A failure here marks the deployment FAILED. Nothing is assumed healthy.
 *
 * Usage:
 *   node scripts/ci/health-check.mjs --base-url https://... --expect-environment production --out artifacts/health.json
 */

import { StageReport, parseArgs, fetchWithRetry, readJsonBody, redact } from './lib.mjs';

const args = parseArgs();
const BASE_URL = String(args['base-url'] ?? process.env.BASE_URL ?? '').replace(/\/+$/, '');
const expectEnv = args['expect-environment'] ? String(args['expect-environment']) : null;

if (!BASE_URL) {
  console.error('Usage: node scripts/ci/health-check.mjs --base-url https://<worker-url>');
  process.exit(2);
}

const report = new StageReport('health', 'Production health check');
console.log(`\nMUDREXX health check\nTarget: ${BASE_URL}\n`);

const retry = { retries: Number(args.retries ?? 6), delayMs: Number(args['delay-ms'] ?? 5000) };

/* ------------------------------ /api/health ------------------------------ */
let healthJson = null;
try {
  const res = await fetchWithRetry(`${BASE_URL}/api/health`, { headers: { accept: 'application/json' } }, retry);
  const { json, text } = await readJsonBody(res);
  healthJson = json;

  report.ok('GET /api/health returns HTTP 200', res.status === 200, `HTTP ${res.status}`);
  report.ok(
    'GET /api/health returns valid JSON',
    json !== null,
    json !== null ? (res.headers.get('content-type') ?? '') : `non-JSON body: ${redact(text).slice(0, 160)}`,
  );
  report.ok(
    '/api/health reports status ok',
    json?.data?.status === 'ok' || json?.status === 'ok',
    `status=${json?.data?.status ?? json?.status ?? 'missing'}`,
  );
  report.ok(
    '/api/health identifies the MUDREXX backend',
    (json?.data?.service ?? json?.service) === 'mudrexx-backend',
    `service=${json?.data?.service ?? json?.service ?? 'missing'}`,
  );

  /* Environment separation (§6): prove we hit the right deployment. */
  const reportedEnv = json?.data?.environment ?? json?.environment;
  if (expectEnv) {
    report.ok(
      `deployment reports environment "${expectEnv}"`,
      reportedEnv === expectEnv,
      `environment=${reportedEnv ?? 'missing'}`,
    );
  } else {
    report.note('deployment environment', 'PASS', `environment=${reportedEnv ?? 'unreported'}`);
  }
} catch (err) {
  report.ok('GET /api/health reachable', false, redact(err.message));
}

/* ---------------------------- /api/health/db ---------------------------- */
try {
  const res = await fetchWithRetry(`${BASE_URL}/api/health/db`, { headers: { accept: 'application/json' } }, retry);
  const { json, text } = await readJsonBody(res);

  report.ok('GET /api/health/db returns HTTP 200', res.status === 200, `HTTP ${res.status}`);
  report.ok(
    'GET /api/health/db returns valid JSON',
    json !== null,
    json !== null ? (res.headers.get('content-type') ?? '') : `non-JSON body: ${redact(text).slice(0, 160)}`,
  );

  const data = json?.data ?? json;
  report.ok('database is reachable', data?.reachable === true, `reachable=${data?.reachable ?? 'missing'}`);
  report.ok('database binding is D1', data?.database === 'd1', `database=${data?.database ?? 'missing'}`);
  report.ok(
    'schema is present (tables > 0)',
    Number(data?.tables ?? 0) > 0,
    `tables=${data?.tables ?? 'missing'}`,
  );
  report.note(
    'database latency',
    'PASS',
    `${data?.latencyMs ?? '?'}ms, users=${data?.counts?.users ?? '?'} leads=${data?.counts?.leads ?? '?'} activeSessions=${data?.counts?.activeSessions ?? '?'}`,
  );

  /* The health endpoint must never leak a credential. */
  const body = JSON.stringify(json ?? text);
  const leaks = /(password|api_key|apikey|secret|token|dsn|connection_string)"\s*:\s*"[^"]{6,}/i.test(body);
  report.ok('health payload contains no credential values', !leaks, leaks ? 'credential-shaped value present in the response' : 'counts and booleans only');
} catch (err) {
  report.ok('GET /api/health/db reachable', false, redact(err.message));
}

/* -------------------- API must never answer with HTML -------------------- */
try {
  const res = await fetchWithRetry(`${BASE_URL}/api/definitely-not-a-route`, { headers: { accept: 'application/json' } }, { retries: 2, delayMs: 2000 });
  const ct = res.headers.get('content-type') ?? '';
  report.ok(
    'unknown /api path returns JSON 404 (never HTML)',
    res.status === 404 && ct.includes('application/json'),
    `HTTP ${res.status} ${ct}`,
  );
} catch (err) {
  report.ok('unknown /api path returns JSON 404 (never HTML)', false, redact(err.message));
}

/* Surface the LLM provider configuration for the AI stage (presence only). */
if (healthJson) {
  const cfg = healthJson?.data?.config ?? healthJson?.config ?? {};
  console.log(
    `\n  observed config presence (no values): llmProvidersConfigured=${cfg.llmProvidersConfigured ?? '?'} ` +
      `whatsapp=${cfg.whatsapp ?? '?'} telegram=${cfg.telegram ?? '?'} recovery=${cfg.recovery ?? '?'} corsAllowlist=${cfg.corsAllowlist ?? '?'}`,
  );
}

report.finish({ out: args.out });
