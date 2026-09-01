import type { Context } from 'hono';

/**
 * §47 API error contract — every API response is JSON with a stable shape.
 *   { "success": true,  "data": ... }
 *   { "success": false, "error": { "code": "...", "message": "..." } }
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_PENDING_APPROVAL'
  | 'PAYMENT_REQUIRED'
  | 'DEMO_READ_ONLY'
  | 'CONFIRMATION_REQUIRED'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PROVIDER_ERROR'
  | 'INTERNAL_ERROR';

export const ERROR_STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  ACCOUNT_LOCKED: 403,
  ACCOUNT_PENDING_APPROVAL: 403,
  // §47 keeps responses inside the documented status set; 403 for gated accounts.
  PAYMENT_REQUIRED: 403,
  DEMO_READ_ONLY: 403,
  CONFIRMATION_REQUIRED: 409,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_ERROR: 502,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export interface ApiErrorBody {
  success: false;
  error: { code: ErrorCode; message: string; details?: unknown };
}

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export function ok<T>(c: Context, data: T, status = 200, meta?: Record<string, unknown>) {
  const body: ApiSuccessBody<T> = meta ? { success: true, data, meta } : { success: true, data };
  return c.json(body, status as never);
}

export function fail(c: Context, code: ErrorCode, message: string, details?: unknown) {
  const body: ApiErrorBody = { success: false, error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return c.json(body, ERROR_STATUS[code] as never);
}

/** Validation helper that throws a 400 AppError with field detail. */
export function invalid(message: string, details?: unknown): never {
  throw new AppError('VALIDATION_ERROR', message, details);
}
