import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { hashPassword, randomCode, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { clientIp, userAgentOf } from '../lib/http';
import { RECOVERY_RATE_LIMIT, RECOVERY_TTL_MS } from '../config';
import { AUDIT_ACTIONS } from '../repositories/platform';
import type { UserRow } from '../types';

/**
 * §21 EMERGENCY RECOVERY — no backdoor.
 *
 * What this is NOT:
 *   - not a master password
 *   - not a hidden login button
 *   - not an auto-super-admin
 *   - not a hard-drive/login bypass
 *   - not authenticated by mere presence of a device or file
 *
 * What it IS:
 *   - a one-time, time-limited, rate-limited, audited, rotatable recovery code
 *   - minted only with a server-side secret that lives outside source control
 *   - redeemable only together with a NEW password, which force-resets the
 *     credential and invalidates every existing session
 *   - it NEVER creates a session; the user must still sign in normally
 */
export class RecoveryService {
  constructor(private readonly c: Container) {}

  /**
   * Mint a one-time recovery code.
   * Requires the server-side secret; the code is returned exactly once.
   */
  async mintChallenge(
    input: { secret: string; userId?: string | null },
    req: Context,
  ): Promise<{ code: string; expiresAt: number; expiresInSeconds: number }> {
    const expected = this.c.env.RECOVERY_SECRET;
    if (!expected) {
      throw new AppError(
        'PROVIDER_NOT_CONFIGURED',
        'Recovery is not configured. Set the RECOVERY_SECRET secret on the Worker.',
      );
    }

    const ip = clientIp(req);
    const recent = await this.c.recovery.countRecent(
      ip,
      Date.now() - RECOVERY_RATE_LIMIT.windowMs,
    );
    if (recent >= RECOVERY_RATE_LIMIT.limit) {
      await this.c.audit.record({
        actorId: null,
        actorRole: '',
        action: AUDIT_ACTIONS.RECOVERY_DENIED,
        targetType: 'recovery',
        ip,
        userAgent: userAgentOf(req),
        requestId: req.get('requestId'),
        meta: { reason: 'RATE_LIMITED' },
      });
      throw new AppError('RATE_LIMITED', 'Too many recovery requests. Try again later.');
    }

    const provided = new TextEncoder().encode(input.secret ?? '');
    const known = new TextEncoder().encode(expected);
    if (!timingSafeEqual(provided, known)) {
      await this.c.audit.record({
        actorId: null,
        actorRole: '',
        action: AUDIT_ACTIONS.RECOVERY_DENIED,
        targetType: 'recovery',
        ip,
        userAgent: userAgentOf(req),
        requestId: req.get('requestId'),
        meta: { reason: 'BAD_SECRET' },
      });
      throw new AppError('FORBIDDEN', 'Invalid recovery secret.');
    }

    let user: UserRow | null = null;
    if (input.userId) {
      user = await this.c.users.findById(input.userId);
      if (!user) throw new AppError('NOT_FOUND', 'Account not found.');
    }

    const code = randomCode(12);
    const codeHash = await sha256Hex(code);
    const challenge = await this.c.recovery.create({
      userId: user?.id ?? null,
      codeHash,
      ttlMs: RECOVERY_TTL_MS,
      ip,
      requestId: req.get('requestId') ?? '',
      rotationId: this.c.env.RECOVERY_ROTATION_ID ?? null,
    });

    await this.c.audit.record({
      actorId: user?.id ?? null,
      actorRole: user?.role ?? '',
      action: AUDIT_ACTIONS.RECOVERY_CODE_MINTED,
      targetType: 'recovery',
      targetId: challenge.id,
      ip,
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { ttlMs: RECOVERY_TTL_MS },
    });

    return {
      code,
      expiresAt: challenge.expires_at,
      expiresInSeconds: Math.floor(RECOVERY_TTL_MS / 1000),
    };
  }

  /**
   * Redeem a recovery code. Forces a credential reset and invalidates all
   * sessions. Deliberately does NOT issue a session.
   */
  async redeemChallenge(
    input: { code: string; userId: string; newPassword: string },
    req: Context,
  ): Promise<{ ok: true; sessionsRevoked: number }> {
    if (!input.newPassword || input.newPassword.length < 10) {
      throw new AppError('VALIDATION_ERROR', 'New password must be at least 10 characters.');
    }

    const user = await this.c.users.findById(input.userId);
    if (!user) throw new AppError('NOT_FOUND', 'Account not found.');

    const codeHash = await sha256Hex((input.code ?? '').trim().toUpperCase());
    const consumed = await this.c.recovery.consume(
      codeHash,
      this.c.env.RECOVERY_ROTATION_ID ?? null,
    );

    if (!consumed) {
      await this.c.audit.record({
        actorId: user.id,
        actorRole: user.role,
        action: AUDIT_ACTIONS.RECOVERY_DENIED,
        targetType: 'recovery',
        targetId: user.id,
        ip: clientIp(req),
        userAgent: userAgentOf(req),
        requestId: req.get('requestId'),
        meta: { reason: 'INVALID_OR_EXPIRED_CODE' },
      });
      throw new AppError('UNPROCESSABLE', 'Recovery code is invalid, expired, or already used.');
    }

    if (consumed.user_id && consumed.user_id !== user.id) {
      throw new AppError('FORBIDDEN', 'This recovery code was minted for a different account.');
    }

    const hash = await hashPassword(input.newPassword);
    await this.c.users.setPassword(user.id, hash);
    await this.c.passwordHistory.record(user.id, hash);
    const sessionsRevoked = await this.c.sessions.revokeAllForUser(user.id, 'RECOVERY_RESET');

    await this.c.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: AUDIT_ACTIONS.RECOVERY_CODE_CONSUMED,
      targetType: 'recovery',
      targetId: consumed.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { sessionsRevoked },
    });

    return { ok: true, sessionsRevoked };
  }

  /** Rotation invalidates every outstanding challenge immediately. */
  async rotate(req: Context, actor: UserRow | null): Promise<{ revoked: number }> {
    const revoked = await this.c.recovery.revokeAllPending();
    await this.c.audit.record({
      actorId: actor?.id ?? null,
      actorRole: actor?.role ?? '',
      action: 'RECOVERY_ROTATED',
      targetType: 'recovery',
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { revoked },
    });
    return { revoked };
  }
}
