import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase } from '../helpers/db';
import { api, login, seedChief, seedUser, testContainer } from '../helpers/factory';
import { PackageService } from '../../src/services/package-service';

/**
 * §12 admin management, §13 approval chain, §14 payment control.
 */
describe('admin approval and payment control (§12, §13, §14)', () => {
  beforeEach(async () => {
    await freshDatabase();
    await new PackageService(testContainer()).ensureDefaults();
  });

  it('registers an admin into PENDING with an admin ID, never auto-approved (§13)', async () => {
    const email = `newadmin-${crypto.randomUUID()}@test.local`;
    const res = await api('/api/admin/register', {
      method: 'POST',
      body: { email, password: 'AdminPass-12345', fullName: 'New Admin', businessName: 'Acme' },
    });

    expect(res.status).toBe(201);
    const data = res.body.data as {
      adminId: string;
      canLogin: boolean;
      approvalStatus: string;
      paymentStatus: string;
      status: string;
    };
    expect(data.adminId).toMatch(/^\d{2,5}$/);
    expect(data.canLogin).toBe(false);
    expect(data.approvalStatus).toBe('PENDING');
    expect(data.paymentStatus).toBe('PENDING');
    expect(data.status).toBe('PENDING');
  });

  it('blocks login until payment is verified AND approval granted (§13)', async () => {
    const email = `chain-${crypto.randomUUID()}@test.local`;
    await api('/api/admin/register', {
      method: 'POST',
      body: { email, password: 'AdminPass-12345', fullName: 'Chain Admin' },
    });

    // 1. Not approved → cannot log in.
    let attempt = await login('admin', email, 'AdminPass-12345');
    expect(attempt.status).toBe(403);

    const c = testContainer();
    const admin = (await c.users.findByEmail(email))!;

    // 2. Approved but payment not verified → still blocked on payment.
    await c.users.update(admin.id, { approval_status: 'APPROVED' });
    attempt = await login('admin', email, 'AdminPass-12345');
    expect(attempt.status).toBe(403);
    expect(attempt.body.error?.code).toBe('PAYMENT_REQUIRED');

    // 3. Payment verified → account activates and login succeeds.
    await c.users.update(admin.id, { payment_status: 'VERIFIED', status: 'ACTIVE' });
    attempt = await login('admin', email, 'AdminPass-12345');
    expect(attempt.status).toBe(200);
  });

  it('walks the full payment lifecycle under Chief control (§14)', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const chiefLogin = await login('chief', chief.email, chief.password);
    const chiefToken = chiefLogin.body.data!.token;

    const admin = await seedUser('ADMIN', { status: 'PENDING', approval: 'PENDING', payment: 'PENDING' });
    const packages = await new PackageService(testContainer()).list();
    const pkg = packages[0];

    // Admin submits a payment for themselves.
    const submitted = await api('/api/admin/payments', {
      method: 'POST',
      token: (await login('user', admin.email, admin.password)).body?.data?.token ?? '',
      body: { packageId: pkg.id, amountCents: 199900, period: 'MONTHLY', method: 'UPI', reference: 'UTR123' },
    });
    // A pending admin has no session, so submit through the repository instead.
    void submitted;

    const payment = await testContainer().payments.create({
      adminId: admin.user.id,
      packageId: pkg.id,
      amountCents: 199900,
      currency: 'INR',
      period: 'MONTHLY',
      method: 'UPI',
      reference: 'UTR123',
    });
    await testContainer().payments.submit(payment.id);
    await testContainer().users.update(admin.user.id, { payment_status: 'SUBMITTED' });

    // Chief verifies it.
    const verified = await api(`/api/chief/payments/${payment.id}/verify`, {
      method: 'POST',
      token: chiefToken,
      body: { note: 'UTR confirmed' },
    });
    expect(verified.status).toBe(200);
    expect((verified.body.data as { status: string }).status).toBe('VERIFIED');

    const afterPayment = await testContainer().users.findById(admin.user.id);
    expect(afterPayment?.payment_status).toBe('VERIFIED');

    // Chief approves the admin → account becomes ACTIVE.
    const approved = await api(`/api/chief/admins/${admin.user.id}/approve`, {
      method: 'POST',
      token: chiefToken,
      body: {},
    });
    expect(approved.status).toBe(200);

    const loginAttempt = await login('admin', admin.email, admin.password);
    expect(loginAttempt.status).toBe(200);
  });

  it('never lets an admin verify their own payment (§14)', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const chiefToken = (await login('chief', chief.email, chief.password)).body.data!.token;

    // The Chief's own payment cannot be verified by the Chief.
    const payment = await testContainer().payments.create({
      adminId: chief.user.id,
      packageId: null,
      amountCents: 100,
      currency: 'INR',
      period: 'MONTHLY',
      method: '',
      reference: '',
    });
    await testContainer().payments.submit(payment.id);

    const res = await api(`/api/chief/payments/${payment.id}/verify`, {
      method: 'POST',
      token: chiefToken,
      body: {},
    });
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toMatch(/own payment/i);
  });

  it('rejects an invalid payment status transition (§14, §48)', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const chiefToken = (await login('chief', chief.email, chief.password)).body.data!.token;

    const admin = await seedUser('ADMIN');
    const payment = await testContainer().payments.create({
      adminId: admin.user.id,
      packageId: null,
      amountCents: 100,
      currency: 'INR',
      period: 'MONTHLY',
      method: '',
      reference: '',
    });

    // PENDING → VERIFIED is not an allowed transition.
    const res = await api(`/api/chief/payments/${payment.id}/verify`, {
      method: 'POST',
      token: chiefToken,
      body: {},
    });
    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe('CONFLICT');
  });

  it('exposes the admin profile fields required by §12', async () => {
    const admin = await seedUser('ADMIN', {
      status: 'ACTIVE',
      approval: 'APPROVED',
      payment: 'VERIFIED',
    });
    const token = (await login('admin', admin.email, admin.password)).body.data!.token;
    const res = await api('/api/admin/profile', { token });

    expect(res.status).toBe(200);
    const profile = res.body.data as Record<string, unknown>;
    for (const field of [
      'adminId',
      'name',
      'email',
      'status',
      'package',
      'paymentStatus',
      'approvalStatus',
      'createdAt',
      'lastDevice',
      'lastIp',
    ]) {
      expect(profile, field).toHaveProperty(field);
    }
    expect(String(profile.adminId)).toMatch(/^\d{2,5}$/);
  });
});

  it('runs the full §13 lifecycle over HTTP: register → payment → verify → approve → login', async () => {
    const chief = await seedChief({ password: 'ChiefPass-12345' });
    const chiefToken = (await login('chief', chief.email, chief.password)).body.data!.token;
    await new PackageService(testContainer()).ensureDefaults();
    const pkg = (await new PackageService(testContainer()).list())[0];

    // 1. Register — lands in PENDING with an admin ID.
    const email = `lifecycle-${crypto.randomUUID()}@test.local`;
    const registered = await api<{ adminId: string; canLogin: boolean; status: string }>(
      '/api/admin/register',
      {
        method: 'POST',
        body: { email, password: 'Lifecycle-12345', fullName: 'Lifecycle Admin' },
      },
    );
    expect(registered.status).toBe(201);
    const adminId = registered.body.data!.adminId;
    expect(registered.body.data!.canLogin).toBe(false);

    // 2. Payment is submitted BEFORE login via the public endpoint.
    const submitted = await api<{ id: string; status: string }>('/api/admin/payments/submit', {
      method: 'POST',
      body: { email, adminId, packageId: pkg.id, amountCents: 199900, method: 'UPI', reference: 'UTR-LIFECYCLE' },
    });
    expect(submitted.status).toBe(201);
    expect(submitted.body.data!.status).toBe('SUBMITTED');

    // 3. Login is still refused — approval is outstanding.
    const beforeApproval = await login('admin', email, 'Lifecycle-12345');
    expect(beforeApproval.status).toBe(403);
    expect(beforeApproval.body.error?.code).toBe('ACCOUNT_PENDING_APPROVAL');

    // 4. Chief verifies the payment.
    const verified = await api(`/api/chief/payments/${submitted.body.data!.id}/verify`, {
      method: 'POST',
      token: chiefToken,
      body: { note: 'UTR confirmed' },
    });
    expect(verified.status).toBe(200);

    // 5. Chief approves the admin.
    const admin = (await testContainer().users.findByEmail(email))!;
    const approved = await api(`/api/chief/admins/${admin.id}/approve`, {
      method: 'POST',
      token: chiefToken,
      body: { note: 'Welcome' },
    });
    expect(approved.status).toBe(200);

    // 6. Now the admin can sign in and reach the dashboard.
    const signedIn = await login('admin', email, 'Lifecycle-12345');
    expect(signedIn.status).toBe(200);
    const token = signedIn.body.data!.token;
    expect((await api('/api/admin/dashboard', { token })).status).toBe(200);
    expect((await api('/api/admin/profile', { token })).status).toBe(200);
  });
