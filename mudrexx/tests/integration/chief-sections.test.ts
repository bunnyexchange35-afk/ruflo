import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, seedActiveAdmin, seedChief, seedUser } from '../helpers/factory';

/**
 * §23 The Chief Control Portal is divided into two parts: RUFLO and MUDREXX.
 *
 * These tests assert the split exists, that each part reports real counts from
 * its own tables, that no provider key is ever leaked, and that the section
 * routes are protected by exactly the same SUPER_ADMIN gate as the rest of
 * /api/chief/*.
 */
describe('Chief Control Portal sections — RUFLO + MUDREXX (§23)', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  async function chiefToken() {
    const chief = await seedChief();
    const { body } = await login('chief', chief.email, chief.password);
    return body.data!.token as string;
  }

  it('lists exactly two parts: RUFLO and MUDREXX', async () => {
    const token = await chiefToken();
    const res = await api('/api/chief/sections', { token });

    expect(res.status).toBe(200);
    const sections = res.body.data as { id: string; name: string; routes: string[] }[];
    expect(sections).toHaveLength(2);
    expect(sections.map((s) => s.id)).toEqual(['ruflo', 'mudrexx']);
    expect(sections.map((s) => s.name)).toEqual(['RUFLO', 'MUDREXX']);
    for (const s of sections) {
      expect(Array.isArray(s.routes)).toBe(true);
      expect(s.routes.length).toBeGreaterThan(0);
    }
  });

  it('exposes both parts on the Chief dashboard', async () => {
    const token = await chiefToken();
    const res = await api('/api/chief/dashboard', { token });

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, any>;
    expect(data.portal).toBe('CHIEF_CONTROL');
    expect(Object.keys(data.sections)).toEqual(['ruflo', 'mudrexx']);
    expect(data.sections.ruflo.name).toBe('RUFLO');
    expect(data.sections.mudrexx.name).toBe('MUDREXX');
    // The pre-existing dashboard contract is preserved.
    expect(data.counts).toBeDefined();
    expect(Array.isArray(data.recentAudit)).toBe(true);
  });

  it('MUDREXX part reports real business/CRM counts', async () => {
    const token = await chiefToken();
    const res = await api('/api/chief/sections/mudrexx', { token });

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, any>;
    expect(data.id).toBe('mudrexx');
    for (const key of [
      'users',
      'admins',
      'activeSessions',
      'payments',
      'contacts',
      'leads',
      'tasks',
      'campaigns',
      'whatsappMessages',
    ]) {
      expect(typeof data.counts[key], key).toBe('number');
      expect(data.counts[key], key).toBeGreaterThanOrEqual(0);
    }
    expect(typeof data.pending.adminApprovals).toBe('number');
    expect(typeof data.pending.paymentVerifications).toBe('number');
  });

  it('MUDREXX admin count tracks a real admin being seeded', async () => {
    const token = await chiefToken();
    const before = await api('/api/chief/sections/mudrexx', { token });
    const beforeAdmins = (before.body.data as any).counts.admins;

    await seedActiveAdmin();

    const after = await api('/api/chief/sections/mudrexx', { token });
    expect((after.body.data as any).counts.admins).toBe(beforeAdmins + 1);
  });

  it('RUFLO part reports AI/agent counts and provider presence only', async () => {
    const token = await chiefToken();
    const res = await api('/api/chief/sections/ruflo', { token });

    expect(res.status).toBe(200);
    const data = res.body.data as Record<string, any>;
    expect(data.id).toBe('ruflo');

    for (const key of ['conversations', 'messages', 'skills', 'activeSkills', 'toolCalls']) {
      expect(typeof data.counts[key], key).toBe('number');
    }
    expect(typeof data.pending.toolApprovals).toBe('number');
    for (const key of ['calls', 'tokensIn', 'tokensOut', 'costMicros']) {
      expect(typeof data.usage[key], key).toBe('number');
    }

    // §45 providers are reported as name + configured boolean, never a key.
    expect(Array.isArray(data.providers)).toBe(true);
    for (const p of data.providers) {
      expect(Object.keys(p).sort()).toEqual(['configured', 'name']);
      expect(typeof p.configured).toBe('boolean');
    }
    // No API key is configured in the test env, so this is honestly reported.
    expect(data.counts.providersConfigured).toBe(0);

    // Defence in depth: nothing key-shaped anywhere in the payload.
    expect(JSON.stringify(data)).not.toMatch(/sk-|api[_-]?key["']?\s*:\s*["'][^"']{8}/i);
  });

  it('both section routes are SUPER_ADMIN only (§22, §23)', async () => {
    const paths = ['/api/chief/sections', '/api/chief/sections/ruflo', '/api/chief/sections/mudrexx'];

    // no session
    for (const path of paths) {
      expect((await api(path)).status, path).toBe(401);
    }

    // USER
    const user = await seedUser('USER');
    const userToken = (await login('user', user.email, user.password)).body.data!.token;
    for (const path of paths) {
      expect((await api(path, { token: userToken })).status, path).toBe(403);
    }

    // ADMIN — the Chief is not a superior of Admin; Admin gets 403 here too.
    const admin = await seedActiveAdmin();
    const adminToken = (await login('admin', admin.email, admin.password)).body.data!.token;
    for (const path of paths) {
      expect((await api(path, { token: adminToken })).status, path).toBe(403);
    }
  });

  it('section routes are never swallowed by a parameterised chief route (§6, §54)', async () => {
    const token = await chiefToken();
    // /sections must not be resolved as /admins/:id or any other :id pattern.
    const res = await api('/api/chief/sections/ruflo', { token });
    expect(res.status).toBe(200);
    expect((res.body.data as any).id).toBe('ruflo');
    // An unknown section is a JSON 404, not HTML and not a silent fallback.
    const unknown = await api('/api/chief/sections/does-not-exist', { token });
    expect(unknown.status).toBe(404);
  });
});
