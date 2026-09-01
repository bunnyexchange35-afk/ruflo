/* D1Database is an ambient global from @cloudflare/workers-types. */

/**
 * Human-facing identification numbers (§11, §12).
 *
 * Rules: 2-5 digits only, numeric, unique, persistent, human readable.
 *   valid   : 10, 105, 1007, 45892
 *   invalid : 1, 123456, USR001, USER-01
 *
 * This is NOT the internal primary key — the internal id stays a UUID.
 */

export const HUMAN_ID_MIN = 10;
export const HUMAN_ID_MAX = 99999;
const HUMAN_ID_PATTERN = /^\d{2,5}$/;

export function isValidHumanId(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (!HUMAN_ID_PATTERN.test(value)) return false;
  const n = Number(value);
  return n >= HUMAN_ID_MIN && n <= HUMAN_ID_MAX;
}

function randomCandidate(): number {
  const range = HUMAN_ID_MAX - HUMAN_ID_MIN + 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return HUMAN_ID_MIN + (buf[0] % range);
}

async function exists(db: D1Database, sql: string, value: string): Promise<boolean> {
  const row = await db
    .prepare(sql)
    .bind(value)
    .first<{ c: number }>();
  return !!row && row.c > 0;
}

/**
 * Allocate a unique 2-5 digit human ID.
 * Random probing first (does not leak how many accounts exist), then a
 * deterministic scan as a guaranteed-terminating fallback.
 */
export async function allocateHumanId(
  db: D1Database,
  table: 'users' | 'admin_profiles',
  column: 'human_id' | 'admin_id',
): Promise<string> {
  const checkSql = `SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = String(randomCandidate());
    if (!(await exists(db, checkSql, candidate))) return candidate;
  }

  // Deterministic fallback: scan the space for the first free slot.
  for (let n = HUMAN_ID_MIN; n <= HUMAN_ID_MAX; n += 1) {
    const candidate = String(n);
    if (!(await exists(db, checkSql, candidate))) return candidate;
  }

  throw new Error('HUMAN_ID_SPACE_EXHAUSTED');
}
