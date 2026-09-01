import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { ok } from '../http/errors';
import { body, query, zId, zPagination } from '../middleware/validate';
import { requireAuth, requireRole, resolveSession } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { AdminService } from '../services/admin-service';
import { AuthService } from '../services/auth-service';
import { PaymentService } from '../services/payment-service';
import { PackageService } from '../services/package-service';
import { SettingsService } from '../services/settings-service';
import { RecoveryService } from '../services/recovery-service';
import { ChiefSectionsService } from '../services/chief-sections-service';
import { AiService } from '../services/ai/orchestrator';
import { WhatsAppService } from '../services/whatsapp/service';
import { PAYMENT_STATUSES, type PaymentStatus } from '../types';
import { publicUser } from './auth';

/**
 * /api/chief/* — CHIEF CONTROL PORTAL (§3, §23).
 *
 * SUPER_ADMIN ONLY. This is the highest authority and is NOT a subordinate of
 * ADMIN: an ADMIN hitting any route here receives 403.
 */
export const chief = new Hono<AppEnv>();

chief.use('*', resolveSession, requireAuth, requireRole('SUPER_ADMIN'));

/* ------------------------------- dashboard ------------------------------- */

chief.get('/dashboard', async (c) => {
  const container = c.get('container');
  const sections = new ChiefSectionsService(container);
  const [users, admins, payments, activeSessions, recentAudit, sectionOverview] = await Promise.all([
    container.users.list({ limit: 1, offset: 0 }),
    container.users.list({ role: 'ADMIN', limit: 5, offset: 0 }),
    container.payments.list({ status: 'ALL', limit: 5, offset: 0 }),
    container.sessions.countActive(),
    container.audit.list({ limit: 10, offset: 0 }),
    sections.overview(),
  ]);

  return ok(c, {
    portal: 'CHIEF_CONTROL',
    // §23 the Chief Control Portal is split into two parts: RUFLO and MUDREXX.
    sections: sectionOverview,
    counts: {
      users: users.total,
      admins: admins.total,
      activeSessions,
      payments: payments.total,
    },
    recentAdmins: admins.rows.map(publicUser),
    recentPayments: payments.rows,
    recentAudit: recentAudit.rows,
  });
});

/* -------------------------------- sections -------------------------------- */
/*
 * §23 The Chief Control Portal has exactly two parts. These routes are mounted
 * before any `/:id` pattern so a section id can never be swallowed by a
 * parameterised route (§6, §54).
 */

chief.get('/sections', (c) => ok(c, new ChiefSectionsService(c.get('container')).list()));

chief.get('/sections/ruflo', async (c) =>
  ok(c, await new ChiefSectionsService(c.get('container')).ruflo()),
);

chief.get('/sections/mudrexx', async (c) =>
  ok(c, await new ChiefSectionsService(c.get('container')).mudrexx()),
);

/* -------------------------------- admins -------------------------------- */

chief.get('/admins', async (c) => {
  const { limit, offset } = query(c, zPagination);
  const result = await c.get('container').users.list({ role: 'ADMIN', limit, offset });
  return ok(c, result.rows.map(publicUser), 200, { total: result.total, limit, offset });
});

chief.get('/admins/search', async (c) => {
  const { q } = query(c, z.object({ q: z.string().trim().min(1).max(100) }));
  const { limit, offset } = query(c, zPagination);
  // includeEmail lets the Chief locate an admin account by its email address.
  const result = await c.get('container').users.search({
    q,
    role: 'ADMIN',
    limit,
    offset,
    includeEmail: true,
  });
  return ok(c, result.rows.map(publicUser), 200, { total: result.total, limit, offset });
});

chief.get('/admins/:id', async (c) => {
  const service = new AdminService(c.get('container'));
  return ok(c, await service.profile(c.req.param('id')));
});

chief.post('/admins/:id/approve', async (c) => {
  const input = await body(c, z.object({ note: z.string().max(500).optional() }).optional().default({}));
  const service = new AdminService(c.get('container'));
  return ok(c, publicUser(await service.approve(c.req.param('id'), c.get('auth')!.user, c, input.note)));
});

chief.post('/admins/:id/reject', async (c) => {
  const input = await body(c, z.object({ reason: z.string().trim().min(1).max(500) }));
  const service = new AdminService(c.get('container'));
  return ok(c, publicUser(await service.reject(c.req.param('id'), c.get('auth')!.user, input.reason, c)));
});

chief.post('/admins/:id/block', async (c) => {
  const service = new AdminService(c.get('container'));
  return ok(c, publicUser(await service.block(c.req.param('id'), c.get('auth')!.user, c)));
});

chief.post('/admins/:id/unblock', async (c) => {
  const service = new AdminService(c.get('container'));
  return ok(c, publicUser(await service.unblock(c.req.param('id'), c.get('auth')!.user, c)));
});

chief.delete('/admins/:id', async (c) => {
  const service = new AdminService(c.get('container'));
  await service.remove(c.req.param('id'), c.get('auth')!.user, c);
  return ok(c, { deleted: true });
});

chief.post('/admins/:id/package', async (c) => {
  const input = await body(c, z.object({ packageId: zId }));
  const service = new AdminService(c.get('container'));
  return ok(c, publicUser(await service.assignPackage(c.req.param('id'), input.packageId, c.get('auth')!.user, c)));
});

/** §41 reset an admin's device binding (forces re-registration on next login). */
chief.post('/admins/:id/reset-device', async (c) => {
  const service = new AdminService(c.get('container'));
  const revoked = await service.resetDevice(c.req.param('id'), c.get('auth')!.user, c);
  return ok(c, { devicesRevoked: revoked, sessionsRevoked: true });
});

/* -------------------------------- users -------------------------------- */

chief.get('/users', async (c) => {
  const { limit, offset } = query(c, zPagination);
  const result = await c.get('container').users.list({ limit, offset });
  return ok(c, result.rows.map(publicUser), 200, { total: result.total, limit, offset });
});

chief.get('/users/search', async (c) => {
  const { q } = query(c, z.object({ q: z.string().trim().min(1).max(100) }));
  const { limit, offset } = query(c, zPagination);
  const result = await c.get('container').users.search({ q, limit, offset, includeDemo: true });
  return ok(c, result.rows.map(publicUser), 200, { total: result.total, limit, offset });
});

/* ------------------------------- payments ------------------------------- */

chief.get('/payments', async (c) => {
  const input = query(c, zPagination.merge(z.object({ status: z.enum(['ALL', ...PAYMENT_STATUSES] as [string, ...string[]]).optional() })));
  const service = new PaymentService(c.get('container'));
  return ok(c, await service.list({
    status: (input.status as PaymentStatus | 'ALL') ?? 'ALL',
    limit: input.limit,
    offset: input.offset,
  }));
});

chief.post('/payments/:id/verify', async (c) => {
  const input = await body(c, z.object({ note: z.string().max(500).optional() }).optional().default({}));
  const service = new PaymentService(c.get('container'));
  return ok(c, await service.transition(c.req.param('id'), 'VERIFIED', c.get('auth')!.user, c, input));
});

chief.post('/payments/:id/reject', async (c) => {
  const input = await body(c, z.object({ reason: z.string().trim().min(1).max(500) }));
  const service = new PaymentService(c.get('container'));
  return ok(c, await service.transition(c.req.param('id'), 'REJECTED', c.get('auth')!.user, c, {
    reason: input.reason,
  }));
});

chief.post('/payments/:id/request-info', async (c) => {
  const input = await body(c, z.object({ message: z.string().trim().min(1).max(500) }));
  const service = new PaymentService(c.get('container'));
  return ok(c, await service.requestInformation(c.req.param('id'), c.get('auth')!.user, input.message, c));
});

/* ------------------------------- packages ------------------------------- */

chief.get('/packages', async (c) => {
  const service = new PackageService(c.get('container'));
  return ok(c, await service.list());
});

const packagePatchSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  isActive: z.boolean().optional(),
  limits: z.record(z.union([z.number(), z.boolean()])).optional(),
  prices: z
    .array(
      z.object({
        period: z.enum(['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL']),
        priceCents: z.number().int().min(0),
        currency: z.string().length(3).optional(),
      }),
    )
    .optional(),
  addons: z
    .array(
      z.object({
        kind: z.enum(['ADDITIONAL_USER', 'ADDITIONAL_LEAD', 'ADDITIONAL_MESSAGE', 'ADDITIONAL_STORAGE']),
        unitPriceCents: z.number().int().min(0),
      }),
    )
    .optional(),
});

chief.put('/packages/:id', async (c) => {
  const input = await body(c, packagePatchSchema);
  const service = new PackageService(c.get('container'));
  return ok(c, await service.configure(c.req.param('id'), input, c.get('auth')!.user, c));
});

/** §16 market reference → recommendation → Chief review. Never auto-applied. */
chief.post('/packages/market-rate', async (c) => {
  const input = await body(
    c,
    z.object({
      key: z.string().trim().min(1).max(100),
      valueCents: z.number().int().min(0),
      currency: z.string().length(3).optional(),
      source: z.string().trim().min(1).max(120),
      note: z.string().max(500).optional(),
    }),
  );
  const service = new PackageService(c.get('container'));
  return ok(c, await service.recordMarketRate(input, c, c.get('auth')!.user));
});

chief.get('/packages/market-rates', async (c) => {
  const service = new PackageService(c.get('container'));
  return ok(c, await service.marketRates());
});

/* --------------------------- security centre (§41) --------------------------- */

chief.get('/security/sessions', async (c) => {
  const { limit, offset } = query(c, zPagination);
  const rows = await c.get('container').sessions.listAll({ limit, offset, activeOnly: true });
  return ok(c, rows);
});

chief.post('/security/sessions/:id/revoke', async (c) => {
  const container = c.get('container');
  await container.sessions.revoke(c.req.param('id'), 'REVOKED_BY_CHIEF');
  await container.audit.record({
    actorId: c.get('auth')!.user.id,
    actorRole: 'SUPER_ADMIN',
    action: 'SESSION_REVOKED',
    targetType: 'session',
    targetId: c.req.param('id'),
    requestId: c.get('requestId'),
  });
  return ok(c, { revoked: true });
});

chief.get('/security/login-history', async (c) => {
  const { limit, offset } = query(c, zPagination);
  return ok(c, await c.get('container').loginHistory.listRecent(limit, offset));
});

chief.get('/security/audit', async (c) => {
  const input = query(
    c,
    zPagination.merge(
      z.object({
        action: z.string().max(60).optional(),
        actorId: z.string().max(64).optional(),
      }),
    ),
  );
  return ok(c, await c.get('container').audit.list(input));
});

/* ------------------------- password reset queue (§19) ------------------------- */

chief.get('/password-resets', async (c) => {
  const { limit, offset } = query(c, zPagination);
  const status = c.req.query('status') ?? 'PENDING';
  return ok(c, await c.get('container').passwordResets.listByStatus(status as never, limit, offset));
});

chief.post('/password-resets/:id/approve', async (c) => {
  const service = new AuthService(c.get('container'));
  const { token } = await service.approvePasswordReset(
    c.req.param('id'),
    c.get('auth')!.user,
    c,
  );
  // The one-time token is returned to the Chief for out-of-band delivery.
  return ok(c, { approved: true, token });
});

chief.post('/password-resets/:id/reject', async (c) => {
  const input = await body(c, z.object({ note: z.string().trim().min(1).max(500) }));
  const service = new AuthService(c.get('container'));
  await service.rejectPasswordReset(c.req.param('id'), c.get('auth')!.user, input.note, c);
  return ok(c, { rejected: true });
});

/* ------------------------------ settings (§40) ------------------------------ */

chief.get('/settings', async (c) => {
  const service = new SettingsService(c.get('container'));
  return ok(c, await service.getPortal());
});

chief.put('/settings', async (c) => {
  const input = await body(
    c,
    z.object({
      portalName: z.string().trim().min(1).max(120).optional(),
      portalShortName: z.string().trim().min(1).max(40).optional(),
      browserTitle: z.string().trim().min(1).max(160).optional(),
      loginTitle: z.string().trim().min(1).max(160).optional(),
      dashboardTitle: z.string().trim().min(1).max(160).optional(),
      footer: z.string().trim().min(1).max(200).optional(),
    }),
  );
  const service = new SettingsService(c.get('container'));
  return ok(c, await service.updatePortal(input, c.get('auth')!.user, c));
});

/* -------------------------- emergency recovery (§21) -------------------------- */

chief.post(
  '/recovery/mint',
  rateLimit({ bucket: 'recovery', limit: 3, windowMs: 60 * 60 * 1000 }),
  async (c) => {
    const input = await body(
      c,
      z.object({ secret: z.string().min(1).max(400), userId: z.string().max(64).optional() }),
    );
    const service = new RecoveryService(c.get('container'));
    return ok(c, await service.mintChallenge(input, c));
  },
);

chief.post('/recovery/rotate', async (c) => {
  const service = new RecoveryService(c.get('container'));
  return ok(c, await service.rotate(c, c.get('auth')!.user));
});

/* ---------------------------- platform status ---------------------------- */

chief.get('/ai/providers', async (c) => {
  const ai = new AiService(c.get('container'));
  return ok(c, ai.providerStatus());
});

chief.get('/whatsapp/providers', async (c) => {
  const wa = new WhatsAppService(c.get('container'));
  return ok(c, wa.status());
});
