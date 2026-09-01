import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../app-types';
import { AppError } from '../http/errors';
import { clientIp } from '../lib/http';
import { AUDIT_ACTIONS } from '../repositories/platform';

/**
 * §49 Rate limiting.
 * Buckets are scoped per IP + route group so one endpoint can never exhaust
 * another's budget.
 */
export function rateLimit(options: { bucket: string; limit: number; windowMs: number }) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const container = c.get('container');
    const ip = clientIp(c) || 'unknown';
    const bucketKey = `${options.bucket}:${ip}`;

    const result = await container.rateLimits.checkAndIncrement(
      bucketKey,
      options.limit,
      options.windowMs,
    );

    c.header('x-ratelimit-limit', String(options.limit));
    c.header('x-ratelimit-remaining', String(result.remaining));

    if (!result.allowed) {
      await container.audit.record({
        actorId: c.get('auth')?.user.id ?? null,
        actorRole: c.get('auth')?.user.role ?? '',
        action: AUDIT_ACTIONS.RATE_LIMITED,
        targetType: 'rate_limit',
        targetId: bucketKey,
        ip,
        requestId: c.get('requestId'),
        meta: { bucket: options.bucket },
      });
      throw new AppError('RATE_LIMITED', 'Too many requests. Please slow down.', {
        resetAt: result.resetAt,
      });
    }

    await next();
  });
}
