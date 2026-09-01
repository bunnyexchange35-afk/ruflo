import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-types';

/**
 * §51 Observability.
 *
 * Logs method, path, status, duration, request id and environment ONLY.
 * Passwords, tokens, API keys, cookies and secrets are never logged.
 */
export const observability = createMiddleware<AppEnv>(async (c, next) => {
  const requestId = c.req.header('x-request-id') || crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('x-request-id', requestId);

  const started = Date.now();
  await next();
  const duration = Date.now() - started;

  const log = {
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: duration,
    environment: c.env.ENVIRONMENT ?? 'production',
  };
  console.log(JSON.stringify({ type: 'request', ...log }));
});
