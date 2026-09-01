import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-types';
import { AppError } from '../http/errors';
import { clientIp, userAgentOf } from '../lib/http';
import { SessionService } from '../services/session-service';
import type { Role } from '../types';

/**
 * Session resolution.
 *
 * The session token is read from an HttpOnly cookie (browser) or an
 * `Authorization: Bearer` header (API clients). Nothing about the caller's role
 * is ever trusted from the request body or the frontend — it is always loaded
 * from the database row attached to the session.
 */
export function readSessionToken(c: Parameters<typeof clientIp>[0]): string {
  const header = c.req.header('authorization');
  if (header?.toLowerCase().startsWith('bearer ')) return header.slice(7).trim();

  const cookieHeader = c.req.header('cookie') ?? '';
  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'mudrexx_session') return decodeURIComponent(rest.join('='));
  }
  return '';
}

/** Resolves the session if one is presented; does not reject anonymous callers. */
export const resolveSession = createMiddleware<AppEnv>(async (c, next) => {
  const container = c.get('container');
  const token = readSessionToken(c);
  c.set('auth', null);

  if (token) {
    const sessions = new SessionService(container);
    const resolved = await sessions.resolve(token);
    if (resolved) {
      c.set('auth', {
        user: resolved.user,
        session: resolved.session,
        requestId: c.get('requestId'),
        ip: clientIp(c),
        userAgent: userAgentOf(c),
      });
      await container.users
        .touchActive(resolved.user.id, clientIp(c), resolved.session.device_id)
        .catch(() => undefined);
    }
  }

  await next();
});

/** Rejects unauthenticated callers with 401 (§57). */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get('auth')) {
    throw new AppError('UNAUTHORIZED', 'Authentication required');
  }
  await next();
});

/** §22 server-side role check → 403. */
export function requireRole(...roles: Role[]) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.get('auth');
    if (!auth) throw new AppError('UNAUTHORIZED', 'Authentication required');
    if (!roles.includes(auth.user.role)) {
      throw new AppError(
        'FORBIDDEN',
        `This action requires one of: ${roles.join(', ')}.`,
        { required: roles, actual: auth.user.role },
      );
    }
    await next();
  });
}

/** §22/§39 demo accounts may read but never mutate. */
export const demoReadOnly = createMiddleware<AppEnv>(async (c, next) => {
  const auth = c.get('auth');
  if (auth?.user.role === 'DEMO_VIEWER') {
    throw new AppError('DEMO_READ_ONLY', 'Demo accounts are read-only.');
  }
  await next();
});
