import { Db } from '../db/client';
import { newId } from '../lib/crypto';
import type { SessionRow } from '../types';

export interface DeviceRow {
  id: string;
  user_id: string;
  fingerprint: string;
  label: string;
  browser: string;
  os: string;
  ip: string | null;
  first_seen_at: number;
  last_seen_at: number;
  revoked_at: number | null;
}

const SESSION_COLUMNS = `id, user_id, token_hash, device_id, ip, user_agent, browser, os,
  created_at, last_activity_at, expires_at, revoked_at, revoked_reason, is_demo`;

export class SessionRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    deviceId: string | null;
    ip: string;
    userAgent: string;
    browser: string;
    os: string;
    ttlMs: number;
    isDemo?: boolean;
  }): Promise<SessionRow> {
    const now = Date.now();
    const id = newId('ses');
    await this.db.run(
      `INSERT INTO sessions (id, user_id, token_hash, device_id, ip, user_agent, browser, os,
        created_at, last_activity_at, expires_at, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.tokenHash,
      input.deviceId,
      input.ip,
      input.userAgent,
      input.browser,
      input.os,
      now,
      now,
      now + input.ttlMs,
      input.isDemo ? 1 : 0,
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<SessionRow | null> {
    return this.db.one<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, id);
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    return this.db.one<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE token_hash = ?`,
      tokenHash,
    );
  }

  /** Returns the session only if it is un-revoked and un-expired. */
  async findValidByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const row = await this.findByTokenHash(tokenHash);
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (row.expires_at <= Date.now()) return null;
    return row;
  }

  async touch(id: string): Promise<void> {
    await this.db.run(`UPDATE sessions SET last_activity_at = ? WHERE id = ?`, Date.now(), id);
  }

  async revoke(id: string, reason: string): Promise<void> {
    await this.db.run(
      `UPDATE sessions SET revoked_at = ?, revoked_reason = ? WHERE id = ? AND revoked_at IS NULL`,
      Date.now(),
      reason,
      id,
    );
  }

  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    const result = await this.db.run(
      `UPDATE sessions SET revoked_at = ?, revoked_reason = ?
       WHERE user_id = ? AND revoked_at IS NULL`,
      Date.now(),
      reason,
      userId,
    );
    return result.meta?.changes ?? 0;
  }

  /** §17 one active session per admin: keep only `keepId`. */
  async revokeOthersForUser(userId: string, keepId: string, reason: string): Promise<number> {
    const result = await this.db.run(
      `UPDATE sessions SET revoked_at = ?, revoked_reason = ?
       WHERE user_id = ? AND id != ? AND revoked_at IS NULL`,
      Date.now(),
      reason,
      userId,
      keepId,
    );
    return result.meta?.changes ?? 0;
  }

  async listActiveForUser(userId: string): Promise<SessionRow[]> {
    return this.db.many<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_activity_at DESC`,
      userId,
      Date.now(),
    );
  }

  async listAll(opts: { limit: number; offset: number; activeOnly?: boolean }): Promise<SessionRow[]> {
    const active = opts.activeOnly ? 'AND revoked_at IS NULL AND expires_at > ?' : '';
    const params: unknown[] = [];
    if (opts.activeOnly) params.push(Date.now());
    return this.db.many<SessionRow>(
      `SELECT ${SESSION_COLUMNS} FROM sessions WHERE 1=1 ${active}
       ORDER BY last_activity_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
  }

  async countActive(): Promise<number> {
    return this.db.count(
      `SELECT COUNT(*) AS c FROM sessions WHERE revoked_at IS NULL AND expires_at > ?`,
      Date.now(),
    );
  }

  async purgeExpired(): Promise<number> {
    const result = await this.db.run(
      `DELETE FROM sessions WHERE expires_at <= ? AND revoked_at IS NOT NULL`,
      Date.now(),
    );
    return result.meta?.changes ?? 0;
  }
}

export class DeviceRepository {
  constructor(private readonly db: Db) {}

  /**
   * Resolve or register a device.
   * Returns `{ device, isNew }`. Revoked devices are treated as unknown so a
   * Chief "reset device" forces re-registration on the next login.
   */
  async resolve(input: {
    userId: string;
    fingerprint: string;
    label: string;
    browser: string;
    os: string;
    ip: string;
  }): Promise<{ device: DeviceRow; isNew: boolean }> {
    const existing = await this.db.one<DeviceRow>(
      `SELECT * FROM devices WHERE user_id = ? AND fingerprint = ?`,
      input.userId,
      input.fingerprint,
    );

    if (existing && existing.revoked_at === null) {
      await this.db.run(
        `UPDATE devices SET last_seen_at = ?, ip = ?, label = ?, browser = ?, os = ?
         WHERE id = ?`,
        Date.now(),
        input.ip,
        input.label,
        input.browser,
        input.os,
        existing.id,
      );
      return { device: { ...existing, last_seen_at: Date.now() }, isNew: false };
    }

    const now = Date.now();
    const id = newId('dev');
    await this.db.run(
      `INSERT INTO devices (id, user_id, fingerprint, label, browser, os, ip, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.fingerprint,
      input.label,
      input.browser,
      input.os,
      input.ip,
      now,
      now,
    );
    return { device: (await this.findById(id))!, isNew: true };
  }

  async findById(id: string): Promise<DeviceRow | null> {
    return this.db.one<DeviceRow>(`SELECT * FROM devices WHERE id = ?`, id);
  }

  async findByFingerprint(userId: string, fingerprint: string): Promise<DeviceRow | null> {
    return this.db.one<DeviceRow>(
      `SELECT * FROM devices WHERE user_id = ? AND fingerprint = ?`,
      userId,
      fingerprint,
    );
  }

  async listForUser(userId: string): Promise<DeviceRow[]> {
    return this.db.many<DeviceRow>(
      `SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC`,
      userId,
    );
  }

  async activeDeviceForUser(userId: string): Promise<DeviceRow | null> {
    return this.db.one<DeviceRow>(
      `SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 1`,
      userId,
    );
  }

  /** §41 Chief "reset device" — revokes every registered device for the admin. */
  async resetAllForUser(userId: string): Promise<number> {
    const result = await this.db.run(
      `UPDATE devices SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
      Date.now(),
      userId,
    );
    return result.meta?.changes ?? 0;
  }

  async revoke(id: string): Promise<void> {
    await this.db.run(
      `UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      Date.now(),
      id,
    );
  }
}
