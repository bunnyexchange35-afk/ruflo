import type { Context } from 'hono';
import { SESSION_COOKIE } from '../config';

/**
 * The session cookie is HttpOnly and SameSite so browser JavaScript can neither
 * read nor replay it. Authorization is always resolved server-side from the
 * session row — never from a client-stored value.
 */
export function setSessionCookie(c: Context, token: string, maxAgeSeconds: number): void {
  const secure = (c.env?.ENVIRONMENT ?? 'production') !== 'test';
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${secure ? 'Strict' : 'Lax'}`,
    'Max-Age=' + maxAgeSeconds,
  ];
  if (secure) parts.push('Secure');
  c.header('set-cookie', parts.join('; '), { append: true });
}

export function clearSessionCookie(c: Context): void {
  const secure = (c.env?.ENVIRONMENT ?? 'production') !== 'test';
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    `SameSite=${secure ? 'Strict' : 'Lax'}`,
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  c.header('set-cookie', parts.join('; '), { append: true });
}
