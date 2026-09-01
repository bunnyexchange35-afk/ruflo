import { env } from 'cloudflare:test';
import migrationSql from '../../migrations/0001_init.sql?raw';

/** The test Worker's D1 binding. */
export function testDb(): D1Database {
  return (env as unknown as { DB: D1Database }).DB;
}

/**
 * Apply the real migration file to the test D1 database, so tests run against
 * exactly the schema production uses.
 *
 * D1's `exec` rejects comment-only chunks, so comments are stripped and the
 * file is executed statement by statement. (The schema contains no semicolons
 * inside string literals, so splitting on `;` is safe here.)
 */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export async function initSchema(db: D1Database = testDb()): Promise<void> {
  for (const statement of statements(migrationSql)) {
    await db.prepare(statement).run();
  }
}

export async function resetDatabase(db: D1Database = testDb()): Promise<void> {
  const tables = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'`,
    )
    .all<{ name: string }>();
  for (const row of tables.results ?? []) {
    await db.prepare(`DELETE FROM ${row.name}`).run();
  }
}

/* ------------------------------ test helpers ------------------------------ */

export function jsonRequest(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers ?? {}),
  };
  return new Request(`https://test.mudrexx.local${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * Deterministic per-test database state: ensure the schema exists, then clear
 * every table (including rate-limit buckets) so tests never influence one another.
 */
export async function freshDatabase(): Promise<void> {
  await initSchema();
  await resetDatabase();
}
