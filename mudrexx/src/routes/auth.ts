import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { ok } from '../http/errors';
import { body, zEmail, zPassword } from '../middleware/validate';
import { readSessionToken, requireAuth, resolveSession } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { RATE_LIMITS } from '../config';
import { AuthService } from '../services/auth-service';
import { DemoService } from '../services/demo-service';
import { RecoveryService } from '../services/recovery-service';
import type { Role, UserRow } from '../types';
import { clearSessionCookie, setSessionCookie } from './session-cookie';

/**
 * §5 canonical auth namespace — one implementation, three portals.
 *
 *   POST /api/auth/register
 *   POST /api/auth/login              (USER, DEMO_VIEWER)
 *   POST /api/auth/admin/login        (ADMIN)
 *   POST /api/auth/super-admin/login  (SUPER_ADMIN)
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *   POST /api/auth/password/change
 *   POST /api/auth/password/reset-request
 *   POST /api/auth/password/reset
 *
 * The portal declares which roles it accepts; the role stored in the database
 * decides. No portal can mint, upgrade or bypass a role.
 */
export const auth = new Hono<AppEnv>();

type Handler = (c: Context<AppEnv>) => Promise<Response>;

auth.use('*', resolveSession);

const registerSchema = z.object({
  email: zEmail,
  password: zPassword,
  fullName: z.string().trim().min(1).max(200),
  phone: z.string().trim().max(40).optional(),
});

auth.post(
  '/register',
  rateLimit({ bucket: 'register', ...RATE_LIMITS.REGISTER }),
  async (c) => {
    const input = await body(c, registerSchema);
    const service = new AuthService(c.get('container'));
    const result = await service.register(input, c);
    setSessionCookie(c, result.token, Math.floor(result.ttlMs / 1000));
    return ok(c, { user: publicUser(result.user), token: result.token }, 201);
  },
);

const loginSchema = z.object({ email: zEmail, password: z.string().min(1).max(200) });

/** Builds a portal-specific login handler bound to the roles that portal serves. */
function loginHandler(allowedRoles: Role[]): Handler {
  return async (c) => {
    const input = await body(c, loginSchema);
    const service = new AuthService(c.get('container'));
    const result = await service.login({ ...input, allowedRoles }, c);
    setSessionCookie(c, result.token, Math.floor(result.ttlMs / 1000));
    return ok(c, { user: publicUser(result.user), token: result.token });
  };
}

const loginRateLimit = rateLimit({ bucket: 'login', limit: 10, windowMs: 15 * 60 * 1000 });

// User portal accepts real users and the read-only demo account.
auth.post('/login', loginRateLimit, loginHandler(['USER', 'DEMO_VIEWER']));
auth.post('/admin/login', loginRateLimit, loginHandler(['ADMIN']));
auth.post('/super-admin/login', loginRateLimit, loginHandler(['SUPER_ADMIN']));

auth.post('/logout', async (c) => {
  const container = c.get('container');
  const service = new AuthService(container);
  const token = readSessionToken(c as unknown as Parameters<typeof readSessionToken>[0]);
  await service.logout(token, c, c.get('auth')?.user ?? null);
  clearSessionCookie(c);
  return ok(c, { loggedOut: true });
});

auth.get('/me', requireAuth, async (c) => {
  const authCtx = c.get('auth')!;
  const container = c.get('container');
  const profile = await container.users.getAdminProfile(authCtx.user.id);
  return ok(c, {
    user: {
      ...publicUser(authCtx.user),
      adminId: profile?.admin_id ?? null,
      paymentStatus: authCtx.user.payment_status,
      approvalStatus: authCtx.user.approval_status,
    },
    session: {
      id: authCtx.session.id,
      createdAt: authCtx.session.created_at,
      expiresAt: authCtx.session.expires_at,
      lastActivityAt: authCtx.session.last_activity_at,
      browser: authCtx.session.browser,
      os: authCtx.session.os,
    },
  });
});

const changeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: zPassword,
});

auth.post('/password/change', requireAuth, async (c) => {
  const input = await body(c, changeSchema);
  const service = new AuthService(c.get('container'));
  await service.changePassword(c.get('auth')!.user, input, c);
  clearSessionCookie(c);
  // §20 the change invalidated active sessions, so the caller must sign in again.
  return ok(c, { changed: true, sessionsInvalidated: true });
});

const resetRequestSchema = z.object({ email: zEmail });

auth.post(
  '/password/reset-request',
  rateLimit({ bucket: 'password_reset', ...RATE_LIMITS.PASSWORD_RESET }),
  async (c) => {
    const input = await body(c, resetRequestSchema);
    const service = new AuthService(c.get('container'));
    await service.requestPasswordReset(input.email, c);
    // Identical response whether or not the account exists.
    return ok(c, { requested: true });
  },
);

const resetSchema = z.object({ token: z.string().min(10).max(200), newPassword: zPassword });

auth.post('/password/reset', async (c) => {
  const input = await body(c, resetSchema);
  const service = new AuthService(c.get('container'));
  await service.completePasswordReset(input.token, input.newPassword, c);
  return ok(c, { reset: true, sessionsInvalidated: true });
});

/**
 * §21 emergency recovery — public because the caller is locked out by definition.
 * Redeeming forces a credential reset and invalidates sessions; it never issues
 * a session, so the user must still sign in with the new password.
 */
const recoveryRedeemSchema = z.object({
  code: z.string().trim().min(4).max(64),
  userId: z.string().trim().min(1).max(64),
  newPassword: zPassword,
});

auth.post(
  '/recovery/redeem',
  rateLimit({ bucket: 'recovery_redeem', limit: 5, windowMs: 60 * 60 * 1000 }),
  async (c) => {
    const input = await body(c, recoveryRedeemSchema);
    const service = new RecoveryService(c.get('container'));
    return ok(c, await service.redeemChallenge(input, c));
  },
);

/** §39 provision/reveal the isolated read-only demo account. */
auth.post('/demo', async (c) => {
  const demo = new DemoService(c.get('container'));
  const account = await demo.ensureDemoUser();
  return ok(c, { email: account.email, password: account.password, readOnly: true });
});

/* ------------------------------- helpers ------------------------------- */

export function publicUser(user: UserRow) {
  return {
    id: user.id,
    // §11 human-facing identification number (2-5 digits). Never the UUID PK.
    humanId: user.human_id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    fullName: user.full_name,
    firstName: user.first_name,
    lastName: user.last_name,
    isDemo: user.is_demo === 1,
    packageId: user.package_id,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
    lastActiveAt: user.last_active_at,
  };
}
