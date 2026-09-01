import { Db } from '../db/client';
import { newId } from '../lib/crypto';
import type { PaymentStatus } from '../types';

export interface PackageRow {
  id: string;
  code: string;
  name: string;
  currency: string;
  is_active: number;
  limits_json: string;
  created_at: number;
  updated_at: number;
}

export interface PackagePriceRow {
  id: string;
  package_id: string;
  period: 'MONTHLY' | 'QUARTERLY' | 'HALF_YEARLY' | 'ANNUAL';
  price_cents: number;
  currency: string;
  is_active: number;
}

export interface PackageAddonRow {
  id: string;
  package_id: string;
  kind: 'ADDITIONAL_USER' | 'ADDITIONAL_LEAD' | 'ADDITIONAL_MESSAGE' | 'ADDITIONAL_STORAGE';
  unit_price_cents: number;
  currency: string;
}

export interface PaymentRow {
  id: string;
  admin_id: string;
  package_id: string | null;
  amount_cents: number;
  currency: string;
  period: string;
  method: string;
  reference: string;
  status: PaymentStatus;
  submitted_at: number | null;
  reviewed_at: number | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  notes: string;
  created_at: number;
  updated_at: number;
}

export interface PackageLimits {
  userLimit: number;
  leadLimit: number;
  contactLimit: number;
  aiUsage: number;
  whatsappUsage: number;
  storageMb: number;
  crm: boolean;
  ai: boolean;
  automation: boolean;
  documents: boolean;
  invoices: boolean;
  api: boolean;
  support: boolean;
}

export const DEFAULT_LIMITS: PackageLimits = {
  userLimit: 5,
  leadLimit: 1000,
  contactLimit: 1000,
  aiUsage: 0,
  whatsappUsage: 0,
  storageMb: 100,
  crm: true,
  ai: false,
  automation: false,
  documents: false,
  invoices: false,
  api: false,
  support: true,
};

export function parseLimits(json: string): PackageLimits {
  try {
    return { ...DEFAULT_LIMITS, ...(JSON.parse(json || '{}') as Partial<PackageLimits>) };
  } catch {
    return { ...DEFAULT_LIMITS };
  }
}

export class PackageRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    code: string;
    name: string;
    currency: string;
    limits: Partial<PackageLimits>;
  }): Promise<PackageRow> {
    const now = Date.now();
    const id = newId('pkg');
    await this.db.run(
      `INSERT INTO packages (id, code, name, currency, is_active, limits_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
      id,
      input.code.toUpperCase(),
      input.name,
      input.currency,
      JSON.stringify({ ...DEFAULT_LIMITS, ...input.limits }),
      now,
      now,
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<PackageRow | null> {
    return this.db.one<PackageRow>(`SELECT * FROM packages WHERE id = ?`, id);
  }

  async findByCode(code: string): Promise<PackageRow | null> {
    return this.db.one<PackageRow>(`SELECT * FROM packages WHERE code = ?`, code.toUpperCase());
  }

  async list(activeOnly = false): Promise<PackageRow[]> {
    return this.db.many<PackageRow>(
      `SELECT * FROM packages ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY code`,
    );
  }

  async update(id: string, patch: Partial<PackageRow> & { limits?: Partial<PackageLimits> }): Promise<PackageRow | null> {
    const now = Date.now();
    if (patch.limits) {
      const current = await this.findById(id);
      const merged = { ...parseLimits(current?.limits_json ?? '{}'), ...patch.limits };
      await this.db.run(
        `UPDATE packages SET limits_json = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(merged),
        now,
        id,
      );
    }
    const keys = Object.keys(patch).filter((k) => !['id', 'limits'].includes(k));
    if (keys.length) {
      const assignments = keys.map((k) => `${k} = ?`).join(', ');
      const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
      await this.db.run(
        `UPDATE packages SET ${assignments}, updated_at = ? WHERE id = ?`,
        ...values,
        now,
        id,
      );
    }
    return this.findById(id);
  }

  /* ----------------------------- pricing (§16) ---------------------------- */

  async setPrice(input: {
    packageId: string;
    period: PackagePriceRow['period'];
    priceCents: number;
    currency: string;
  }): Promise<PackagePriceRow> {
    const existing = await this.db.one<PackagePriceRow>(
      `SELECT * FROM package_prices WHERE package_id = ? AND period = ?`,
      input.packageId,
      input.period,
    );
    if (existing) {
      await this.db.run(
        `UPDATE package_prices SET price_cents = ?, currency = ? WHERE id = ?`,
        input.priceCents,
        input.currency,
        existing.id,
      );
      return (await this.db.one<PackagePriceRow>(
        `SELECT * FROM package_prices WHERE id = ?`,
        existing.id,
      ))!;
    }
    const id = newId('prc');
    await this.db.run(
      `INSERT INTO package_prices (id, package_id, period, price_cents, currency, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      id,
      input.packageId,
      input.period,
      input.priceCents,
      input.currency,
    );
    return (await this.db.one<PackagePriceRow>(`SELECT * FROM package_prices WHERE id = ?`, id))!;
  }

  async pricesFor(packageId: string): Promise<PackagePriceRow[]> {
    return this.db.many<PackagePriceRow>(
      `SELECT * FROM package_prices WHERE package_id = ? ORDER BY period`,
      packageId,
    );
  }

  async setAddon(input: {
    packageId: string;
    kind: PackageAddonRow['kind'];
    unitPriceCents: number;
    currency: string;
  }): Promise<PackageAddonRow> {
    const existing = await this.db.one<PackageAddonRow>(
      `SELECT * FROM package_addons WHERE package_id = ? AND kind = ?`,
      input.packageId,
      input.kind,
    );
    if (existing) {
      await this.db.run(
        `UPDATE package_addons SET unit_price_cents = ?, currency = ? WHERE id = ?`,
        input.unitPriceCents,
        input.currency,
        existing.id,
      );
      return (await this.db.one<PackageAddonRow>(
        `SELECT * FROM package_addons WHERE id = ?`,
        existing.id,
      ))!;
    }
    const id = newId('add');
    await this.db.run(
      `INSERT INTO package_addons (id, package_id, kind, unit_price_cents, currency)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      input.packageId,
      input.kind,
      input.unitPriceCents,
      input.currency,
    );
    return (await this.db.one<PackageAddonRow>(`SELECT * FROM package_addons WHERE id = ?`, id))!;
  }

  async addonsFor(packageId: string): Promise<PackageAddonRow[]> {
    return this.db.many<PackageAddonRow>(
      `SELECT * FROM package_addons WHERE package_id = ? ORDER BY kind`,
      packageId,
    );
  }

  /** §16 market reference — recorded, never auto-applied. */
  async recordMarketRate(input: {
    key: string;
    valueCents: number;
    currency: string;
    source: string;
    note?: string;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO market_rates (id, key, value_cents, currency, source, observed_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId('mkt'),
      input.key,
      input.valueCents,
      input.currency,
      input.source,
      Date.now(),
      input.note ?? '',
    );
  }

  async latestMarketRates(limit = 50): Promise<
    { id: string; key: string; value_cents: number; currency: string; source: string; observed_at: number; note: string }[]
  > {
    return this.db.many(
      `SELECT * FROM market_rates ORDER BY observed_at DESC LIMIT ?`,
      limit,
    );
  }
}

export class PaymentRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    adminId: string;
    packageId: string | null;
    amountCents: number;
    currency: string;
    period: string;
    method: string;
    reference: string;
  }): Promise<PaymentRow> {
    const now = Date.now();
    const id = newId('pay');
    await this.db.run(
      `INSERT INTO payments (id, admin_id, package_id, amount_cents, currency, period, method,
        reference, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
      id,
      input.adminId,
      input.packageId,
      input.amountCents,
      input.currency,
      input.period,
      input.method,
      input.reference,
      now,
      now,
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<PaymentRow | null> {
    return this.db.one<PaymentRow>(`SELECT * FROM payments WHERE id = ?`, id);
  }

  async listForAdmin(adminId: string): Promise<PaymentRow[]> {
    return this.db.many<PaymentRow>(
      `SELECT * FROM payments WHERE admin_id = ? ORDER BY created_at DESC`,
      adminId,
    );
  }

  async list(opts: {
    status?: PaymentStatus | 'ALL';
    limit: number;
    offset: number;
  }): Promise<{ rows: PaymentRow[]; total: number }> {
    const hasStatus = opts.status && opts.status !== 'ALL';
    const where = hasStatus ? 'WHERE status = ?' : '';
    const params: unknown[] = hasStatus ? [opts.status] : [];
    const rows = await this.db.many<PaymentRow>(
      `SELECT * FROM payments ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM payments ${where}`,
      ...params,
    );
    return { rows, total };
  }

  async submit(id: string): Promise<void> {
    await this.db.run(
      `UPDATE payments SET status = 'SUBMITTED', submitted_at = ?, updated_at = ?
       WHERE id = ? AND status IN ('PENDING','REJECTED')`,
      Date.now(),
      Date.now(),
      id,
    );
  }

  /**
   * §14 status transition. `actorId` (the Chief) is recorded; the service layer
   * refuses when the actor is the admin who owns the payment.
   */
  async transition(input: {
    id: string;
    status: PaymentStatus;
    actorId: string;
    note?: string;
    reason?: string;
  }): Promise<PaymentRow | null> {
    await this.db.run(
      `UPDATE payments SET status = ?, reviewed_at = ?, reviewed_by = ?,
        rejection_reason = ?, notes = ?, updated_at = ?
       WHERE id = ?`,
      input.status,
      Date.now(),
      input.actorId,
      input.reason ?? null,
      input.note ?? '',
      Date.now(),
      input.id,
    );
    return this.findById(input.id);
  }

  async latestForAdmin(adminId: string): Promise<PaymentRow | null> {
    return this.db.one<PaymentRow>(
      `SELECT * FROM payments WHERE admin_id = ? ORDER BY created_at DESC LIMIT 1`,
      adminId,
    );
  }
}

export class WalletRepository {
  constructor(private readonly db: Db) {}

  async ensure(userId: string, currency = 'INR'): Promise<void> {
    await this.db.run(
      `INSERT OR IGNORE INTO wallets (id, user_id, currency, balance_cents, frozen_cents, updated_at)
       VALUES (?, ?, ?, 0, 0, ?)`,
      newId('wlt'),
      userId,
      currency,
      Date.now(),
    );
  }

  async get(userId: string, currency = 'INR'): Promise<{ balance_cents: number; frozen_cents: number } | null> {
    await this.ensure(userId, currency);
    return this.db.one<{ balance_cents: number; frozen_cents: number }>(
      `SELECT balance_cents, frozen_cents FROM wallets WHERE user_id = ? AND currency = ?`,
      userId,
      currency,
    );
  }

  async adjust(input: {
    userId: string;
    deltaCents: number;
    reason: string;
    ref?: string;
    actorId?: string;
    currency?: string;
  }): Promise<number> {
    const currency = input.currency ?? 'INR';
    await this.ensure(input.userId, currency);
    const wallet = await this.db.one<{ id: string }>(
      `SELECT id FROM wallets WHERE user_id = ? AND currency = ?`,
      input.userId,
      currency,
    );
    if (!wallet) throw new Error('WALLET_UNAVAILABLE');

    await this.db.run(
      `UPDATE wallets SET balance_cents = balance_cents + ?, updated_at = ? WHERE id = ?`,
      input.deltaCents,
      Date.now(),
      wallet.id,
    );
    await this.db.run(
      `INSERT INTO wallet_ledger (id, wallet_id, delta_cents, reason, ref, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId('wlg'),
      wallet.id,
      input.deltaCents,
      input.reason,
      input.ref ?? '',
      input.actorId ?? null,
      Date.now(),
    );
    const row = await this.db.one<{ balance_cents: number }>(
      `SELECT balance_cents FROM wallets WHERE id = ?`,
      wallet.id,
    );
    return row?.balance_cents ?? 0;
  }

  async listForUser(userId: string) {
    return this.db.many<{
      id: string;
      currency: string;
      balance_cents: number;
      frozen_cents: number;
      updated_at: number;
    }>(`SELECT id, currency, balance_cents, frozen_cents, updated_at FROM wallets WHERE user_id = ?`, userId);
  }
}
