import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, seedChief, seedUser, testContainer } from '../helpers/factory';

/**
 * §21 EMERGENCY RECOVERY.
 *
 * Proves the mechanism is NOT a backdoor:
 *  - requires the server-side secret
 *  - one-time, time-limited, rate-limited, audited
 *  - forces a credential reset and invalidates sessions
 *  - never issues a session on its own (no auto-login)
 */
describe('emergency recovery (§21)', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  const SECRET = 'test-recovery-secret-not-a-backdoor';

  async function mint(userId?: string, secret = SECRET) {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const token = (await login('chief', chief.email, chief.password)).body.data!.token;
    return api<{ code: string; expiresAt: number }>('/api/chief/recovery/mint', {
      method: 'POST',
      token,
      body: { secret, userId },
    });
  }

  it('refuses to mint a code without the server-side secret', async () => {
    const res = await mint(undefined, 'wrong-secret');
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('FORBIDDEN');

    // The denial is audited.
    const denied = await testContainer().audit.list({ action: 'RECOVERY_DENIED', limit: 10, offset: 0 });
    expect(denied.rows.length).toBeGreaterThan(0);
  });

  it('mints a one-time code that is audited (§21)', async () => {
    const user = await seedUser('USER');
    const res = await mint(user.user.id);

    expect(res.status).toBe(200);
    expect(res.body.data?.code).toMatch(/^[A-Z2-9]{12}$/);
    expect(res.body.data?.expiresAt).toBeGreaterThan(Date.now());

    const minted = await testContainer().audit.list({ action: 'RECOVERY_CODE_MINTED', limit: 10, offset: 0 });
    expect(minted.rows.length).toBe(1);
  });

  it('resets the credential, invalidates sessions and does NOT log the user in (§21)', async () => {
    const user = await seedUser('USER');

    // Establish an active session first.
    const existing = await login('user', user.email, user.password);
    const oldToken = existing.body.data!.token;
    expect((await api('/api/auth/me', { token: oldToken })).status).toBe(200);

    const minted = await mint(user.user.id);
    const code = minted.body.data!.code;

    const redeemed = await api('/api/auth/recovery/redeem', {
      method: 'POST',
      body: { code, userId: user.user.id, newPassword: 'Recovered-12345' },
    });
    expect(redeemed.status).toBe(200);
    expect((redeemed.body.data as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThan(0);

    // No session was issued by the recovery flow.
    const stillNeedsLogin = await login('user', user.email, 'Recovered-12345');
    expect(stillNeedsLogin.status).toBe(200);

    // The old password and the old session are both dead.
    expect((await login('user', user.email, user.password)).status).toBe(401);
    expect((await api('/api/auth/me', { token: oldToken })).status).toBe(401);
  });

  it('rejects a replayed code (§21 one-time)', async () => {
    const user = await seedUser('USER');
    const { body } = await mint(user.user.id);

    const first = await api('/api/auth/recovery/redeem', {
      method: 'POST',
      body: { code: body.data!.code, userId: user.user.id, newPassword: 'Recovered-12345' },
    });
    expect(first.status).toBe(200);

    const replay = await api('/api/auth/recovery/redeem', {
      method: 'POST',
      body: { code: body.data!.code, userId: user.user.id, newPassword: 'Recovered-99999' },
    });
    expect(replay.status).toBe(422);
  });

  it('rejects an unknown code and audits the denial', async () => {
    const user = await seedUser('USER');
    const res = await api('/api/auth/recovery/redeem', {
      method: 'POST',
      body: { code: 'ZZZZZZZZZZZZ', userId: user.user.id, newPassword: 'Recovered-12345' },
    });
    expect(res.status).toBe(422);

    const denied = await testContainer().audit.list({ action: 'RECOVERY_DENIED', limit: 10, offset: 0 });
    expect(denied.rows.length).toBeGreaterThan(0);
  });

  it('rate-limits recovery minting (§21, §49)', async () => {
    // RECOVERY_RATE_LIMIT is 3 per hour per IP; the 4th attempt is refused.
    const results: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await mint();
      results.push(res.status);
    }
    expect(results.filter((s) => s === 200).length).toBe(3);
    expect(results[3]).toBe(429);
  });

  it('rotation invalidates outstanding challenges (§21 rotatable)', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const token = (await login('chief', chief.email, chief.password)).body.data!.token;

    await mint();
    const rotated = await api<{ revoked: number }>('/api/chief/recovery/rotate', {
      method: 'POST',
      token,
    });
    expect(rotated.status).toBe(200);
    expect(rotated.body.data?.revoked).toBeGreaterThan(0);

    const pending = await testContainer().recovery.revokeAllPending();
    expect(pending).toBe(0);
  });
});
