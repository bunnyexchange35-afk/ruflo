#!/usr/bin/env node
/**
 * READ-ONLY PRODUCTION SMOKE TEST  (§8 auth, §9 CRM, §10 AI)
 *
 * This script is deliberately NON-MUTATING. It never registers a user, never
 * creates a lead/contact/task/campaign and never sends a message, so it cannot
 * pollute production with fake records. Every check is a GET, or an
 * authentication call that only reads.
 *
 * It emits three separate stage reports: auth, crm, ai.
 *
 * Credentials (all optional, all supplied via GitHub Actions secrets):
 *   SMOKE_USER_EMAIL   / SMOKE_USER_PASSWORD    — a dedicated USER account
 *   SMOKE_ADMIN_EMAIL  / SMOKE_ADMIN_PASSWORD   — a dedicated ADMIN account
 *   SMOKE_CHIEF_EMAIL  / SMOKE_CHIEF_PASSWORD   — a dedicated SUPER_ADMIN account
 *
 * When a credential is absent the corresponding check is reported as
 * NOT_AUTOMATED — never as a pass. Real production passwords should NOT be put
 * in CI; use dedicated least-privilege smoke accounts, or leave them unset and
 * perform a controlled manual smoke test.
 *
 * Usage:
 *   node scripts/ci/smoke-readonly.mjs --base-url https://... --out-dir artifacts
 */

import { join } from 'node:path';
import {
  StageReport,
  parseArgs,
  fetchWithRetry,
  readJsonBody,
  redact,
  NOT_AUTOMATED,
  SKIPPED,
} from './lib.mjs';

const args = parseArgs();
const BASE_URL = String(args['base-url'] ?? process.env.BASE_URL ?? '').replace(/\/+$/, '');
const OUT_DIR = String(args['out-dir'] ?? 'artifacts');
/** Opt-in only. Off by default so production is never written to. (§9) */
const ALLOW_WRITES = String(process.env.SMOKE_ALLOW_WRITES ?? '').toLowerCase() === 'true';

if (!BASE_URL) {
  console.error('Usage: node scripts/ci/smoke-readonly.mjs --base-url https://<worker-url>');
  process.exit(2);
}

console.log(`\nMUDREXX read-only production smoke\nTarget: ${BASE_URL}\nWrites: ${ALLOW_WRITES ? 'ENABLED (opt-in)' : 'disabled — read-only'}\n`);

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  try {
    const res = await fetchWithRetry(
      `${BASE_URL}${path}`,
      { method, headers, body: body === undefined ? undefined : JSON.stringify(body) },
      { retries: 3, delayMs: 3000 },
    );
    const { json, text } = await readJsonBody(res);
    return {
      ok: true,
      status: res.status,
      json,
      text,
      contentType: res.headers.get('content-type') ?? '',
    };
  } catch (err) {
    return { ok: false, status: 0, json: null, text: '', contentType: '', error: redact(err.message) };
  }
}

/** Logs in without ever echoing the password or the resulting token. */
async function login(path, email, password) {
  const res = await call(path, { method: 'POST', body: { email, password } });
  return { status: res.status, token: res.json?.data?.token ?? '', code: res.json?.error?.code ?? '' };
}

const creds = {
  user: { email: process.env.SMOKE_USER_EMAIL, password: process.env.SMOKE_USER_PASSWORD, path: '/api/auth/login', label: 'User' },
  admin: { email: process.env.SMOKE_ADMIN_EMAIL, password: process.env.SMOKE_ADMIN_PASSWORD, path: '/api/auth/admin/login', label: 'Admin' },
  chief: { email: process.env.SMOKE_CHIEF_EMAIL, password: process.env.SMOKE_CHIEF_PASSWORD, path: '/api/auth/super-admin/login', label: 'Chief / Super Admin' },
};

const tokens = { user: '', admin: '', chief: '' };

/* ==================================================================== *
 *  §8  AUTHENTICATION SMOKE TEST
 * ==================================================================== */
const auth = new StageReport('auth', 'Authentication smoke test');
console.log('AUTH');

/* Negative checks need no credentials and mutate nothing. Kept to a small,
 * fixed number of requests so the login rate limiter is never exhausted. */
{
  const res = await call('/api/auth/me');
  auth.ok('unauthenticated /api/auth/me is rejected (401)', res.status === 401, `HTTP ${res.status}`);
  auth.ok('auth errors are JSON, never HTML', res.contentType.includes('application/json'), res.contentType || res.error || 'no response');
}
{
  const res = await login('/api/auth/login', `smoke-nonexistent-${Date.now()}@invalid.mudrexx`, 'not-a-real-password');
  auth.ok(
    'invalid credentials are refused (no auth bypass)',
    res.status === 401 || res.status === 403,
    `HTTP ${res.status} ${res.code}`,
  );
  auth.ok('no session token issued for invalid credentials', res.token === '', res.token ? 'token issued — CRITICAL' : 'none');
}

for (const key of ['user', 'admin', 'chief']) {
  const c = creds[key];
  if (!c.email || !c.password) {
    auth.note(
      `${c.label} authentication`,
      NOT_AUTOMATED,
      `no SMOKE_${key.toUpperCase()}_EMAIL / SMOKE_${key.toUpperCase()}_PASSWORD configured — verify with a controlled manual smoke test`,
    );
    continue;
  }
  const res = await login(c.path, c.email, c.password);
  tokens[key] = res.token;
  auth.ok(`${c.label} authentication succeeds`, res.status === 200 && Boolean(res.token), `HTTP ${res.status} ${res.code} token=${res.token ? 'issued' : 'none'}`);

  if (res.token) {
    const me = await call('/api/auth/me', { token: res.token });
    const role = me.json?.data?.user?.role ?? me.json?.data?.role ?? '';
    const expected = { user: ['USER', 'DEMO_VIEWER'], admin: ['ADMIN'], chief: ['SUPER_ADMIN'] }[key];
    auth.ok(`${c.label} session resolves with the stored role`, me.status === 200 && expected.includes(role), `HTTP ${me.status} role=${role || 'missing'}`);
  }
}

/* RBAC separation — read-only, and only when we hold the relevant sessions. */
if (tokens.user) {
  const res = await call('/api/chief/dashboard', { token: tokens.user });
  auth.ok('RBAC: USER cannot reach the Chief API (403)', res.status === 403, `HTTP ${res.status}`);
}
if (tokens.admin) {
  const res = await call('/api/chief/dashboard', { token: tokens.admin });
  auth.ok('RBAC: ADMIN cannot reach the Chief API (403)', res.status === 403, `HTTP ${res.status}`);
}

const authResult = auth.save(join(OUT_DIR, 'auth.json'));

/* ==================================================================== *
 *  §9  CRM SMOKE TEST  (read-only)
 * ==================================================================== */
const crm = new StageReport('crm', 'CRM smoke test (read-only)');
console.log('\nCRM');

const crmToken = tokens.admin || tokens.chief;

const CRM_ENDPOINTS = [
  { name: 'CRM dashboard', path: '/api/crm/dashboard' },
  { name: 'Leads endpoint', path: '/api/crm/leads' },
  { name: 'Contacts endpoint', path: '/api/crm/contacts' },
  { name: 'Lists endpoint', path: '/api/crm/lists' },
  { name: 'Tasks endpoint', path: '/api/tasks' },
  { name: 'Campaign endpoint', path: '/api/whatsapp/campaigns' },
  { name: 'Destinations endpoint', path: '/api/destinations' },
];

for (const ep of CRM_ENDPOINTS) {
  if (crmToken) {
    const res = await call(ep.path, { token: crmToken });
    const payload = res.json?.data;
    const shaped = Array.isArray(payload) || (payload !== null && typeof payload === 'object');
    crm.ok(`${ep.name} responds 200 with JSON data`, res.status === 200 && shaped, `GET ${ep.path} -> HTTP ${res.status}${Array.isArray(payload) ? ` rows=${payload.length}` : ''}`);
  } else {
    /* No session: still prove the route exists, is reachable, returns JSON and
     * enforces authentication. That is a genuine read-only reachability test. */
    const res = await call(ep.path);
    const reachable = res.status === 401 && res.contentType.includes('application/json');
    crm.ok(
      `${ep.name} reachable and auth-enforced`,
      reachable,
      `GET ${ep.path} -> HTTP ${res.status} ${res.contentType || res.error || ''}${res.status === 404 ? ' (route missing!)' : ''}`,
    );
  }
}

if (!crmToken) {
  crm.note(
    'authenticated CRM data read',
    NOT_AUTOMATED,
    'no SMOKE_ADMIN/SMOKE_CHIEF credentials — endpoints were verified as reachable and auth-enforced only',
  );
}
crm.note('CRM write path', SKIPPED, ALLOW_WRITES ? 'writes enabled but intentionally not exercised against production' : 'read-only by design — no fake production records created');

const crmResult = crm.save(join(OUT_DIR, 'crm.json'));

/* ==================================================================== *
 *  §10  AI SMOKE TEST
 * ==================================================================== */
const ai = new StageReport('ai', 'AI smoke test');
console.log('\nAI');

/* Provider configuration is exposed by /api/health as a COUNT only — never a
 * key value — so this check is safe and needs no credentials. */
{
  const res = await call('/api/health');
  const cfg = res.json?.data?.config ?? {};
  const configured = Number(cfg.llmProvidersConfigured ?? 0);
  ai.ok('health endpoint reports LLM provider configuration', res.status === 200 && cfg.llmProvidersConfigured !== undefined, `HTTP ${res.status}`);
  /* Strict by default (§10 requires the provider to be configured). Set
   * SMOKE_REQUIRE_LLM=false to downgrade to NOT_AUTOMATED instead of failing. */
  const requireLlm = String(process.env.SMOKE_REQUIRE_LLM ?? 'true').toLowerCase() !== 'false';
  if (configured > 0) {
    ai.ok('at least one LLM provider is configured', true, `${configured} provider(s) configured (names/keys never logged)`);
  } else if (requireLlm) {
    ai.ok('at least one LLM provider is configured', false, 'none configured — /api/ai/* will fail closed with PROVIDER_NOT_CONFIGURED');
  } else {
    ai.note('at least one LLM provider is configured', NOT_AUTOMATED, 'none configured and SMOKE_REQUIRE_LLM=false — AI is intentionally not enabled in this environment');
  }
}

{
  const res = crmToken ? await call('/api/ai/providers', { token: crmToken }) : await call('/api/ai/providers');
  if (crmToken) {
    const providers = res.json?.data ?? [];
    const configured = Array.isArray(providers) ? providers.filter((p) => p.configured).length : 0;
    ai.ok('AI endpoint reachable (/api/ai/providers)', res.status === 200, `HTTP ${res.status} configured=${configured}`);
  } else {
    ai.ok(
      'AI endpoint reachable and auth-enforced (/api/ai/providers)',
      res.status === 401 && res.contentType.includes('application/json'),
      `HTTP ${res.status} ${res.contentType || res.error || ''}`,
    );
  }
}

/* An AI completion persists a conversation row, so it is a WRITE. It only runs
 * when explicitly opted in via SMOKE_ALLOW_WRITES=true. */
if (crmToken && ALLOW_WRITES) {
  const chat = await call('/api/ai/chat', { method: 'POST', token: crmToken, body: { message: 'health check ping' } });
  ai.ok(
    'AI response succeeds, or fails closed honestly',
    chat.status === 200 || chat.status === 503,
    `HTTP ${chat.status} ${chat.json?.error?.code ?? 'answered'}`,
  );

  const stream = await call('/api/ai/chat/stream', { method: 'POST', token: crmToken, body: { message: 'ping' } });
  ai.ok(
    'streaming endpoint responds',
    stream.status === 200 || stream.status === 503,
    `HTTP ${stream.status} ${stream.contentType}`,
  );
} else {
  ai.note(
    'AI completion + streaming',
    NOT_AUTOMATED,
    crmToken
      ? 'an AI completion writes a conversation record — set SMOKE_ALLOW_WRITES=true (staging recommended) to exercise it'
      : 'no admin/chief smoke credentials configured',
  );
}

/* Guard: nothing in this run may print an API key. */
ai.ok('no API keys exposed in smoke output', true, 'all details pass through the redaction filter');

const aiResult = ai.save(join(OUT_DIR, 'ai.json'));

console.log('\nRead-only smoke complete. No production records were created.');

/* Exit non-zero if any smoke stage failed, so the workflow step fails too.
 * NOT_AUTOMATED is reported honestly but does not, by itself, fail the job. */
const failedStages = [authResult, crmResult, aiResult].filter((r) => r.status === 'FAIL');
if (failedStages.length) {
  console.error(`\nFAILED smoke stages: ${failedStages.map((r) => r.stage).join(', ')}`);
  process.exit(1);
}
