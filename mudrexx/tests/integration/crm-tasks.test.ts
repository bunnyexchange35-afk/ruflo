import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, seedActiveAdmin, testContainer } from '../helpers/factory';
import { PackageService } from '../../src/services/package-service';

/** §24 CRM master lead controller, §34/§36/§37 tasks. */
describe('CRM and task management (§24, §34, §36, §37)', () => {
  beforeEach(async () => {
    await freshDatabase();
    await new PackageService(testContainer()).ensureDefaults();
  });

  async function adminToken() {
    const admin = await seedActiveAdmin();
    const { body } = await login('admin', admin.email, admin.password);
    return { token: body.data!.token, admin };
  }

  it('keeps one canonical lead per person across sources (§24)', async () => {
    const { token } = await adminToken();
    const phone = '+919900000077';

    const fromWebsite = await api('/api/crm/leads', {
      method: 'POST',
      token,
      body: { name: 'Riya Sen', phone, source: 'WEBSITE', score: 40 },
    });
    expect(fromWebsite.status).toBe(201);
    expect((fromWebsite.body.data as { created: boolean }).created).toBe(true);

    const fromWhatsapp = await api('/api/crm/leads', {
      method: 'POST',
      token,
      body: { name: 'Riya Sen', phone, source: 'WHATSAPP', score: 90 },
    });
    expect(fromWhatsapp.status).toBe(201);
    expect((fromWhatsapp.body.data as { created: boolean }).created).toBe(false);

    const list = await api<{ total: number }>('/api/crm/leads', { token });
    expect((list.body.data as { total: number }).total).toBe(1);
  });

  it('normalises and validates phone numbers on ingest (§31)', async () => {
    const { token } = await adminToken();
    const ok = await api('/api/crm/leads', {
      method: 'POST',
      token,
      body: { name: 'Normalised', phone: '+91 99000 00078', source: 'IMPORT' },
    });
    expect(ok.status).toBe(201);

    const bad = await api('/api/crm/leads', {
      method: 'POST',
      token,
      body: { name: 'Bad', phone: 'not-a-phone', source: 'IMPORT' },
    });
    expect(bad.status).toBe(400);
  });

  it('reports CSV import results row by row, including duplicates (§31)', async () => {
    const { token } = await adminToken();
    const csv = [
      'name,phone,email',
      'Alpha,+919900000001,a@test.local',
      'Beta,+919900000002,b@test.local',
      'Gamma,+919900000001,c@test.local', // duplicate phone within the file
      'Delta,,d@test.local', // missing phone
    ].join('\n');

    const res = await api('/api/crm/contacts/import', {
      method: 'POST',
      token,
      body: { csv, markOptIn: true },
    });
    expect(res.status).toBe(200);

    const report = res.body.data as {
      total: number;
      imported: number;
      duplicates: number;
      invalid: number;
      errors: { row: number; reason: string }[];
    };
    expect(report.total).toBe(4);
    expect(report.imported).toBe(2);
    expect(report.duplicates).toBe(1);
    expect(report.invalid).toBe(1);
    expect(report.errors[0].reason).toMatch(/phone/i);
  });

  it('enforces the package lead limit server-side (§15)', async () => {
    const { token, admin } = await adminToken();
    const packages = await new PackageService(testContainer()).list();
    const bronze = packages.find((p) => p.code === 'BRONZE')!;
    await testContainer().users.update(admin.user.id, { package_id: bronze.id });

    // BRONZE ships with a 1000-lead allowance; shrink it to 1 to prove enforcement.
    await testContainer().packages.update(bronze.id, { limits: { leadLimit: 1 } });

    const first = await api('/api/crm/leads', {
      method: 'POST',
      token,
      body: { name: 'One', phone: '+919900000101', source: 'API' },
    });
    expect(first.status).toBe(201);

    const second = await api('/api/crm/leads', {
      method: 'POST',
      token,
      body: { name: 'Two', phone: '+919900000102', source: 'API' },
    });
    expect(second.status).toBe(403);
    expect((second.body.error?.details as { code: string })?.code).toBe('PACKAGE_LIMIT_REACHED');
  });

  /* ------------------------------- tasks ------------------------------- */

  it('creates a manual task and refuses a silent duplicate (§34, §37)', async () => {
    const { token } = await adminToken();
    const payload = { title: 'Call lead', description: 'Intro call', priority: 'HIGH' };

    const first = await api('/api/tasks', { method: 'POST', token, body: payload });
    expect(first.status).toBe(201);
    expect((first.body.data as { created: boolean }).created).toBe(true);

    const second = await api('/api/tasks', { method: 'POST', token, body: payload });
    expect(second.status).toBe(201);
    expect((second.body.data as { created: boolean }).created).toBe(false);
  });

  it('assigns a task by name, phone or user id (§34)', async () => {
    const { token } = await adminToken();
    const byName = await api('/api/tasks', {
      method: 'POST',
      token,
      body: { title: 'ByName', assignedName: 'Someone' },
    });
    expect(byName.status).toBe(201);

    const byPhone = await api('/api/tasks', {
      method: 'POST',
      token,
      body: { title: 'ByPhone', assignedPhone: '+919900000555' },
    });
    expect(byPhone.status).toBe(201);
  });

  it('plans a bulk assignment by joining date and separates duplicates (§36, §37)', async () => {
    const { token } = await adminToken();
    const c = testContainer();

    // Two fresh users; give one of them the task already.
    const u1 = await c.users.create({
      email: `j1-${crypto.randomUUID()}@test.local`,
      passwordHash: 'x',
      role: 'USER',
      fullName: 'Joined One',
      status: 'ACTIVE',
    });
    const u2 = await c.users.create({
      email: `j2-${crypto.randomUUID()}@test.local`,
      passwordHash: 'x',
      role: 'USER',
      fullName: 'Joined Two',
      status: 'ACTIVE',
    });

    await api('/api/tasks', {
      method: 'POST',
      token,
      body: { title: 'Welcome call', assignedUserId: u1.id },
    });

    const plan = await api('/api/tasks/bulk/plan', {
      method: 'POST',
      token,
      body: { title: 'Welcome call', filter: { preset: 'today' } },
    });
    expect(plan.status).toBe(200);

    const result = plan.body.data as {
      totalCandidates: number;
      newCount: number;
      duplicateCount: number;
      alreadyAssigned: { userId: string }[];
      newAssignments: { userId: string }[];
      requiresConfirmation: boolean;
    };

    expect(result.requiresConfirmation).toBe(true);
    expect(result.totalCandidates).toBe(2);
    expect(result.duplicateCount).toBe(1);
    expect(result.alreadyAssigned[0].userId).toBe(u1.id);
    expect(result.newAssignments[0].userId).toBe(u2.id);
  });

  it('requires confirmation before bulk assignment (§36)', async () => {
    const { token } = await adminToken();
    const c = testContainer();
    const u = await c.users.create({
      email: `confirm-${crypto.randomUUID()}@test.local`,
      passwordHash: 'x',
      role: 'USER',
      fullName: 'Confirm Me',
      status: 'ACTIVE',
    });

    const withoutConfirm = await api('/api/tasks/bulk/assign', {
      method: 'POST',
      token,
      body: { title: 'Needs confirm', userIds: [u.id], confirm: false },
    });
    expect(withoutConfirm.status).toBe(409);
    expect(withoutConfirm.body.error?.code).toBe('CONFIRMATION_REQUIRED');

    const withConfirm = await api('/api/tasks/bulk/assign', {
      method: 'POST',
      token,
      body: { title: 'Needs confirm', userIds: [u.id], confirm: true },
    });
    expect(withConfirm.status).toBe(200);
    expect((withConfirm.body.data as { createdCount: number }).createdCount).toBe(1);

    // Running it again skips the duplicate instead of duplicating.
    const again = await api('/api/tasks/bulk/assign', {
      method: 'POST',
      token,
      body: { title: 'Needs confirm', userIds: [u.id], confirm: true },
    });
    expect((again.body.data as { createdCount: number; skippedCount: number }).createdCount).toBe(0);
    expect((again.body.data as { createdCount: number; skippedCount: number }).skippedCount).toBe(1);
  });

  it('supports preset and custom joining-date ranges (§36)', async () => {
    const { token } = await adminToken();
    for (const preset of ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month']) {
      const res = await api('/api/tasks/bulk/plan', {
        method: 'POST',
        token,
        body: { title: `range-${preset}`, filter: { preset } },
      });
      expect(res.status, preset).toBe(200);
    }

    const badRange = await api('/api/tasks/bulk/plan', {
      method: 'POST',
      token,
      body: { title: 'bad', filter: { preset: 'custom', from: '2026-05-02', to: '2026-05-01' } },
    });
    expect(badRange.status).toBe(400);
  });
});
