import type { Context } from 'hono';
import { AppError, fail } from '../http/errors';

/**
 * §47 Every API failure returns JSON — never HTML, never a stack trace.
 * Stack traces are only logged server-side, and only outside production.
 */
/** Hono calls the error handler as `(err, c)`. */
export function errorBoundary(err: unknown, c: Context) {
  const isProduction = (c.env?.ENVIRONMENT ?? 'production') === 'production';

  if (err instanceof AppError) {
    if (!isProduction) console.error(JSON.stringify({ type: 'app_error', code: err.code, message: err.message }));
    return fail(c, err.code, err.message, err.details);
  }

  console.error(
    JSON.stringify({
      type: 'unhandled_error',
      requestId: c.get?.('requestId') ?? '',
      message: (err as Error)?.message ?? String(err),
      stack: isProduction ? undefined : (err as Error)?.stack,
    }),
  );

  return fail(
    c,
    'INTERNAL_ERROR',
    isProduction ? 'An unexpected error occurred.' : (err as Error)?.message ?? 'Unexpected error',
  );
}
