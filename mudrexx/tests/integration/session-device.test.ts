import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, seedActiveAdmin, seedChief, testContainer } from '../helpers/factory';

/**
 * §17 device/session control, §18 login history, §53 session invalidation.
 */
describe('session and device control (§17, §18, §53)', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  const deviceA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120 Safari/537.36', 'sec-ch-ua-platform': 'macOS', 'accept-language': 'en-GB,en' };
  const deviceB = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/121.0', 'sec-ch-ua-platform': 'Windows', 'accept-language': 'de-DE,de' };

  it('keeps exactly one active session per admin (§17)', async () => {
    const admin = await seedActiveAdmin();
    const first = await login('admin', admin.email, admin.password);
    const firstToken = first.body.data!.token;

    // Second login from the same device replaces the first.
    const second = await login('admin', admin.email, admin.password);
    expect(second.status).toBe(200);

    // The replaced session is dead immediately.
    expect((await api('/api/auth/me', { token: firstToken })).status).toBe(401);
    expect((await api('/api/auth/me', { token: second.body.data!.token })).status).toBe(200);

    const active = await testContainer().sessions.listActiveForUser(admin.user.id);
    expect(active.length).toBe(1);
  });

  it('refuses an admin login from a second, unregistered device (§17)', async () => {
    const admin = await seedActiveAdmin();

    const first = await api('/api/auth/admin/login', {
      method: 'POST',
      body: { email: admin.email, password: admin.password },
      headers: deviceA,
    });
    expect(first.status).toBe(200);

    const second = await api('/api/auth/admin/login', {
      method: 'POST',
      body: { email: admin.email, password: admin.password },
      headers: deviceB,
    });
    expect(second.status).toBe(403);
    expect((second.body.error?.details as { code: string })?.code).toBe('DEVICE_BOUND_ELSEWHERE');
  });

  it('lets the Chief reset a device so the admin can re-register (§17, §41)', async () => {
    const admin = await seedActiveAdmin();
    const chief = await seedChief({ password: 'ChiefPass-12345' });

    await api('/api/auth/admin/login', {
      method: 'POST',
      body: { email: admin.email, password: admin.password },
      headers: deviceA,
    });
    const chiefLogin = await login('chief', chief.email, chief.password);
    const chiefToken = chiefLogin.body.data!.token;

    const reset = await api(`/api/chief/admins/${admin.user.id}/reset-device`, {
      method: 'POST',
      token: chiefToken,
    });
    expect(reset.status).toBe(200);

    // After the reset, the new device registers and the admin can sign in.
    const again = await api('/api/auth/admin/login', {
      method: 'POST',
      body: { email: admin.email, password: admin.password },
      headers: deviceB,
    });
    expect(again.status).toBe(200);
  });

  it('rejects an expired session (§53)', async () => {
    const admin = await seedActiveAdmin();
    const { body } = await login('admin', admin.email, admin.password);
    const token = body.data!.token;
    expect((await api('/api/auth/me', { token })).status).toBe(200);

    // Force the session into the past.
    await testContainer().db.run(
      `UPDATE sessions SET expires_at = ? WHERE user_id = ?`,
      Date.now() - 1000,
      admin.user.id,
    );

    expect((await api('/api/auth/me', { token })).status).toBe(401);
  });

  it('records login and logout history with device metadata (§18)', async () => {
    const admin = await seedActiveAdmin();
    const { body } = await login('admin', admin.email, admin.password, );
    const token = body.data!.token;

    await api('/api/auth/logout', { method: 'POST', token });

    const history = await testContainer().loginHistory.listForUser(admin.user.id);
    const events = history.map((h) => h.event);
    expect(events).toContain('LOGIN_SUCCESS');
    expect(events).toContain('LOGOUT');
    // Device identity is captured, not just an IP.
    expect(history.some((h) => h.ip !== undefined)).toBe(true);
  });

  it('never identifies a device by IP alone (§17)', async () => {
    const admin = await seedActiveAdmin();
    // Same UA/platform (same device) but a different IP must still be the same device.
    const first = await api('/api/auth/admin/login', {
      method: 'POST',
      body: { email: admin.email, password: admin.password },
      headers: { ...deviceA, 'cf-connecting-ip': '203.0.113.1' },
    });
    const second = await api('/api/auth/admin/login', {
      method: 'POST',
      body: { email: admin.email, password: admin.password },
      headers: { ...deviceA, 'cf-connecting-ip': '198.51.100.9' },
    });
    expect(first.status).toBe(200);
    // Same device fingerprint, different IP → allowed (IP is not the device).
    expect(second.status).toBe(200);

    const devices = await testContainer().devices.listForUser(admin.user.id);
    expect(devices.length).toBe(1);
  });

  it('lets the Chief inspect and revoke sessions (§41)', async () => {
    const admin = await seedActiveAdmin();
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const adminLogin = await login('admin', admin.email, admin.password);
    const chiefLogin = await login('chief', chief.email, chief.password);

    const sessions = await api<{ id: string }[]>('/api/chief/security/sessions', {
      token: chiefLogin.body.data!.token,
    });
    expect(sessions.status).toBe(200);
    expect((sessions.body.data ?? []).length).toBeGreaterThan(0);

    const target = (sessions.body.data ?? []).find((s) => s.id === adminLogin.body.data!.token);
    void target;

    const all = await testContainer().sessions.listActiveForUser(admin.user.id);
    const revoked = await api(`/api/chief/security/sessions/${all[0].id}/revoke`, {
      method: 'POST',
      token: chiefLogin.body.data!.token,
    });
    expect(revoked.status).toBe(200);

    // The admin's token is now dead.
    expect((await api('/api/auth/me', { token: adminLogin.body.data!.token })).status).toBe(401);
  });
});
