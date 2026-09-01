import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, seedActiveAdmin, seedChief, seedUser } from '../helpers/factory';

/**
 * §22/§57 RBAC matrix.
 * USER → ADMIN API = 403
 * ADMIN → CHIEF API = 403
 * DEMO → mutation API = 403
 * CHIEF → authorised master API = 200
 */
describe('RBAC matrix (§22, §57)', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  it('returns 401 for a protected API with no session (§57)', async () => {
    const cases = [
      '/api/chief/dashboard',
      '/api/admin/dashboard',
      '/api/crm/leads',
      '/api/tasks',
      '/api/ai/conversations',
      '/api/whatsapp/campaigns',
      '/api/auth/me',
    ];
    for (const path of cases) {
      const res = await api(path);
      expect(res.status, path).toBe(401);
      expect(res.body.error?.code, path).toBe('UNAUTHORIZED');
    }
  });

  it('blocks a USER from ADMIN and CHIEF APIs (§22)', async () => {
    const user = await seedUser('USER');
    const { body } = await login('user', user.email, user.password);
    const token = body.data!.token;

    expect((await api('/api/admin/dashboard', { token })).status).toBe(403);
    expect((await api('/api/admin/users', { token })).status).toBe(403);
    expect((await api('/api/chief/dashboard', { token })).status).toBe(403);
    expect((await api('/api/chief/admins', { token })).status).toBe(403);
    expect((await api('/api/chief/settings', { token })).status).toBe(403);
  });

  it('blocks an ADMIN from CHIEF APIs (§3, §22)', async () => {
    const admin = await seedActiveAdmin();
    const { body } = await login('admin', admin.email, admin.password);
    const token = body.data!.token;

    const denied = [
      '/api/chief/dashboard',
      '/api/chief/admins',
      '/api/chief/payments',
      '/api/chief/security/sessions',
      '/api/chief/audit',
      '/api/chief/settings',
    ];
    for (const path of denied) {
      const res = await api(path, { token });
      expect(res.status, path).toBe(403);
    }

    // …but the ADMIN's own operational surface works.
    expect((await api('/api/admin/dashboard', { token })).status).toBe(200);
    expect((await api('/api/admin/profile', { token })).status).toBe(200);
  });

  it('allows the CHIEF into the master control APIs (§23)', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const { body } = await login('chief', chief.email, chief.password);
    const token = body.data!.token;

    const allowed = [
      '/api/chief/dashboard',
      '/api/chief/admins',
      '/api/chief/payments',
      '/api/chief/users',
      '/api/chief/packages',
      '/api/chief/security/sessions',
      '/api/chief/security/audit',
      '/api/chief/settings',
      '/api/chief/password-resets',
      '/api/chief/ai/providers',
      '/api/chief/whatsapp/providers',
    ];
    for (const path of allowed) {
      const res = await api(path, { token });
      expect(res.status, path).toBe(200);
    }
  });

  it('treats DEMO as read-only everywhere (§39, §57)', async () => {
    const demo = await seedUser('DEMO_VIEWER', {
      password: 'DemoPass-12345',
      isDemo: true,
    });
    const { body } = await login('user', demo.email, demo.password);
    const token = body.data!.token;
    expect(token).toBeTruthy();

    const mutations: { method: string; path: string; body?: unknown }[] = [
      { method: 'POST', path: '/api/tasks', body: { title: 'demo task' } },
      { method: 'POST', path: '/api/crm/leads', body: { name: 'x', phone: '+919900000009' } },
      { method: 'POST', path: '/api/crm/contacts', body: { phone: '+919900000009' } },
      { method: 'DELETE', path: '/api/tasks/any' },
      { method: 'POST', path: '/api/ai/conversations', body: {} },
      { method: 'POST', path: '/api/whatsapp/messages', body: { to: '+919900000009', body: 'hi' } },
    ];

    for (const call of mutations) {
      const res = await api(call.path, { method: call.method, body: call.body, token });
      expect(res.status, `${call.method} ${call.path}`).toBe(403);
      expect(res.body.error?.code, `${call.method} ${call.path}`).toBe('DEMO_READ_ONLY');
    }

    // §39 demo may VIEW the AI interface. The response is an explicit read-only
    // notice: no LLM call, no quota spend and no data mutation — not a fake answer.
    const chat = await api('/api/ai/chat', { method: 'POST', body: { message: 'hello' }, token });
    expect(chat.status).toBe(200);
    expect(String((chat.body.data as { content: string })?.content)).toMatch(/read-only/i);
    const usage = await api('/api/ai/usage', { token });
    expect(usage.status).toBe(200);

    // Namespaces demo is not a member of at all are a plain 403.
    const outside = await api('/api/admin/payments', {
      method: 'POST',
      body: { packageId: 'x', amountCents: 1 },
      token,
    });
    expect(outside.status).toBe(403);
    expect(outside.body.error?.code).toBe('FORBIDDEN');
  });

  it('never trusts a role claimed by the client', async () => {
    const user = await seedUser('USER');
    const { body } = await login('user', user.email, user.password);
    const token = body.data!.token;

    // Role sent in the header AND the body; the server must use the DB row.
    const res = await api('/api/chief/dashboard', {
      token,
      headers: { 'x-user-role': 'SUPER_ADMIN', 'x-role': 'SUPER_ADMIN' },
    });
    expect(res.status).toBe(403);
  });
});
