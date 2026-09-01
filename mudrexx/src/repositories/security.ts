import { Db } from '../db/client';
import { newId, randomToken, sha256Hex } from '../lib/crypto';

export interface LoginHistoryRow {
  id: string;
  user_id: string | null;
  email_key: string;
  session_id: string | null;
  device_id: string | null;
  event: string;
  browser: string;
  os: string;
  ip: string | null;
  reason: string | null;
  created_at: number;
}

export interface PasswordResetRow {
  id: string;
  user_id: string;
  token_hash: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'USED' | 'EXPIRED';
  requested_at: number;
  expires_at: number | null;
  decided_at: number | null;
  decided_by: string | null;
  decision_note: string | null;
  ip: string | null;
  user_agent: string;
}

export interface RecoveryChallengeRow {
  id: string;
  user_id: string | null;
  code_hash: string;
  status: 'PENDING' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
  ip: string | null;
  request_id: string | null;
  rotation_id: string | null;
}

export class LoginHistoryRepository {
  constructor(private readonly db: Db) {}

  async record(entry: {
    userId: string | null;
    emailKey: string;
    sessionId?: string | null;
    deviceId?: string | null;
    event: LoginHistoryRow['event'];
    browser: string;
    os: string;
    ip: string;
    reason?: string | null;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO login_history (id, user_id, email_key, session_id, device_id, event,
        browser, os, ip, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('lgh'),
      entry.userId,
      entry.emailKey.toLowerCase(),
      entry.sessionId ?? null,
      entry.deviceId ?? null,
      entry.event,
      entry.browser,
      entry.os,
      entry.ip,
      entry.reason ?? null,
      Date.now(),
    );
  }

  async listForUser(userId: string, limit = 50, offset = 0): Promise<LoginHistoryRow[]> {
    return this.db.many<LoginHistoryRow>(
      `SELECT * FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      userId,
      limit,
      offset,
    );
  }

  async listRecent(limit = 100, offset = 0): Promise<LoginHistoryRow[]> {
    return this.db.many<LoginHistoryRow>(
      `SELECT * FROM login_history ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      limit,
      offset,
    );
  }

  /** §20 login attempt protection — count recent failures for a key. */
  async countRecentFailures(emailKey: string, sinceMs: number): Promise<number> {
    return this.db.count(
      `SELECT COUNT(*) AS c FROM login_history
       WHERE email_key = ? AND event = 'LOGIN_FAILED' AND created_at >= ?`,
      emailKey.toLowerCase(),
      sinceMs,
    );
  }
}

export class PasswordResetRepository {
  constructor(private readonly db: Db) {}

  async createRequest(input: {
    userId: string;
    ip: string;
    userAgent: string;
    ttlMs: number;
  }): Promise<PasswordResetRow> {
    const now = Date.now();
    const id = newId('pwr');
    await this.db.run(
      `INSERT INTO password_resets (id, user_id, status, requested_at, expires_at, ip, user_agent)
       VALUES (?, ?, 'PENDING', ?, ?, ?, ?)`,
      id,
      input.userId,
      now,
      now + input.ttlMs,
      input.ip,
      input.userAgent,
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<PasswordResetRow | null> {
    return this.db.one<PasswordResetRow>(`SELECT * FROM password_resets WHERE id = ?`, id);
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetRow | null> {
    return this.db.one<PasswordResetRow>(
      `SELECT * FROM password_resets WHERE token_hash = ?`,
      tokenHash,
    );
  }

  async listByStatus(
    status: PasswordResetRow['status'] | 'ALL',
    limit = 50,
    offset = 0,
  ): Promise<PasswordResetRow[]> {
    if (status === 'ALL') {
      return this.db.many<PasswordResetRow>(
        `SELECT * FROM password_resets ORDER BY requested_at DESC LIMIT ? OFFSET ?`,
        limit,
        offset,
      );
    }
    return this.db.many<PasswordResetRow>(
      `SELECT * FROM password_resets WHERE status = ? ORDER BY requested_at DESC LIMIT ? OFFSET ?`,
      status,
      limit,
      offset,
    );
  }

  /** §19/§20 single-use, revocable, short-lived token. */
  async approve(id: string, decidedBy: string, ttlMs: number): Promise<{ token: string }> {
    const token = randomToken(32);
    const tokenHash = await sha256Hex(token);
    await this.db.run(
      `UPDATE password_resets SET status = 'APPROVED', token_hash = ?, decided_at = ?,
        decided_by = ?, expires_at = ?
       WHERE id = ? AND status = 'PENDING'`,
      tokenHash,
      Date.now(),
      decidedBy,
      Date.now() + ttlMs,
      id,
    );
    return { token };
  }

  async reject(id: string, decidedBy: string, note: string): Promise<void> {
    await this.db.run(
      `UPDATE password_resets SET status = 'REJECTED', decided_at = ?, decided_by = ?,
        decision_note = ?
       WHERE id = ? AND status = 'PENDING'`,
      Date.now(),
      decidedBy,
      note,
      id,
    );
  }

  async consume(tokenHash: string): Promise<PasswordResetRow | null> {
    const row = await this.findByTokenHash(tokenHash);
    if (!row) return null;
    if (row.status !== 'APPROVED') return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) {
      await this.db.run(
        `UPDATE password_resets SET status = 'EXPIRED' WHERE id = ?`,
        row.id,
      );
      return null;
    }
    await this.db.run(
      `UPDATE password_resets SET status = 'USED' WHERE id = ?`,
      row.id,
    );
    return { ...row, status: 'USED' };
  }

  async expireStale(): Promise<number> {
    const result = await this.db.run(
      `UPDATE password_resets SET status = 'EXPIRED'
       WHERE status IN ('PENDING','APPROVED') AND expires_at IS NOT NULL AND expires_at <= ?`,
      Date.now(),
    );
    return result.meta?.changes ?? 0;
  }
}

export class PasswordHistoryRepository {
  constructor(private readonly db: Db) {}

  async record(userId: string, passwordHash: string): Promise<void> {
    await this.db.run(
      `INSERT INTO password_history (id, user_id, password_hash, created_at) VALUES (?, ?, ?, ?)`,
      newId('pwd'),
      userId,
      passwordHash,
      Date.now(),
    );
  }

  async recentHashes(userId: string, limit: number): Promise<string[]> {
    const rows = await this.db.many<{ password_hash: string }>(
      `SELECT password_hash FROM password_history WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      userId,
      limit,
    );
    return rows.map((r) => r.password_hash);
  }
}

/**
 * §21 Emergency recovery.
 *
 * There is NO master password and NO hidden bypass. A recovery code can only be
 * minted with the server-side RECOVERY_SECRET, is one-time, time-limited,
 * rate-limited, audited, rotatable, invalidates prior sessions and forces a
 * credential reset. Possession of the secret alone never grants a session.
 */
export class RecoveryRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    userId: string | null;
    codeHash: string;
    ttlMs: number;
    ip: string;
    requestId: string;
    rotationId: string | null;
  }): Promise<RecoveryChallengeRow> {
    const now = Date.now();
    const id = newId('rcv');
    await this.db.run(
      `INSERT INTO recovery_challenges (id, user_id, code_hash, status, created_at, expires_at,
        ip, request_id, rotation_id)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.codeHash,
      now,
      now + input.ttlMs,
      input.ip,
      input.requestId,
      input.rotationId,
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<RecoveryChallengeRow | null> {
    return this.db.one<RecoveryChallengeRow>(
      `SELECT * FROM recovery_challenges WHERE id = ?`,
      id,
    );
  }

  async findByCodeHash(codeHash: string): Promise<RecoveryChallengeRow | null> {
    return this.db.one<RecoveryChallengeRow>(
      `SELECT * FROM recovery_challenges WHERE code_hash = ?`,
      codeHash,
    );
  }

  async consume(codeHash: string, rotationId: string | null): Promise<RecoveryChallengeRow | null> {
    const row = await this.findByCodeHash(codeHash);
    if (!row) return null;
    if (row.status !== 'PENDING') return null;
    if (row.expires_at <= Date.now()) {
      await this.db.run(
        `UPDATE recovery_challenges SET status = 'EXPIRED' WHERE id = ?`,
        row.id,
      );
      return null;
    }
    // A rotation invalidates every challenge minted under a different rotation id.
    if (rotationId && row.rotation_id && row.rotation_id !== rotationId) {
      await this.db.run(
        `UPDATE recovery_challenges SET status = 'REVOKED' WHERE id = ?`,
        row.id,
      );
      return null;
    }
    await this.db.run(
      `UPDATE recovery_challenges SET status = 'CONSUMED', consumed_at = ? WHERE id = ?`,
      Date.now(),
      row.id,
    );
    return { ...row, status: 'CONSUMED' };
  }

  async revokeAllPending(): Promise<number> {
    const result = await this.db.run(
      `UPDATE recovery_challenges SET status = 'REVOKED' WHERE status = 'PENDING'`,
    );
    return result.meta?.changes ?? 0;
  }

  async countRecent(ip: string, sinceMs: number): Promise<number> {
    return this.db.count(
      `SELECT COUNT(*) AS c FROM recovery_challenges WHERE ip = ? AND created_at >= ?`,
      ip,
      sinceMs,
    );
  }
}
