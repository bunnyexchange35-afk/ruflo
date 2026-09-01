/* D1Database / D1Result are ambient globals from @cloudflare/workers-types. */

/**
 * Thin typed wrapper over D1. Repositories use this instead of touching
 * `env.DB` directly so that SQL lives in exactly one layer (§43, §44).
 */

/** D1 has no boolean type; normalise JS values before binding. */
function normalizeParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p === undefined) return null;
    return p;
  });
}

export class Db {
  constructor(private readonly db: D1Database) {}

  /** Escape hatch for helpers that need the raw binding (e.g. ID allocation). */
  get raw(): D1Database {
    return this.db;
  }

  async one<T>(sql: string, ...params: unknown[]): Promise<T | null> {
    const stmt = this.db.prepare(sql);
    const bound = params.length ? stmt.bind(...(normalizeParams(params) as never[])) : stmt;
    return (await bound.first<T>()) ?? null;
  }

  async many<T>(sql: string, ...params: unknown[]): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const bound = params.length ? stmt.bind(...(normalizeParams(params) as never[])) : stmt;
    const result = await bound.all<T>();
    return result.results ?? [];
  }

  async run(sql: string, ...params: unknown[]): Promise<D1Result> {
    const stmt = this.db.prepare(sql);
    const bound = params.length ? stmt.bind(...(normalizeParams(params) as never[])) : stmt;
    return await bound.run();
  }

  /** Execute multiple statements atomically (D1 batch is a single transaction). */
  async batch(statements: { sql: string; params?: unknown[] }[]): Promise<D1Result[]> {
    return await this.db.batch(
      statements.map((s) => {
        const stmt = this.db.prepare(s.sql);
        const params = s.params ? normalizeParams(s.params) : [];
        return params.length ? stmt.bind(...(params as never[])) : stmt;
      }),
    );
  }

  /** Raw multi-statement execution — used by the test harness to apply migrations. */
  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async count(sql: string, ...params: unknown[]): Promise<number> {
    const row = await this.one<{ c: number }>(sql, ...params);
    return row ? Number(row.c) : 0;
  }
}
