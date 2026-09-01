#!/usr/bin/env node
/**
 * §59 POST-DEPLOYMENT SMOKE TEST.
 *
 * Runs the production verification chain against a REAL deployed URL.
 * It reports exactly what the server returned — it never fabricates a result
 * and never marks a step PASS unless the observed response matches.
 *
 * Usage:
 *   node scripts/smoke.mjs --base-url https://mudrexx-backend.<subdomain>.workers.dev
 *   CHIEF_EMAIL=... CHIEF_PASSWORD=... node scripts/smoke.mjs --base-url http://127.0.0.1:8787
 *
 * Exit code 0 only when every step passes.
 */

const args = process.argv.slice(2);
const baseUrlArg = args.indexOf('--base-url');
const BASE_URL = baseUrlArg !== -1 ? args[baseUrlArg + 1] : process.env.BASE_URL;

if (!BASE_URL) {
  console.error('Usage: node scripts/smoke.mjs --base-url https://<worker>.workers.dev');
  process.exit(2);
}

const results = [];
let chiefToken = '';
let adminToken = '';
let userToken = '';

function record(step, name, ok, detail) {
  results.push({ step, name, ok, detail });
  const label = ok ? 'PASS' : 'FAIL';
  console.log(`${String(step).padStart(4, ' ')}  [${label}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, contentType: res.headers.get('content-type') ?? '' };
}

async function main() {
  console.log(`\nMUDREXX smoke test\nTarget: ${BASE_URL}\n`);

  /* ---------------------------------------------------------------- 1 */
  {
    const res = await fetch(`${BASE_URL}/`);
    record(1, 'Landing page responds', res.status === 200, `HTTP ${res.status}`);
  }

  /* ---------------------------------------------------------------- 2 */
  const userEmail = `smoke-user-${Date.now()}@example.com`;
  const userPassword = 'SmokeTest-12345';
  {
    const res = await call('/api/auth/register', {
      method: 'POST',
      body: { email: userEmail, password: userPassword, fullName: 'Smoke User' },
    });
    userToken = res.json?.data?.token ?? '';
    record(
      2,
      'User signup (human ID 2-5 digits)',
      res.status === 201 && /^\d{2,5}$/.test(String(res.json?.data?.user?.humanId ?? '')),
      `HTTP ${res.status} humanId=${res.json?.data?.user?.humanId ?? 'n/a'}`,
    );
  }

  /* ---------------------------------------------------------------- 3 */
  {
    const res = await call('/api/auth/login', {
      method: 'POST',
      body: { email: userEmail, password: userPassword },
    });
    userToken = res.json?.data?.token ?? userToken;
    record(3, 'User signin', res.status === 200 && Boolean(userToken), `HTTP ${res.status}`);
  }

  /* ---------------------------------------------------------------- 4 */
  {
    const res = await call('/api/auth/me', { token: userToken });
    record(4, 'User session resolves', res.status === 200, `HTTP ${res.status}`);
  }

  /* ---------------------------------------------------------------- 5 */
  const adminEmail = `smoke-admin-${Date.now()}@example.com`;
  const adminPassword = 'SmokeAdmin-12345';

  const reg = await call('/api/admin/register', {
    method: 'POST',
    body: { email: adminEmail, password: adminPassword, fullName: 'Smoke Admin' },
  });
  const adminId = reg.json?.data?.adminId ?? '';
  record(
    5,
    'Admin registration lands in PENDING',
    reg.status === 201 && reg.json?.data?.canLogin === false && /^\d{2,5}$/.test(String(adminId)),
    `HTTP ${reg.status} adminId=${adminId} canLogin=${reg.json?.data?.canLogin}`,
  );

  /* ---------------------------------------------------------------- 6 */
  const pkgs = await call('/api/packages');
  const bronze = (pkgs.json?.data ?? []).find((p) => p.code === 'BRONZE');
  const pay = await call('/api/admin/payments/submit', {
    method: 'POST',
    body: {
      email: adminEmail,
      adminId,
      packageId: bronze?.id,
      amountCents: 199900,
      method: 'UPI',
      reference: 'SMOKE',
    },
  });
  record(6, 'Admin payment submitted before login', pay.status === 201, `HTTP ${pay.status}`);

  /* ---------------------------------------------------------------- 7 */
  {
    const res = await call('/api/auth/admin/login', {
      method: 'POST',
      body: { email: adminEmail, password: adminPassword },
    });
    record(
      7,
      'Admin login blocked before approval',
      res.status === 403,
      `HTTP ${res.status} ${res.json?.error?.code ?? ''}`,
    );
  }

  /* ---------------------------------------------------------------- 8 */
  if (process.env.CHIEF_EMAIL && process.env.CHIEF_PASSWORD) {
    const res = await call('/api/auth/super-admin/login', {
      method: 'POST',
      body: { email: process.env.CHIEF_EMAIL, password: process.env.CHIEF_PASSWORD },
    });
    chiefToken = res.json?.data?.token ?? '';
    record(8, 'Chief login', res.status === 200 && Boolean(chiefToken), `HTTP ${res.status}`);
  } else {
    record(8, 'Chief login', false, 'SKIPPED — set CHIEF_EMAIL and CHIEF_PASSWORD');
  }

  /* ---------------------------------------------------------------- 9 */
  if (chiefToken) {
    const res = await call('/api/chief/dashboard', { token: chiefToken });
    record(9, 'Chief dashboard', res.status === 200, `HTTP ${res.status}`);
  } else {
    record(9, 'Chief dashboard', false, 'SKIPPED — no chief session');
  }

  /* --------------------------------------------------------------- 10 */
  if (chiefToken) {
    const pending = await call('/api/chief/payments?status=SUBMITTED', { token: chiefToken });
    const mine = (pending.json?.data?.rows ?? []).find((r) => r.reference === 'SMOKE');
    if (mine) {
      const verified = await call(`/api/chief/payments/${mine.id}/verify`, {
        method: 'POST',
        token: chiefToken,
        body: { note: 'smoke test' },
      });
      record(10, 'Chief verifies payment', verified.status === 200, `HTTP ${verified.status}`);
    } else {
      record(10, 'Chief verifies payment', false, 'payment not found');
    }

    const found = await call(`/api/chief/admins/search?q=${encodeURIComponent(adminEmail)}`, {
      token: chiefToken,
    });
    const target = (found.json?.data ?? []).find((a) => a.email === adminEmail);
    if (target) {
      const approved = await call(`/api/chief/admins/${target.id}/approve`, {
        method: 'POST',
        token: chiefToken,
        body: { note: 'smoke test' },
      });
      record(10.1, 'Chief approves admin', approved.status === 200, `HTTP ${approved.status}`);
    } else {
      record(10.1, 'Chief approves admin', false, 'admin not found');
    }

    const signedIn = await call('/api/auth/admin/login', {
      method: 'POST',
      body: { email: adminEmail, password: adminPassword },
    });
    adminToken = signedIn.json?.data?.token ?? '';
    record(10.2, 'Admin login after approval', signedIn.status === 200, `HTTP ${signedIn.status}`);
  } else {
    record(10, 'Chief approval chain', false, 'SKIPPED — no chief session');
  }

  /* --------------------------------------------------------------- 11 */
  if (adminToken) {
    const res = await call('/api/admin/dashboard', { token: adminToken });
    record(11, 'Admin dashboard', res.status === 200, `HTTP ${res.status}`);
  } else {
    record(11, 'Admin dashboard', false, 'SKIPPED — no admin session');
  }

  /* --------------------------------------------------------------- 12 */
  {
    const res = await call('/api/chief/dashboard', { token: userToken });
    record(12, 'RBAC: user → chief API = 403', res.status === 403, `HTTP ${res.status}`);
  }

  /* --------------------------------------------------------------- 13 */
  if (adminToken) {
    const res = await call('/api/chief/dashboard', { token: adminToken });
    record(13, 'RBAC: admin → chief API = 403', res.status === 403, `HTTP ${res.status}`);
  } else {
    record(13, 'RBAC: admin → chief API = 403', false, 'SKIPPED — no admin session');
  }

  /* --------------------------------------------------------------- 14 */
  {
    const res = await call('/api/chief/dashboard');
    record(14, 'Protected API without session = 401', res.status === 401, `HTTP ${res.status}`);
  }

  /* --------------------------------------------------------------- 15 */
  {
    const res = await call('/api/chief/dashboard');
    record(
      15,
      'API never returns HTML',
      res.contentType.includes('application/json'),
      res.contentType,
    );
  }

  /* --------------------------------------------------------------- 16 */
  {
    const res = await call('/api/definitely-not-a-route');
    record(
      16,
      'Unknown API path = JSON 404',
      res.status === 404 && res.contentType.includes('application/json'),
      `HTTP ${res.status}`,
    );
  }

  /* --------------------------------------------------------------- 17 */
  {
    const res = await call('/api/health/db');
    record(
      17,
      'Database health (D1 reachable)',
      res.status === 200 && res.json?.data?.database === 'd1',
      `HTTP ${res.status} tables=${res.json?.data?.tables ?? 'n/a'} users=${res.json?.data?.counts?.users ?? 'n/a'}`,
    );
  }

  /* --------------------------------------------------------------- 18 */
  {
    await call('/api/auth/logout', { method: 'POST', token: userToken });
    const res = await call('/api/auth/me', { token: userToken });
    record(18, 'Logout invalidates the session', res.status === 401, `HTTP ${res.status}`);
  }

  /* --------------------------------------------------------------- 19 */
  const crmToken = adminToken || chiefToken;
  if (crmToken) {
    const list = await call('/api/crm/leads', { token: crmToken });
    record(19, 'CRM leads list', list.status === 200, `HTTP ${list.status}`);

    const created = await call('/api/crm/leads', {
      method: 'POST',
      token: crmToken,
      body: {
        name: 'Smoke Lead',
        phone: `+9199000${String(Date.now()).slice(-5)}`,
        source: 'API',
        score: 50,
      },
    });
    record(
      19.1,
      'CRM lead create',
      created.status === 201,
      `HTTP ${created.status} created=${created.json?.data?.created}`,
    );
  } else {
    record(19, 'CRM', false, 'SKIPPED — no admin/chief session');
  }

  /* --------------------------------------------------------------- 20 */
  if (crmToken) {
    const providers = await call('/api/ai/providers', { token: crmToken });
    const configured = (providers.json?.data ?? []).filter((p) => p.configured).length;
    record(
      20,
      'AI provider status reported honestly',
      providers.status === 200,
      `HTTP ${providers.status} configured=${configured}`,
    );

    const chat = await call('/api/ai/chat', {
      method: 'POST',
      token: crmToken,
      body: { message: 'ping' },
    });
    // Either a real answer (200) or an honest "not configured" (503) — never a fake one.
    record(
      20.1,
      'AI chat: real answer or fails closed',
      chat.status === 200 || chat.status === 503,
      `HTTP ${chat.status} ${chat.json?.error?.code ?? 'answered'}`,
    );
  } else {
    record(20, 'AI', false, 'SKIPPED — no admin/chief session');
  }

  /* --------------------------------------------------------------- 21 */
  if (crmToken) {
    const res = await call('/api/tasks', {
      method: 'POST',
      token: crmToken,
      body: { title: `Smoke task ${Date.now()}`, priority: 'MEDIUM' },
    });
    record(21, 'Task create', res.status === 201, `HTTP ${res.status}`);

    const list = await call('/api/tasks', { token: crmToken });
    record(21.1, 'Task list', list.status === 200, `HTTP ${list.status}`);
  } else {
    record(21, 'Tasks', false, 'SKIPPED — no admin/chief session');
  }

  /* --------------------------------------------------------------- 22 */
  {
    const res = await call('/api/packages');
    const codes = (res.json?.data ?? []).map((p) => p.code);
    record(
      22,
      'Packages (4 tiers)',
      res.status === 200 &&
        ['BRONZE', 'SILVER', 'GOLD', 'ENTREPRENEUR'].every((c) => codes.includes(c)),
      `HTTP ${res.status} codes=${codes.join(',')}`,
    );
  }

  /* --------------------------------------------------------------- 23 */
  if (chiefToken) {
    const res = await call('/api/chief/payments', { token: chiefToken });
    record(23, 'Payments (chief)', res.status === 200, `HTTP ${res.status}`);
  } else {
    record(23, 'Payments', false, 'SKIPPED — no chief session');
  }

  /* --------------------------------------------------------------- 24 */
  if (chiefToken) {
    const res = await call('/api/chief/security/audit', { token: chiefToken });
    record(
      24,
      'Audit log',
      res.status === 200,
      `HTTP ${res.status} entries=${res.json?.data?.total ?? 'n/a'}`,
    );
  } else {
    record(24, 'Audit', false, 'SKIPPED — no chief session');
  }

  /* --------------------------------------------------------------- 25 */
  {
    const res = await call('/api/portal');
    record(
      25,
      'Portal configuration served from DB',
      res.status === 200 && Boolean(res.json?.data?.portalName),
      `HTTP ${res.status} portalName=${res.json?.data?.portalName ?? 'n/a'}`,
    );
  }

  /* --------------------------------------------------------------- 26 */
  {
    const demo = await call('/api/auth/demo', { method: 'POST' });
    const demoLogin = await call('/api/auth/login', {
      method: 'POST',
      body: { email: demo.json?.data?.email, password: demo.json?.data?.password },
    });
    const demoToken = demoLogin.json?.data?.token ?? '';
    const write = await call('/api/tasks', {
      method: 'POST',
      token: demoToken,
      body: { title: 'demo write attempt' },
    });
    record(
      26,
      'Demo account is read-only',
      demoLogin.status === 200 && write.status === 403,
      `login=${demoLogin.status} write=${write.status} ${write.json?.error?.code ?? ''}`,
    );
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed.`);
  if (failed.length) {
    console.log('\nFAILED / SKIPPED steps:');
    for (const f of failed) console.log(`  - ${String(f.step).padStart(4, ' ')} ${f.name}: ${f.detail}`);
    process.exit(1);
  }
  console.log('SMOKE TEST PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
