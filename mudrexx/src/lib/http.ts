import type { Context } from 'hono';
import { sha256Hex } from './crypto';

/** Request-scoped helpers: request id, client IP, device identification. */

export function requestId(c: Context): string {
  const incoming = c.req.header('x-request-id');
  if (incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming)) return incoming;
  return c.get('requestId') ?? crypto.randomUUID();
}

/**
 * Best-effort client IP. Used for audit/history only — never as the sole
 * device identity (§17).
 */
export function clientIp(c: Context): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    ''
  );
}

export function userAgentOf(c: Context): string {
  return c.req.header('user-agent') ?? '';
}

export interface ClientInfo {
  browser: string;
  os: string;
}

/** Deliberately coarse UA parsing — enough for login history, no fingerprinting lib. */
export function parseUserAgent(ua: string): ClientInfo {
  const value = ua || '';
  let browser = 'Unknown';
  if (/Edg\//.test(value)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(value)) browser = 'Opera';
  else if (/Chrome\//.test(value)) browser = 'Chrome';
  else if (/Safari\//.test(value)) browser = 'Safari';
  else if (/Firefox\//.test(value)) browser = 'Firefox';
  else if (/PostmanRuntime|curl|node|undici/i.test(value)) browser = 'API Client';

  let os = 'Unknown';
  if (/Windows NT/.test(value)) os = 'Windows';
  else if (/Android/.test(value)) os = 'Android';
  else if (/iPhone|iPad|iOS/.test(value)) os = 'iOS';
  else if (/Mac OS X|Macintosh/.test(value)) os = 'macOS';
  else if (/Linux/.test(value)) os = 'Linux';

  return { browser, os };
}

/**
 * §17 Device identity.
 *
 * The device is identified by a stable hash of client-hinted signals
 * (user-agent, platform, language, mobile flag). IP is deliberately EXCLUDED:
 * an IP changes on every network switch and is shared by many users, so it is
 * recorded for history but never used as the device identity.
 */
export async function deviceFingerprint(c: Context): Promise<string> {
  const ua = userAgentOf(c);
  const platform = c.req.header('sec-ch-ua-platform') ?? '';
  const mobile = c.req.header('sec-ch-ua-mobile') ?? '';
  const language = c.req.header('accept-language') ?? '';
  const signal = [ua, platform, mobile, language.slice(0, 32)].join('|');
  return (await sha256Hex(signal)).slice(0, 32);
}

export function deviceLabel(info: ClientInfo): string {
  if (info.browser === 'Unknown' && info.os === 'Unknown') return 'Unknown device';
  return `${info.browser} on ${info.os}`;
}
