import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { hashPassword, sha256Hex, verifyPassword } from '../lib/crypto';
import { clientIp, parseUserAgent, userAgentOf } from '../lib/http';
import {
  ACCOUNT_LOCK_MS,
  MAX_FAILED_ATTEMPTS,
  PASSWORD_HISTORY_COUNT,
  PASSWORD_MIN_LENGTH,
  RESET_REQUEST_TTL_MS,
  RESET_TOKEN_TTL_MS,
} from '../config';
import { AUDIT_ACTIONS } from '../repositories/platform';
import { SessionService, type IssuedSession } from './session-service';
import type { Role, UserRow } from '../types';

export interface LoginResult extends IssuedSession {
  user: UserRow;
  ttlMs: number;
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
}

export function assertPasswordPolicy(password: string): void {
  const problems: string[] = [];
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (!/[a-z]/.test(password)) problems.push('must contain a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('must contain an uppercase letter');
  if (!/\d/.test(password)) problems.push('must contain a digit');
  if (problems.length) {
    throw new AppError('VALIDATION_ERROR', `Password ${problems.join(', ')}.`, { problems });
  }
}

/**
 * One canonical authentication service (§4, §5).
 *
 * There is no bypass of any kind: every login hits the database, verifies a
 * PBKDF2 hash, checks the stored role, and only then mints a session.
 */
export class AuthService {
  private readonly sessions: SessionService;

  constructor(private readonly c: Container) {
    this.sessions = new SessionService(c);
  }

  /* ------------------------------- register ------------------------------- */

  async register(input: RegisterInput, req: Context): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AppError('VALIDATION_ERROR', 'A valid email address is required.');
    }
    assertPasswordPolicy(input.password);

    const existing = await this.c.users.findByEmail(email);
    if (existing) throw new AppError('CONFLICT', 'An account with this email already exists.');

    const passwordHash = await hashPassword(input.password);
    const [firstName, ...rest] = input.fullName.trim().split(/\s+/);
    const user = await this.c.users.create({
      email,
      passwordHash,
      role: 'USER',
      fullName: input.fullName.trim(),
      firstName: firstName ?? '',
      lastName: rest.join(' '),
      phone: input.phone,
      status: 'ACTIVE',
    });

    await this.c.passwordHistory.record(user.id, passwordHash);
    await this.c.wallets.ensure(user.id);

    const issued = await this.sessions.issue({ c: req, user });
    await this.c.loginHistory.record({
      userId: user.id,
      emailKey: email,
      sessionId: issued.session.id,
      deviceId: issued.device?.id ?? null,
      event: 'LOGIN_SUCCESS',
      browser: issued.session.browser,
      os: issued.session.os,
      ip: clientIp(req),
      reason: 'REGISTER',
    });
    await this.c.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: AUDIT_ACTIONS.REGISTER,
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });

    return { ...issued, user, ttlMs: this.sessions.ttlFor(user.role) };
  }

  /* --------------------------------- login -------------------------------- */

  /**
   * @param allowedRoles the roles this portal accepts. A caller whose stored
   *        role is not in this list is rejected — the portal never assigns or
   *        upgrades a role.
   */
  async login(
    input: { email: string; password: string; allowedRoles: Role[] },
    req: Context,
  ): Promise<LoginResult> {
    const email = input.email.trim().toLowerCase();
    const ip = clientIp(req);
    const info = parseUserAgent(userAgentOf(req));

    const user = await this.c.users.findByEmail(email);

    // Uniform message: do not reveal whether the account exists.
    const deny = async (reason: string, code: AppError['code'], message: string) => {
      await this.c.loginHistory.record({
        userId: user?.id ?? null,
        emailKey: email,
        event: 'LOGIN_FAILED',
        browser: info.browser,
        os: info.os,
        ip,
        reason,
      });
      await this.c.audit.record({
        actorId: user?.id ?? null,
        actorRole: user?.role ?? '',
        action: AUDIT_ACTIONS.LOGIN_FAILED,
        targetType: 'user',
        targetId: user?.id ?? '',
        ip,
        userAgent: userAgentOf(req),
        requestId: req.get('requestId'),
        meta: { reason },
      });
      throw new AppError(code, message, { reason });
    };

    if (!user) {
      await deny('NO_SUCH_ACCOUNT', 'UNAUTHORIZED', 'Invalid credentials.');
    }
    const found = user as UserRow;

    if (found.locked_until && found.locked_until > Date.now()) {
      await deny('ACCOUNT_LOCKED', 'ACCOUNT_LOCKED', 'Account temporarily locked after repeated failures.');
    }

    const okPassword = await verifyPassword(input.password, found.password_hash);
    if (!okPassword) {
      await this.c.users.registerFailedAttempt(found.id, MAX_FAILED_ATTEMPTS, ACCOUNT_LOCK_MS);
      await deny('BAD_PASSWORD', 'UNAUTHORIZED', 'Invalid credentials.');
    }

    if (!input.allowedRoles.includes(found.role)) {
      await deny(
        'ROLE_NOT_ALLOWED_FOR_PORTAL',
        'FORBIDDEN',
        'This account is not permitted to sign in to this portal.',
      );
    }

    // §13 admin gating: approval, then payment, then active status.
    // The most specific reason is reported first so an admin knows what to fix.
    if (found.role === 'ADMIN') {
      if (found.approval_status !== 'APPROVED') {
        await deny(
          'ADMIN_NOT_APPROVED',
          'ACCOUNT_PENDING_APPROVAL',
          'Admin account is awaiting Chief approval.',
        );
      }
      if (found.payment_status !== 'VERIFIED') {
        await deny(
          'PAYMENT_NOT_VERIFIED',
          'PAYMENT_REQUIRED',
          'Admin payment has not been verified by the Chief Admin.',
        );
      }
      if (found.status !== 'ACTIVE') {
        await deny('ADMIN_NOT_ACTIVE', 'ACCOUNT_PENDING_APPROVAL', 'Admin account is not active yet.');
      }
    }

    if (found.status === 'BLOCKED' || found.status === 'SUSPENDED') {
      await deny('ACCOUNT_DISABLED', 'FORBIDDEN', 'Account is disabled.');
    }

    const issued = await this.sessions.issue({ c: req, user: found });
    await this.c.loginHistory.record({
      userId: found.id,
      emailKey: email,
      sessionId: issued.session.id,
      deviceId: issued.device?.id ?? null,
      event: 'LOGIN_SUCCESS',
      browser: info.browser,
      os: info.os,
      ip,
    });
    await this.c.audit.record({
      actorId: found.id,
      actorRole: found.role,
      action: AUDIT_ACTIONS.LOGIN_SUCCESS,
      targetType: 'user',
      targetId: found.id,
      ip,
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { portal: input.allowedRoles.join(',') },
    });

    return { ...issued, user: found, ttlMs: this.sessions.ttlFor(found.role) };
  }

  /* -------------------------------- logout -------------------------------- */

  async logout(token: string, req: Context, user: UserRow | null): Promise<void> {
    await this.sessions.revoke(token, 'LOGOUT');
    if (user) {
      await this.c.loginHistory.record({
        userId: user.id,
        emailKey: user.email ?? '',
        event: 'LOGOUT',
        browser: parseUserAgent(userAgentOf(req)).browser,
        os: parseUserAgent(userAgentOf(req)).os,
        ip: clientIp(req),
      });
      await this.c.audit.record({
        actorId: user.id,
        actorRole: user.role,
        action: AUDIT_ACTIONS.LOGOUT,
        targetType: 'user',
        targetId: user.id,
        ip: clientIp(req),
        userAgent: userAgentOf(req),
        requestId: req.get('requestId'),
      });
    }
  }

  /* ---------------------------- password (§19/§20) ---------------------------- */

  async changePassword(
    user: UserRow,
    input: { currentPassword: string; newPassword: string },
    req: Context,
  ): Promise<void> {
    const valid = await verifyPassword(input.currentPassword, user.password_hash);
    if (!valid) throw new AppError('UNAUTHORIZED', 'Current password is incorrect.');

    assertPasswordPolicy(input.newPassword);
    await this.assertNotReused(user.id, input.newPassword);

    const hash = await hashPassword(input.newPassword);
    await this.c.users.setPassword(user.id, hash);
    await this.c.passwordHistory.record(user.id, hash);

    // §20 a password change invalidates active sessions.
    await this.sessions.revokeAllForUser(user.id, 'PASSWORD_CHANGED');

    await this.c.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: AUDIT_ACTIONS.PASSWORD_CHANGED,
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
  }

  private async assertNotReused(userId: string, newPassword: string): Promise<void> {
    const previous = await this.c.passwordHistory.recentHashes(userId, PASSWORD_HISTORY_COUNT);
    for (const old of previous) {
      if (await verifyPassword(newPassword, old)) {
        throw new AppError('CONFLICT', 'This password was used recently. Choose a different one.');
      }
    }
  }

  /** Always reports success to the caller — never leaks account existence. */
  async requestPasswordReset(email: string, req: Context): Promise<void> {
    const normalized = email.trim().toLowerCase();
    const user = await this.c.users.findByEmail(normalized);
    if (!user) return;

    await this.c.passwordResets.createRequest({
      userId: user.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      ttlMs: RESET_REQUEST_TTL_MS,
    });
    await this.c.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: AUDIT_ACTIONS.PASSWORD_RESET_REQUESTED,
      targetType: 'user',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
  }

  /** Chief-only: mints a single-use, short-lived reset token. */
  async approvePasswordReset(resetId: string, chief: UserRow, req: Context): Promise<{ token: string }> {
    const request = await this.c.passwordResets.findById(resetId);
    if (!request) throw new AppError('NOT_FOUND', 'Reset request not found.');
    if (request.status !== 'PENDING') {
      throw new AppError('CONFLICT', `Reset request is already ${request.status}.`);
    }
    const { token } = await this.c.passwordResets.approve(resetId, chief.id, RESET_TOKEN_TTL_MS);
    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.PASSWORD_RESET_APPROVED,
      targetType: 'password_reset',
      targetId: resetId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
    return { token };
  }

  async rejectPasswordReset(resetId: string, chief: UserRow, note: string, req: Context): Promise<void> {
    const request = await this.c.passwordResets.findById(resetId);
    if (!request) throw new AppError('NOT_FOUND', 'Reset request not found.');
    if (request.status !== 'PENDING') {
      throw new AppError('CONFLICT', `Reset request is already ${request.status}.`);
    }
    await this.c.passwordResets.reject(resetId, chief.id, note);
    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.PASSWORD_RESET_REJECTED,
      targetType: 'password_reset',
      targetId: resetId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { note },
    });
  }

  async completePasswordReset(token: string, newPassword: string, req: Context): Promise<void> {
    assertPasswordPolicy(newPassword);
    const tokenHash = await sha256Hex(token);
    const request = await this.c.passwordResets.consume(tokenHash);
    if (!request) {
      throw new AppError('UNPROCESSABLE', 'Reset token is invalid, expired, or already used.');
    }
    await this.assertNotReused(request.user_id, newPassword);

    const hash = await hashPassword(newPassword);
    await this.c.users.setPassword(request.user_id, hash);
    await this.c.passwordHistory.record(request.user_id, hash);
    await this.sessions.revokeAllForUser(request.user_id, 'PASSWORD_RESET');

    await this.c.audit.record({
      actorId: request.user_id,
      actorRole: '',
      action: AUDIT_ACTIONS.PASSWORD_RESET_COMPLETED,
      targetType: 'user',
      targetId: request.user_id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
  }
}
