import { SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { seedChief } from '../helpers/factory';

/**
 * §54 ROUTE REGRESSION TEST and §7 API vs SPA separation.
 *
 * - POST /api/auth/super-admin/login must never reach a generic /api/auth
 *   handler or the SPA fallback.
 * - GET /api/chief/dashboard must never return HTML.
 * - No unmatched /api/* path may ever return HTML.
 */
describe('route precedence and API/SPA separation (§6, §7, §54)', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  it('routes POST /api/auth/super-admin/login to the Chief handler, not a generic one', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const res = await SELF.fetch('https://test.mudrexx.local/api/auth/super-admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: chief.email, password: chief.password }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { user: { role: string } } };
    expect(body.success).toBe(true);
    // Proof of the specific handler: only the Chief login accepts SUPER_ADMIN.
    expect(body.data.user.role).toBe('SUPER_ADMIN');
  });

  it('never returns HTML from GET /api/chief/dashboard (§54, §7)', async () => {
    const res = await SELF.fetch('https://test.mudrexx.local/api/chief/dashboard', {
      headers: { accept: 'application/json' },
    });
    const contentType = res.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');
    expect(res.status).toBe(401);

    const text = await res.text();
    expect(text.trim().startsWith('<!doctype')).toBe(false);
    expect(text.trim().startsWith('<')).toBe(false);
  });

  it('returns JSON (not HTML) for every unmatched /api/* path', async () => {
    const paths = [
      '/api/does-not-exist',
      '/api/auth/nope',
      '/api/admin/whatever',
      '/api/chief/anything',
      '/api/crm/x',
      '/api/tasks/x',
      '/api/ai/x',
    ];
    for (const path of paths) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
        const res = await SELF.fetch(`https://test.mudrexx.local${path}`, { method });
        const contentType = res.headers.get('content-type') ?? '';
        // The hard guarantee: an API path NEVER returns HTML.
        expect(contentType, `${method} ${path}`).toContain('application/json');
        const body = (await res.json()) as { success: boolean; error: { code: string } };
        expect(body.success, `${method} ${path}`).toBe(false);
        expect(['NOT_FOUND', 'UNAUTHORIZED'], `${method} ${path}`).toContain(body.error.code);
      }
    }
  });

  it('answers 404 (not 401) for unknown API paths when authenticated', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const res = await SELF.fetch('https://test.mudrexx.local/api/auth/super-admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: chief.email, password: chief.password }),
    });
    const { data } = (await res.json()) as { data: { token: string } };

    for (const path of ['/api/does-not-exist', '/api/chief/anything', '/api/admin/whatever']) {
      const missing = await SELF.fetch(`https://test.mudrexx.local${path}`, {
        headers: { authorization: `Bearer ${data.token}` },
      });
      expect(missing.status, path).toBe(404);
      const body = (await missing.json()) as { error: { code: string } };
      expect(body.error.code, path).toBe('NOT_FOUND');
    }
  });

  it('serves the browser fallback only for non-API paths (§7)', async () => {
    const res = await SELF.fetch('https://test.mudrexx.local/admin/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
  });

  it('does not let the SPA fallback swallow a nested API route', async () => {
    // A deep API path under a namespace that exists must still be JSON.
    const res = await SELF.fetch('https://test.mudrexx.local/api/auth/admin/login/deep/missing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
  });

  it('keeps the health namespace public and specific (§10)', async () => {
    const health = await SELF.fetch('https://test.mudrexx.local/api/health');
    expect(health.status).toBe(200);

    const db = await SELF.fetch('https://test.mudrexx.local/api/health/db');
    expect(db.status).toBe(200);
    const body = (await db.json()) as {
      success: boolean;
      data: { database: string; tables: number; counts: Record<string, number> };
    };
    expect(body.success).toBe(true);
    expect(body.data.database).toBe('d1');
    expect(body.data.tables).toBeGreaterThan(20);
    expect(Object.keys(body.data.counts).join(',')).not.toMatch(/password|token|secret|dsn/i);
  });

  it('never leaks credentials or secrets in the DB health payload (§10)', async () => {
    const res = await SELF.fetch('https://test.mudrexx.local/api/health/db');
    const raw = await res.text();
    for (const forbidden of ['RECOVERY_SECRET', 'API_KEY', 'password_hash', 'token_hash', 'BEGIN PRIVATE']) {
      expect(raw).not.toContain(forbidden);
    }
  });
});
