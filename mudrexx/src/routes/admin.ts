import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { ok } from '../http/errors';
import { body, query, zId, zPagination } from '../middleware/validate';
import { requireAuth, requireRole, resolveSession } from '../middleware/auth';
import { demoReadOnly } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { AdminService } from '../services/admin-service';
import { PaymentService } from '../services/payment-service';
import { PackageService } from '../services/package-service';
import { TaskService } from '../services/task-service';
import { publicUser } from './auth';

/**
 * /api/admin/* — ADMIN operational control.
 * SUPER_ADMIN may also operate here (higher rank), DEMO_VIEWER is read-only and
 * blocked from every mutation by `demoReadOnly`.
 */
export const admin = new Hono<AppEnv>();

admin.use('*', resolveSession);

/* ------------------------- public: admin signup ------------------------- */

const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(10).max(200),
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).optional(),
  businessName: z.string().trim().max(200).optional(),
  packageId: z.string().trim().max(64).optional(),
});

// §13 registration always lands in PENDING — never auto-approved, never auto-admin.
admin.post('/register', rateLimit({ bucket: 'register', limit: 5, windowMs: 60 * 60 * 1000 }), async (c) => {
  const input = await body(c, registerSchema);
  const service = new AdminService(c.get('container'));
  const { user, adminId } = await service.register(input, c);
  return ok(
    c,
    {
      user: publicUser(user),
      adminId,
      // Explicit: nothing is granted at registration time.
      approvalStatus: user.approval_status,
      paymentStatus: user.payment_status,
      status: user.status,
      nextStep: 'PAYMENT',
      canLogin: false,
    },
    201,
  );
});

/**
 * §13 public payment submission: REGISTER → PACKAGE → PAYMENT happens before
 * the admin has a session, so this endpoint is unauthenticated and rate limited.
 * It can only move a payment to SUBMITTED — verification stays with the Chief.
 */
const publicPaymentSchema = z.object({
  email: z.string().trim().email(),
  adminId: z.string().trim().min(2).max(5),
  packageId: zId,
  amountCents: z.number().int().min(0).max(1_000_000_000),
  currency: z.string().trim().length(3).optional(),
  period: z.enum(['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL']).optional(),
  method: z.string().trim().max(60).optional(),
  reference: z.string().trim().max(200).optional(),
});

admin.post(
  '/payments/submit',
  rateLimit({ bucket: 'payment_submit', limit: 10, windowMs: 60 * 60 * 1000 }),
  async (c) => {
    const input = await body(c, publicPaymentSchema);
    const service = new PaymentService(c.get('container'));
    return ok(c, await service.submitForPendingAdmin(input, c), 201);
  },
);

/* --------------------------- protected surface --------------------------- */

const protectedAdmin = new Hono<AppEnv>();
protectedAdmin.use('*', requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'), demoReadOnly);

protectedAdmin.get('/dashboard', async (c) => {
  const auth = c.get('auth')!;
  const container = c.get('container');
  const tasks = new TaskService(container);
  const payments = new PaymentService(container);

  const [taskStats, leadStats, paymentRows, walletRows] = await Promise.all([
    tasks.stats(auth.user),
    container.leads.list({ ownerAdminId: auth.user.id, limit: 1, offset: 0 }),
    payments.listForAdmin(auth.user),
    container.wallets.listForUser(auth.user.id),
  ]);

  return ok(c, {
    role: auth.user.role,
    account: {
      humanId: auth.user.human_id,
      status: auth.user.status,
      approvalStatus: auth.user.approval_status,
      paymentStatus: auth.user.payment_status,
    },
    tasks: taskStats,
    leads: { total: leadStats.total },
    payments: paymentRows,
    wallets: walletRows,
  });
});

protectedAdmin.get('/profile', async (c) => {
  const service = new AdminService(c.get('container'));
  return ok(c, await service.profile(c.get('auth')!.user.id));
});

/** §35 server-side, paginated, indexed, case-insensitive user search. */
protectedAdmin.get('/users/search', async (c) => {
  const { q } = query(c, z.object({ q: z.string().trim().min(1).max(100) }));
  const { limit, offset } = query(c, zPagination);
  const result = await c.get('container').users.search({ q, role: 'USER', limit, offset });
  return ok(
    c,
    result.rows.map(publicUser),
    200,
    { total: result.total, limit, offset },
  );
});

protectedAdmin.get('/users', async (c) => {
  const { limit, offset } = query(c, zPagination);
  const result = await c.get('container').users.list({ role: 'USER', limit, offset });
  return ok(c, result.rows.map(publicUser), 200, { total: result.total, limit, offset });
});

/* ------------------------------- payments ------------------------------- */

const paymentSchema = z.object({
  packageId: zId,
  amountCents: z.number().int().min(0).max(1_000_000_000),
  currency: z.string().trim().length(3).optional(),
  period: z.enum(['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL']).optional(),
  method: z.string().trim().max(60).optional(),
  reference: z.string().trim().max(200).optional(),
});

protectedAdmin.post('/payments', async (c) => {
  const input = await body(c, paymentSchema);
  const service = new PaymentService(c.get('container'));
  return ok(c, await service.submitForAdmin(c.get('auth')!.user, input, c), 201);
});

protectedAdmin.get('/payments', async (c) => {
  const service = new PaymentService(c.get('container'));
  return ok(c, await service.listForAdmin(c.get('auth')!.user));
});

/* ------------------------------- packages ------------------------------- */

protectedAdmin.get('/packages', async (c) => {
  const service = new PackageService(c.get('container'));
  return ok(c, await service.list());
});

protectedAdmin.get('/packages/quote', async (c) => {
  const input = query(
    c,
    z.object({
      packageId: zId,
      period: z.enum(['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL']),
    }),
  );
  const service = new PackageService(c.get('container'));
  return ok(c, await service.quote({ packageId: input.packageId, period: input.period }));
});

admin.route('/', protectedAdmin);
