import { beforeEach, describe, expect, it } from 'vitest';
import { freshDatabase, initSchema, testDb } from '../helpers/db';
import { hashPassword, randomToken, sha256Hex, timingSafeEqual, verifyPassword } from '../../src/lib/crypto';
import { allocateHumanId, isValidHumanId, HUMAN_ID_MAX, HUMAN_ID_MIN } from '../../src/lib/ids';
import { parseCsv } from '../../src/services/crm-service';
import { normalizePhone } from '../../src/repositories/crm';
import { resolveRange } from '../../src/services/task-service';
import { ERROR_STATUS, AppError } from '../../src/http/errors';

describe('password hashing (§20)', () => {
  it('round-trips a password', async () => {
    const hash = await hashPassword('CorrectHorse-42');
    expect(await verifyPassword('CorrectHorse-42', hash)).toBe(true);
    expect(await verifyPassword('WrongHorse-42', hash)).toBe(false);
  });

  it('stores a salted PBKDF2 digest, never the password', async () => {
    const hash = await hashPassword('CorrectHorse-42');
    expect(hash).toMatch(/^PBKDF2-SHA256\$210000\$/);
    expect(hash).not.toContain('CorrectHorse');
  });

  it('salts each hash independently', async () => {
    const a = await hashPassword('Same-Password-1');
    const b = await hashPassword('Same-Password-1');
    expect(a).not.toBe(b);
    expect(await verifyPassword('Same-Password-1', b)).toBe(true);
  });

  it('rejects a malformed stored hash', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});

describe('tokens and comparison (§20)', () => {
  it('generates unique high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken(32)));
    expect(tokens.size).toBe(200);
  });

  it('hashes deterministically and is not reversible-looking', async () => {
    const digest = await sha256Hex('abc');
    expect(digest).toBe(await sha256Hex('abc'));
    expect(digest).not.toBe(await sha256Hex('abd'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('compares in constant time', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3]);
    const c = new Uint8Array([1, 2, 4]);
    expect(timingSafeEqual(a, b)).toBe(true);
    expect(timingSafeEqual(a, c)).toBe(false);
    expect(timingSafeEqual(a, new Uint8Array([1, 2]))).toBe(false);
  });
});

describe('human identification numbers (§11, §12)', () => {
  it('accepts 2-5 digit numbers only', () => {
    for (const valid of ['10', '105', '1007', '45892']) {
      expect(isValidHumanId(valid), valid).toBe(true);
    }
    for (const invalid of ['1', '123456', 'USR001', 'USER-01', '', '12a', 105, null, undefined]) {
      expect(isValidHumanId(invalid), String(invalid)).toBe(false);
    }
  });

  it('allocates unique in-range IDs (§11)', async () => {
    await freshDatabase();
    const seen = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      const id = await allocateHumanId(testDb(), 'users', 'human_id');
      expect(id).toMatch(/^\d{2,5}$/);
      const n = Number(id);
      expect(n).toBeGreaterThanOrEqual(HUMAN_ID_MIN);
      expect(n).toBeLessThanOrEqual(HUMAN_ID_MAX);
      expect(seen.has(id)).toBe(false);
      seen.add(id);
      // Persist so the allocator's uniqueness check is genuinely exercised.
      await testDb()
        .prepare(`INSERT INTO users (id, human_id, password_hash, role, status, created_at, updated_at)
                  VALUES (?, ?, 'x', 'USER', 'ACTIVE', 0, 0)`)
        .bind(`u${i}`, id)
        .run();
    }
    expect(seen.size).toBe(60);
  });
});

describe('CSV parsing (§31)', () => {
  it('parses simple rows', () => {
    const rows = parseCsv('name,phone\nAda,123\nGrace,456\n');
    expect(rows).toEqual([
      ['name', 'phone'],
      ['Ada', '123'],
      ['Grace', '456'],
    ]);
  });

  it('handles quoted fields, embedded commas and escaped quotes', () => {
    const rows = parseCsv('name,note\n"Ada, L","she said ""hi"""\n');
    expect(rows[1]).toEqual(['Ada, L', 'she said "hi"']);
  });

  it('handles CRLF line endings', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('phone normalisation (§31)', () => {
  it('keeps digits and a leading plus', () => {
    expect(normalizePhone('+91 99000 00001').e164).toBe('+919900000001');
    expect(normalizePhone('9900000001').e164).toBe('9900000001');
    expect(normalizePhone('(555) 123-4567').e164).toBe('5551234567');
  });

  it('returns an empty E.164 for unusable input', () => {
    expect(normalizePhone('no-digits').e164).toBe('');
    expect(normalizePhone('').e164).toBe('');
  });
});

describe('joining-date ranges (§36)', () => {
  it('returns an ordered range for today', () => {
    const { from, to } = resolveRange({ preset: 'today' });
    expect(to).toBeGreaterThan(from);
    expect(to - from).toBe(24 * 60 * 60 * 1000);
  });

  it('returns ordered ranges for every preset', () => {
    for (const preset of ['yesterday', 'this_week', 'last_week', 'this_month', 'last_month'] as const) {
      const { from, to } = resolveRange({ preset });
      expect(to, preset).toBeGreaterThan(from);
    }
  });

  it('validates custom ranges', () => {
    const { from, to } = resolveRange({ preset: 'custom', from: '2026-01-01', to: '2026-02-01' });
    expect(to).toBeGreaterThan(from);

    expect(() => resolveRange({ preset: 'custom', from: '2026-02-01', to: '2026-01-01' })).toThrow(
      /earlier/,
    );
    expect(() => resolveRange({ preset: 'custom' })).toThrow(/valid from/);
  });
});

describe('error contract (§47)', () => {
  it('maps every error code to a documented HTTP status', () => {
    const documented = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503];
    for (const status of Object.values(ERROR_STATUS)) {
      expect(documented, String(status)).toContain(status);
    }
  });

  it('carries code, status and message', () => {
    const err = new AppError('FORBIDDEN', 'Nope', { hint: 'x' });
    expect(err.code).toBe('FORBIDDEN');
    expect(err.status).toBe(403);
    expect(err.details).toEqual({ hint: 'x' });
  });
});
