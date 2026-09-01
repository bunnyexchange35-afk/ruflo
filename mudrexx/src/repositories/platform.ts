import { Db } from '../db/client';
import { newId } from '../lib/crypto';

export interface AuditRow {
  id: string;
  actor_id: string | null;
  actor_role: string;
  action: string;
  target_type: string;
  target_id: string;
  ip: string | null;
  user_agent: string;
  request_id: string;
  meta_json: string;
  created_at: number;
}

/** §38 audited privileged actions. Never store passwords or secrets here. */
export const AUDIT_ACTIONS = {
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  REGISTER: 'REGISTER',
  ADMIN_CREATED: 'ADMIN_CREATED',
  ADMIN_APPROVED: 'ADMIN_APPROVED',
  ADMIN_REJECTED: 'ADMIN_REJECTED',
  ADMIN_BLOCKED: 'ADMIN_BLOCKED',
  ADMIN_UNBLOCKED: 'ADMIN_UNBLOCKED',
  ADMIN_DELETED: 'ADMIN_DELETED',
  PAYMENT_SUBMITTED: 'PAYMENT_SUBMITTED',
  PAYMENT_VERIFIED: 'PAYMENT_VERIFIED',
  PAYMENT_REJECTED: 'PAYMENT_REJECTED',
  PACKAGE_CHANGED: 'PACKAGE_CHANGED',
  PACKAGE_CONFIGURED: 'PACKAGE_CONFIGURED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PASSWORD_RESET_REQUESTED: 'PASSWORD_RESET_REQUESTED',
  PASSWORD_RESET_APPROVED: 'PASSWORD_RESET_APPROVED',
  PASSWORD_RESET_REJECTED: 'PASSWORD_RESET_REJECTED',
  PASSWORD_RESET_COMPLETED: 'PASSWORD_RESET_COMPLETED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  DEVICE_RESET: 'DEVICE_RESET',
  CRM_MUTATION: 'CRM_MUTATION',
  AI_TOOL_ACTION: 'AI_TOOL_ACTION',
  AI_CHAT: 'AI_CHAT',
  CAMPAIGN_PUBLISHED: 'CAMPAIGN_PUBLISHED',
  TELEGRAM_ROUTE: 'TELEGRAM_ROUTE',
  WHATSAPP_CAMPAIGN: 'WHATSAPP_CAMPAIGN',
  PORTAL_CONFIG_UPDATED: 'PORTAL_CONFIG_UPDATED',
  RECOVERY_CODE_MINTED: 'RECOVERY_CODE_MINTED',
  RECOVERY_CODE_CONSUMED: 'RECOVERY_CODE_CONSUMED',
  RECOVERY_DENIED: 'RECOVERY_DENIED',
  RBAC_DENIED: 'RBAC_DENIED',
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export class AuditRepository {
  constructor(private readonly db: Db) {}

  async record(entry: {
    actorId: string | null;
    actorRole: string;
    action: string;
    targetType?: string;
    targetId?: string;
    ip?: string;
    userAgent?: string;
    requestId?: string;
    meta?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO audit_log (id, actor_id, actor_role, action, target_type, target_id, ip,
        user_agent, request_id, meta_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('aud'),
      entry.actorId,
      entry.actorRole,
      entry.action,
      entry.targetType ?? '',
      entry.targetId ?? '',
      entry.ip ?? null,
      entry.userAgent ?? '',
      entry.requestId ?? '',
      JSON.stringify(entry.meta ?? {}),
      Date.now(),
    );
  }

  async list(opts: {
    action?: string;
    actorId?: string;
    targetType?: string;
    since?: number;
    limit: number;
    offset: number;
  }): Promise<{ rows: AuditRow[]; total: number }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.action) {
      clauses.push('action = ?');
      params.push(opts.action);
    }
    if (opts.actorId) {
      clauses.push('actor_id = ?');
      params.push(opts.actorId);
    }
    if (opts.targetType) {
      clauses.push('target_type = ?');
      params.push(opts.targetType);
    }
    if (opts.since) {
      clauses.push('created_at >= ?');
      params.push(opts.since);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.db.many<AuditRow>(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
    const total = await this.db.count(`SELECT COUNT(*) AS c FROM audit_log ${where}`, ...params);
    return { rows, total };
  }
}

export class SettingsRepository {
  constructor(private readonly db: Db) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    const row = await this.db.one<{ value_json: string }>(
      `SELECT value_json FROM settings WHERE key = ?`,
      key,
    );
    if (!row) return fallback;
    try {
      return JSON.parse(row.value_json) as T;
    } catch {
      return fallback;
    }
  }

  async set(key: string, value: unknown, updatedBy?: string | null): Promise<void> {
    await this.db.run(
      `INSERT INTO settings (key, value_json, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      key,
      JSON.stringify(value),
      Date.now(),
      updatedBy ?? null,
    );
  }

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.db.many<{ key: string; value_json: string }>(
      `SELECT key, value_json FROM settings`,
    );
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value_json);
      } catch {
        out[r.key] = null;
      }
    }
    return out;
  }
}

/**
 * §49 fixed-window rate limiter backed by D1.
 * Keyed per bucket so login / password reset / AI / webhooks / bulk messaging
 * each get their own limits.
 */
export class RateLimitRepository {
  constructor(private readonly db: Db) {}

  async checkAndIncrement(
    bucketKey: string,
    limit: number,
    windowMs: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
    const now = Date.now();
    const row = await this.db.one<{ window_start: number; count: number }>(
      `SELECT window_start, count FROM rate_limits WHERE bucket_key = ?`,
      bucketKey,
    );

    if (!row || now - row.window_start >= windowMs) {
      await this.db.run(
        `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(bucket_key) DO UPDATE SET window_start = excluded.window_start,
           count = 1`,
        bucketKey,
        now,
      );
      return { allowed: limit > 0, remaining: Math.max(0, limit - 1), resetAt: now + windowMs };
    }

    const next = row.count + 1;
    await this.db.run(
      `UPDATE rate_limits SET count = ? WHERE bucket_key = ?`,
      next,
      bucketKey,
    );
    return {
      allowed: next <= limit,
      remaining: Math.max(0, limit - next),
      resetAt: row.window_start + windowMs,
    };
  }

  async reset(bucketKey: string): Promise<void> {
    await this.db.run(`DELETE FROM rate_limits WHERE bucket_key = ?`, bucketKey);
  }
}

export class SupportTicketRepository {
  constructor(private readonly db: Db) {}

  async create(input: { userId: string; subject: string; body?: string; priority?: string }) {
    const now = Date.now();
    const id = newId('tkt');
    await this.db.run(
      `INSERT INTO support_tickets (id, user_id, subject, body, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
      id,
      input.userId,
      input.subject,
      input.body ?? '',
      input.priority ?? 'MEDIUM',
      now,
      now,
    );
    return this.db.one<{ id: string; subject: string; status: string; created_at: number }>(
      `SELECT id, subject, status, created_at FROM support_tickets WHERE id = ?`,
      id,
    );
  }

  async list(opts: { userId?: string; limit: number; offset: number }) {
    const params: unknown[] = [];
    let where = '';
    if (opts.userId) {
      where = 'WHERE user_id = ?';
      params.push(opts.userId);
    }
    return this.db.many<{
      id: string;
      user_id: string;
      subject: string;
      status: string;
      priority: string;
      created_at: number;
    }>(
      `SELECT id, user_id, subject, status, priority, created_at FROM support_tickets ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
  }
}

export class InvoiceRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    userId: string;
    paymentId?: string | null;
    amountCents: number;
    currency: string;
  }) {
    const now = Date.now();
    const id = newId('inv');
    const number = `INV-${new Date(now).getUTCFullYear()}-${id.slice(-8).toUpperCase()}`;
    await this.db.run(
      `INSERT INTO invoices (id, user_id, payment_id, number, amount_cents, currency, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?)`,
      id,
      input.userId,
      input.paymentId ?? null,
      number,
      input.amountCents,
      input.currency,
      now,
    );
    return this.db.one<{
      id: string;
      number: string;
      amount_cents: number;
      currency: string;
      status: string;
    }>(
      `SELECT id, number, amount_cents, currency, status FROM invoices WHERE id = ?`,
      id,
    );
  }

  async listForUser(userId: string, limit = 50, offset = 0) {
    return this.db.many<{
      id: string;
      number: string;
      amount_cents: number;
      currency: string;
      status: string;
      created_at: number;
    }>(
      `SELECT id, number, amount_cents, currency, status, created_at FROM invoices
       WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      userId,
      limit,
      offset,
    );
  }
}

export class DocumentRepository {
  constructor(private readonly db: Db) {}

  async create(input: { ownerAdminId: string; kind: string; name: string; storageRef?: string }) {
    const id = newId('doc');
    await this.db.run(
      `INSERT INTO documents (id, owner_admin_id, kind, name, storage_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.ownerAdminId,
      input.kind,
      input.name,
      input.storageRef ?? '',
      Date.now(),
    );
    return this.db.one<{ id: string; name: string; kind: string; created_at: number }>(
      `SELECT id, name, kind, created_at FROM documents WHERE id = ?`,
      id,
    );
  }

  async list(ownerAdminId: string, limit = 50, offset = 0) {
    return this.db.many<{ id: string; name: string; kind: string; created_at: number }>(
      `SELECT id, name, kind, created_at FROM documents WHERE owner_admin_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ownerAdminId,
      limit,
      offset,
    );
  }
}

export class WebhookEventRepository {
  constructor(private readonly db: Db) {}

  async record(input: {
    provider: string;
    eventType: string;
    payload: unknown;
    signatureOk: boolean;
  }): Promise<string> {
    const id = newId('whk');
    await this.db.run(
      `INSERT INTO webhook_events (id, provider, event_type, payload_json, signature_ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.provider,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
      input.signatureOk ? 1 : 0,
      Date.now(),
    );
    return id;
  }

  async markProcessed(id: string): Promise<void> {
    await this.db.run(
      `UPDATE webhook_events SET processed_at = ? WHERE id = ?`,
      Date.now(),
      id,
    );
  }
}
