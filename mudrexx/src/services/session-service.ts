import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { randomToken, sha256Hex } from '../lib/crypto';
import { clientIp, deviceFingerprint, deviceLabel, parseUserAgent, userAgentOf } from '../lib/http';
import { SESSION_TTL_MS } from '../config';
import type { Role, SessionRow, UserRow } from '../types';
import type { DeviceRow } from '../repositories/sessions';

export interface IssuedSession {
  token: string;
  session: SessionRow;
  device: DeviceRow | null;
  deviceIsNew: boolean;
}

/**
 * Single source of truth for session lifecycle (§4, §17, §53).
 *
 * - The raw token is returned once and never stored; only its SHA-256 is kept.
 * - Admin and Chief sessions are additionally bound to ONE device and ONE
 *   active session. A login from a different device is refused until a Chief
 *   resets the device — it never silently re-binds.
 */
export class SessionService {
  constructor(private readonly c: Container) {}

  async issue(input: {
    c: Context;
    user: UserRow;
    allowDeviceRebind?: boolean;
  }): Promise<IssuedSession> {
    const { c, user } = input;
    const ip = clientIp(c);
    const ua = userAgentOf(c);
    const info = parseUserAgent(ua);
    const fingerprint = await deviceFingerprint(c);
    const label = deviceLabel(info);

    let device: DeviceRow | null = null;
    let deviceIsNew = false;

    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      const bound = await this.c.devices.activeDeviceForUser(user.id);
      if (bound && bound.fingerprint !== fingerprint && !input.allowDeviceRebind) {
        throw new AppError(
          'FORBIDDEN',
          'This admin account is bound to another device. Ask the Chief Admin to reset the device.',
          { code: 'DEVICE_BOUND_ELSEWHERE' },
        );
      }
      const resolved = await this.c.devices.resolve({
        userId: user.id,
        fingerprint,
        label,
        browser: info.browser,
        os: info.os,
        ip,
      });
      device = resolved.device;
      deviceIsNew = resolved.isNew;
    }

    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    const ttl = SESSION_TTL_MS[user.role] ?? SESSION_TTL_MS.USER;

    const session = await this.c.sessions.create({
      userId: user.id,
      tokenHash,
      deviceId: device?.id ?? null,
      ip,
      userAgent: ua,
      browser: info.browser,
      os: info.os,
      ttlMs: ttl,
      isDemo: user.is_demo === 1,
    });

    // §17 one active login device/session for ADMIN and SUPER_ADMIN.
    if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
      await this.c.sessions.revokeOthersForUser(
        user.id,
        session.id,
        'SINGLE_SESSION_POLICY',
      );
    }

    await this.c.users.recordLogin(user.id, ip, device?.id ?? null);
    if (device && deviceIsNew) {
      await this.c.users.setAdminDeviceLabel(user.id, label).catch(() => undefined);
    }

    return { token, session, device, deviceIsNew };
  }

  /** Resolve a presented token to a live session + user. Returns null if dead. */
  async resolve(token: string): Promise<{ session: SessionRow; user: UserRow } | null> {
    if (!token) return null;
    const tokenHash = await sha256Hex(token);
    const session = await this.c.sessions.findValidByTokenHash(tokenHash);
    if (!session) return null;
    const user = await this.c.users.findById(session.user_id);
    if (!user) return null;
    if (user.status === 'BLOCKED' || user.status === 'SUSPENDED') return null;
    return { session, user };
  }

  async revoke(token: string, reason: string): Promise<void> {
    const tokenHash = await sha256Hex(token);
    const session = await this.c.sessions.findByTokenHash(tokenHash);
    if (!session) return;
    await this.c.sessions.revoke(session.id, reason);
  }

  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    return this.c.sessions.revokeAllForUser(userId, reason);
  }

  async revokeSession(id: string, reason: string): Promise<void> {
    await this.c.sessions.revoke(id, reason);
  }

  /** Session cookie is HttpOnly + SameSite so JS can never read or replay it. */
  cookieAttributes(maxAgeSeconds: number) {
    const secure = (this.c.env.ENVIRONMENT ?? 'production') !== 'test';
    return [
      `${SESSION_COOKIE_NAME}=%TOKEN%`,
      'Path=/',
      'HttpOnly',
      `SameSite=${secure ? 'Strict' : 'Lax'}`,
      secure ? 'Secure' : '',
      `Max-Age=${maxAgeSeconds}`,
    ]
      .filter(Boolean)
      .join('; ');
  }

  ttlFor(role: Role): number {
    return SESSION_TTL_MS[role] ?? SESSION_TTL_MS.USER;
  }
}

const SESSION_COOKIE_NAME = 'mudrexx_session';
