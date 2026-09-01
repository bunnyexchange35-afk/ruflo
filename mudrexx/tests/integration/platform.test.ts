import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, seedActiveAdmin, seedChief, seedUser, testContainer } from '../helpers/factory';
import { PackageService } from '../../src/services/package-service';
import { SettingsService } from '../../src/services/settings-service';
import { DemoService } from '../../src/services/demo-service';

/** §15/§16 packages, §38 audit, §39 demo, §40 portal settings, §10 health. */
describe('platform services (§10, §15, §16, §38, §39, §40)', () => {
  beforeEach(async () => {
    await freshDatabase();
    await new PackageService(testContainer()).ensureDefaults();
  });

  /* ------------------------------- packages ------------------------------- */

  it('seeds the four canonical packages with billing periods (§15, §16)', async () => {
    const packages = await new PackageService(testContainer()).list();
    const codes = packages.map((p) => p.code);
    expect(codes).toEqual(expect.arrayContaining(['BRONZE', 'SILVER', 'GOLD', 'ENTREPRENEUR']));
    for (const pkg of packages) {
      expect(pkg.prices.length).toBeGreaterThan(0);
      expect(pkg.prices[0].period).toBe('MONTHLY');
    }
  });

  it('quotes a price for each billing period with add-ons (§16)', async () => {
    const service = new PackageService(testContainer());
    const gold = (await service.list()).find((p) => p.code === 'GOLD')!;

    // Configure through the Chief endpoint so the full route/service path is exercised.
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const chiefToken = (await login('chief', chief.email, chief.password)).body.data!.token;
    const configured = await api(`/api/chief/packages/${gold.id}`, {
      method: 'PUT',
      token: chiefToken,
      body: {
        prices: [
          { period: 'ANNUAL', priceCents: 9999900 },
          { period: 'MONTHLY', priceCents: 999900 },
        ],
        addons: [{ kind: 'ADDITIONAL_USER', unitPriceCents: 49900 }],
      },
    });
    expect(configured.status).toBe(200);

    const quote = await service.quote({
      packageId: gold.id,
      period: 'ANNUAL',
      addons: [{ kind: 'ADDITIONAL_USER', quantity: 3 }],
    });
    expect(quote.totalCents).toBe(9999900 + 3 * 49900);
    expect(quote.lines.length).toBe(2);
  });

  it('records market rates as a recommendation only — never auto-applies (§16)', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const token = (await login('chief', chief.email, chief.password)).body.data!.token;

    const packages = await new PackageService(testContainer()).list();
    const silver = packages.find((p) => p.code === 'SILVER')!;
    const before = (await new PackageService(testContainer()).list()).find((p) => p.code === 'SILVER')!;
    const beforePrice = before.prices.find((p) => p.period === 'MONTHLY')!.price_cents;

    const res = await api('/api/chief/packages/market-rate', {
      method: 'POST',
      token,
      body: { key: 'competitor:silver:monthly', valueCents: 600000, source: 'manual-audit' },
    });
    expect(res.status).toBe(200);
    const rec = res.body.data as { autoApplied: boolean; requiresChiefReview: boolean; suggestedCents: number };
    expect(rec.autoApplied).toBe(false);
    expect(rec.requiresChiefReview).toBe(true);
    expect(rec.suggestedCents).toBeLessThan(600000);

    // The published price is untouched until the Chief acts.
    const after = (await new PackageService(testContainer()).list()).find((p) => p.code === 'SILVER')!;
    expect(after.prices.find((p) => p.period === 'MONTHLY')!.price_cents).toBe(beforePrice);
    void silver;
  });

  /* ------------------------------ settings ------------------------------ */

  it('serves portal configuration from the database (§40)', async () => {
    const before = await api<{ portalName: string }>('/api/portal');
    expect(before.status).toBe(200);
    expect(before.body.data?.portalName).toBe('MUDREXX');

    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const token = (await login('chief', chief.email, chief.password)).body.data!.token;

    const updated = await api('/api/chief/settings', {
      method: 'PUT',
      token,
      body: { portalName: 'Mudrexx Control', browserTitle: 'Mudrexx Control — Portal' },
    });
    expect(updated.status).toBe(200);

    const after = await api<{ portalName: string; browserTitle: string }>('/api/portal');
    expect(after.body.data?.portalName).toBe('Mudrexx Control');
    expect(after.body.data?.browserTitle).toBe('Mudrexx Control — Portal');

    // Persisted, not hardcoded: re-reading through the service returns the same value.
    const persisted = await new SettingsService(testContainer()).getPortal();
    expect(persisted.portalName).toBe('Mudrexx Control');
  });

  it('rejects invalid portal configuration (§48)', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const token = (await login('chief', chief.email, chief.password)).body.data!.token;

    const res = await api('/api/chief/settings', {
      method: 'PUT',
      token,
      body: { portalName: '' },
    });
    expect(res.status).toBe(400);
  });

  /* -------------------------------- audit -------------------------------- */

  it('audits privileged actions (§38)', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const admin = await seedActiveAdmin();

    await login('admin', admin.email, admin.password);
    const chiefToken = (await login('chief', chief.email, chief.password)).body.data!.token;

    const audit = await api<{ rows: { action: string }[]; total: number }>('/api/chief/security/audit', {
      token: chiefToken,
    });
    expect(audit.status).toBe(200);

    const actions = (audit.body.data?.rows ?? []).map((r) => r.action);
    expect(actions).toContain('LOGIN_SUCCESS');
    expect(audit.body.data!.total).toBeGreaterThan(0);
  });

  it('never stores passwords or secrets in the audit log (§38)', async () => {
    const admin = await seedActiveAdmin();
    await login('admin', admin.email, admin.password);

    const rows = await testContainer().db.many<{ meta_json: string; action: string }>(
      `SELECT meta_json, action FROM audit_log`,
    );
    const blob = JSON.stringify(rows);
    for (const forbidden of ['PBKDF2-SHA256$', 'password', 'token_hash', 'RECOVERY_SECRET']) {
      expect(blob).not.toContain(forbidden);
    }
  });

  it('audits a password reset decision (§19, §38)', async () => {
    const user = await seedUser('USER');
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const chiefToken = (await login('chief', chief.email, chief.password)).body.data!.token;

    await api('/api/auth/password/reset-request', { method: 'POST', body: { email: user.email } });

    const pending = await api<{ id: string }[]>('/api/chief/password-resets', { token: chiefToken });
    const requestId = (pending.body.data ?? [])[0]?.id;
    expect(requestId).toBeTruthy();

    const approved = await api(`/api/chief/password-resets/${requestId}/approve`, {
      method: 'POST',
      token: chiefToken,
    });
    expect(approved.status).toBe(200);
    expect((approved.body.data as { token: string }).token).toBeTruthy();

    const audit = await testContainer().audit.list({ action: 'PASSWORD_RESET_APPROVED', limit: 10, offset: 0 });
    expect(audit.rows.length).toBe(1);
  });

  it('issues a single-use reset token that cannot be replayed (§20)', async () => {
    const user = await seedUser('USER');
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const chiefToken = (await login('chief', chief.email, chief.password)).body.data!.token;

    await api('/api/auth/password/reset-request', { method: 'POST', body: { email: user.email } });
    const pending = await api<{ id: string }[]>('/api/chief/password-resets', { token: chiefToken });
    const approved = await api<{ token: string }>(`/api/chief/password-resets/${(pending.body.data ?? [])[0].id}/approve`, {
      method: 'POST',
      token: chiefToken,
    });
    const token = approved.body.data!.token;

    const first = await api('/api/auth/password/reset', {
      method: 'POST',
      body: { token, newPassword: 'ResetPass-12345' },
    });
    expect(first.status).toBe(200);

    const replay = await api('/api/auth/password/reset', {
      method: 'POST',
      body: { token, newPassword: 'ResetPass-99999' },
    });
    expect(replay.status).toBe(422);
  });

  /* --------------------------------- demo --------------------------------- */

  it('provisions an isolated read-only demo account (§39)', async () => {
    const created = await api<{ email: string; password: string }>('/api/auth/demo', { method: 'POST' });
    expect(created.status).toBe(200);

    const loginRes = await login('user', created.body.data!.email, created.body.data!.password);
    expect(loginRes.status).toBe(200);

    const demoUser = (await testContainer().users.findByEmail(created.body.data!.email))!;
    expect(demoUser.role).toBe('DEMO_VIEWER');
    expect(demoUser.is_demo).toBe(1);

    // The demo dataset is scoped to the demo account's own id.
    const snapshot = await new DemoService(testContainer()).snapshot(demoUser);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.leads.total).toBeGreaterThan(0);

    // A production admin's CRM rows are never visible to the demo account.
    const admin = await seedActiveAdmin();
    await testContainer().leads.upsert({
      ownerAdminId: admin.user.id,
      name: 'Production Lead',
      phone: '+919900000777',
      source: 'API',
    });
    const isolated = await new DemoService(testContainer()).snapshot(demoUser);
    expect(
      isolated.leads.rows.some((l) => l.name === 'Production Lead'),
    ).toBe(false);
  });

  /* -------------------------------- health -------------------------------- */

  it('reports D1 health without exposing internals (§10)', async () => {
    const res = await api<{ database: string; tables: number; counts: Record<string, number> }>(
      '/api/health/db',
    );
    expect(res.status).toBe(200);
    expect(res.body.data?.database).toBe('d1');
    expect(res.body.data?.tables).toBeGreaterThan(25);
    expect(Object.keys(res.body.data?.counts ?? {}).sort()).toEqual([
      'activeSessions',
      'leads',
      'sessions',
      'users',
    ]);
  });
});
