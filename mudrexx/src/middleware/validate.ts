import type { Context, Env as HonoEnv } from 'hono';
import { z } from 'zod';
import { AppError } from '../http/errors';

/**
 * §48 Validation.
 * Every incoming payload is parsed server-side; frontend validation is never
 * trusted. Failures return a 400 with per-field detail.
 */

export async function parseJsonBody<E extends HonoEnv = HonoEnv>(c: Context<E>): Promise<unknown> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new AppError('VALIDATION_ERROR', 'Expected application/json request body.');
  }
  try {
    return await c.req.json();
  } catch {
    throw new AppError('VALIDATION_ERROR', 'Malformed JSON body.');
  }
}

export function validate<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed.', {
      issues: result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      })),
    });
  }
  return result.data;
}

export async function body<S extends z.ZodTypeAny, E extends HonoEnv = HonoEnv>(
  c: Context<E>,
  schema: S,
): Promise<z.infer<S>> {
  return validate(schema, await parseJsonBody(c));
}

export function query<S extends z.ZodTypeAny, E extends HonoEnv = HonoEnv>(c: Context<E>, schema: S): z.infer<S> {
  const raw: Record<string, string | string[]> = {};
  for (const key of new URL(c.req.url).searchParams.keys()) {
    const values = c.req.queries(key);
    raw[key] = values && values.length > 1 ? values : c.req.query(key) ?? '';
  }
  return validate(schema, raw);
}

/* --------------------------- shared primitives --------------------------- */

export const zEmail = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'A valid email address is required');

export const zPassword = z.string().min(10).max(200);

export const zId = z.string().trim().min(1).max(64);

export const zPagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

export const zHumanId = z
  .string()
  .trim()
  .regex(/^\d{2,5}$/, 'Identification number must be 2-5 digits');
