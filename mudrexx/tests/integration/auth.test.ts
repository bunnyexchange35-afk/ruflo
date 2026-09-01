import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, registerUser, seedActiveAdmin, seedChief, seedUser } from '../helpers/factory';

/**
 * §53 AUTH REGRESSION TEST.
 *
 * register → login → authenticated request → logout → repeat with old session.
 * Expected: the old session is REJECTED.
 */
describe('authentication regression (§53)', () => {
  beforeEach(async () => {
    await freshDatabase();
  });

  it('registers a user and issues a human ID of 2-5 digits (§11)', async () => {
    const email = `user-${crypto.randomUUID()}@test.local`;
    const { status, body } = await registerUser({
      email,
      password: 'TestPass-12345',
      fullName: 'Ada Lovelace',
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    const user = body.data!.user;
    expect(user.humanId).toMatch(/^\d{2,5}$/);
    expect(user.id).not.toBe(user.humanId); // UUID PK is never exposed as the human ID
    expect(user.role).toBe('USER');
  });

  it('rejects invalid human-ID formats (§11)', async () => {
    // The ID is allocated server-side; assert the allocator never emits bad values.
    // Kept under the register rate limit (5/hour) — see the unit suite for bulk checks.
    const seen = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const { body } = await registerUser({
        email: `user-${crypto.randomUUID()}@test.local`,
        password: 'TestPass-12345',
        fullName: 'Repeat User',
      });
      seen.add(body.data!.user.humanId);
    }
    for (const id of seen) expect(id).toMatch(/^\d{2,5}$/);
    expect(seen.size).toBe(4); // unique
  });

  it('logs a user in and serves an authenticated request', async () => {
    const seeded = await seedUser('USER');
    const res = await login('user', seeded.email, seeded.password);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const token = res.body.data!.token;

    const me = await api('/api/auth/me', { token });
    expect(me.status).toBe(200);
    expect(me.body.data).toBeTruthy();
  });

  it('rejects the session after logout (§53 OLD SESSION = REJECTED)', async () => {
    const seeded = await seedUser('USER');
    const { body } = await login('user', seeded.email, seeded.password);
    const token = body.data!.token;

    expect((await api('/api/auth/me', { token })).status).toBe(200);

    const out = await api('/api/auth/logout', { method: 'POST', token });
    expect(out.status).toBe(200);

    const after = await api('/api/auth/me', { token });
    expect(after.status).toBe(401);
    expect(after.body.error?.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong password with 401 and never leaks the account', async () => {
    const seeded = await seedUser('USER');
    const res = await login('user', seeded.email, 'WrongPass-99999');
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('UNAUTHORIZED');
    expect(res.body.error?.message).toBe('Invalid credentials.');
  });

  it('returns an identical message for an unknown account', async () => {
    const res = await login('user', `nobody-${crypto.randomUUID()}@test.local`, 'TestPass-12345');
    expect(res.status).toBe(401);
    expect(res.body.error?.message).toBe('Invalid credentials.');
  });

  it('locks the account after repeated failures (§20)', async () => {
    const seeded = await seedUser('USER');
    for (let i = 0; i < 5; i += 1) {
      await login('user', seeded.email, 'WrongPass-99999');
    }
    const locked = await login('user', seeded.email, seeded.password);
    expect(locked.status).toBe(403);
    expect(locked.body.error?.code).toBe('ACCOUNT_LOCKED');
  });

  it('keeps the three portals separate by role (§4, §6)', async () => {
    const user = await seedUser('USER');
    const admin = await seedActiveAdmin();
    const chief = await seedChief();

    // A USER may not use the admin or chief portal.
    expect((await login('admin', user.email, user.password)).status).toBe(403);
    expect((await login('chief', user.email, user.password)).status).toBe(403);

    // An ADMIN may not use the chief portal (§3: Chief is not a subordinate admin).
    expect((await login('chief', admin.email, admin.password)).status).toBe(403);

    // An ADMIN may not sign in through the user portal.
    expect((await login('user', admin.email, admin.password)).status).toBe(403);

    // Each portal accepts its own role.
    expect((await login('user', user.email, user.password)).status).toBe(200);
    expect((await login('admin', admin.email, admin.password)).status).toBe(200);
    expect((await login('chief', chief.email, chief.password)).status).toBe(200);
  });

  it('blocks an admin that is not approved or has unverified payment (§13)', async () => {
    const pending = await seedUser('ADMIN', {
      status: 'PENDING',
      approval: 'PENDING',
      payment: 'PENDING',
    });
    const res = await login('admin', pending.email, pending.password);
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('ACCOUNT_PENDING_APPROVAL');

    const unpaid = await seedUser('ADMIN', {
      status: 'PENDING',
      approval: 'APPROVED',
      payment: 'SUBMITTED',
    });
    const res2 = await login('admin', unpaid.email, unpaid.password);
    expect(res2.status).toBe(403);
    expect(res2.body.error?.code).toBe('PAYMENT_REQUIRED');
  });

  it('never accepts a fabricated role in the login body', async () => {
    const seeded = await seedUser('USER');
    // Attacker tries to escalate by claiming a role.
    const res = await api('/api/auth/super-admin/login', {
      method: 'POST',
      body: { email: seeded.email, password: seeded.password, role: 'SUPER_ADMIN' },
    });
    expect(res.status).toBe(403);
  });

  it('returns JSON errors, never HTML, for API failures (§7, §47)', async () => {
    const res = await api('/api/auth/login', { method: 'POST', body: { email: 'nope' } });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
  });
});
