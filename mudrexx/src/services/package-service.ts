import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { newId } from '../lib/crypto';
import { clientIp, userAgentOf } from '../lib/http';
import { AUDIT_ACTIONS } from '../repositories/platform';
import { DEFAULT_LIMITS, parseLimits, type PackageLimits } from '../repositories/commercial';
import type { UserRow } from '../types';

export const PACKAGE_CODES = ['BRONZE', 'SILVER', 'GOLD', 'ENTREPRENEUR'] as const;
export type PackageCode = (typeof PACKAGE_CODES)[number];

export const BILLING_PERIODS = ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL'] as const;
export type BillingPeriod = (typeof BILLING_PERIODS)[number];

const SEED: Record<PackageCode, { name: string; limits: Partial<PackageLimits>; monthly: number }> = {
  BRONZE: {
    name: 'Bronze',
    monthly: 199900,
    limits: { userLimit: 3, leadLimit: 1000, contactLimit: 1000, aiUsage: 0, whatsappUsage: 500, storageMb: 100, crm: true, ai: false, support: true },
  },
  SILVER: {
    name: 'Silver',
    monthly: 499900,
    limits: { userLimit: 10, leadLimit: 10000, contactLimit: 10000, aiUsage: 5000, whatsappUsage: 5000, storageMb: 1024, crm: true, ai: true, automation: false, documents: true, support: true },
  },
  GOLD: {
    name: 'Gold',
    monthly: 999900,
    limits: { userLimit: 50, leadLimit: 100000, contactLimit: 100000, aiUsage: 50000, whatsappUsage: 50000, storageMb: 10240, crm: true, ai: true, automation: true, documents: true, invoices: true, api: true, support: true },
  },
  ENTREPRENEUR: {
    name: 'Entrepreneur',
    monthly: 2499900,
    limits: { userLimit: 500, leadLimit: 1000000, contactLimit: 1000000, aiUsage: 500000, whatsappUsage: 500000, storageMb: 102400, crm: true, ai: true, automation: true, documents: true, invoices: true, api: true, support: true },
  },
};

/**
 * §15/§16 Packages and pricing.
 *
 * Limits are enforced SERVER-SIDE by `enforceLimit`; the frontend can hide a
 * button but can never grant capacity.
 */
export class PackageService {
  constructor(private readonly c: Container) {}

  async ensureDefaults(): Promise<void> {
    for (const code of PACKAGE_CODES) {
      const existing = await this.c.packages.findByCode(code);
      const seed = SEED[code];
      if (!existing) {
        const pkg = await this.c.packages.create({
          code,
          name: seed.name,
          currency: 'INR',
          limits: seed.limits,
        });
        await this.c.packages.setPrice({
          packageId: pkg.id,
          period: 'MONTHLY',
          priceCents: seed.monthly,
          currency: 'INR',
        });
      }
    }
  }

  async list() {
    const packages = await this.c.packages.list();
    const out = [];
    for (const pkg of packages) {
      out.push({
        id: pkg.id,
        code: pkg.code,
        name: pkg.name,
        currency: pkg.currency,
        isActive: pkg.is_active === 1,
        limits: parseLimits(pkg.limits_json),
        prices: await this.c.packages.pricesFor(pkg.id),
        addons: await this.c.packages.addonsFor(pkg.id),
      });
    }
    return out;
  }

  /** Chief configuration of limits/features (§15). */
  async configure(
    packageId: string,
    patch: {
      name?: string;
      isActive?: boolean;
      limits?: Partial<PackageLimits>;
      prices?: { period: BillingPeriod; priceCents: number; currency?: string }[];
      addons?: { kind: 'ADDITIONAL_USER' | 'ADDITIONAL_LEAD' | 'ADDITIONAL_MESSAGE' | 'ADDITIONAL_STORAGE'; unitPriceCents: number }[];
    },
    chief: UserRow,
    req: Context,
  ) {
    const pkg = await this.c.packages.findById(packageId);
    if (!pkg) throw new AppError('NOT_FOUND', 'Package not found.');

    await this.c.packages.update(packageId, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.isActive !== undefined ? { is_active: patch.isActive ? 1 : 0 } : {}),
      ...(patch.limits ? { limits: patch.limits } : {}),
    });

    for (const price of patch.prices ?? []) {
      if (!BILLING_PERIODS.includes(price.period)) {
        throw new AppError('VALIDATION_ERROR', `Unknown billing period ${price.period}.`);
      }
      if (price.priceCents < 0) throw new AppError('VALIDATION_ERROR', 'Price cannot be negative.');
      await this.c.packages.setPrice({
        packageId,
        period: price.period,
        priceCents: price.priceCents,
        currency: price.currency ?? pkg.currency,
      });
    }

    for (const addon of patch.addons ?? []) {
      await this.c.packages.setAddon({
        packageId,
        kind: addon.kind,
        unitPriceCents: addon.unitPriceCents,
        currency: pkg.currency,
      });
    }

    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.PACKAGE_CONFIGURED,
      targetType: 'package',
      targetId: packageId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { patch },
    });

    return this.c.packages.findById(packageId);
  }

  /** §16 quote = base price for the period + selected add-ons. */
  async quote(input: {
    packageId: string;
    period: BillingPeriod;
    addons?: { kind: string; quantity: number }[];
  }) {
    const pkg = await this.c.packages.findById(input.packageId);
    if (!pkg) throw new AppError('NOT_FOUND', 'Package not found.');

    const prices = await this.c.packages.pricesFor(pkg.id);
    const base = prices.find((p) => p.period === input.period);
    if (!base) {
      throw new AppError('NOT_FOUND', `No ${input.period} price configured for ${pkg.code}.`);
    }

    const addons = await this.c.packages.addonsFor(pkg.id);
    const lines: { label: string; amountCents: number }[] = [
      { label: `${pkg.name} (${input.period})`, amountCents: base.price_cents },
    ];

    for (const requested of input.addons ?? []) {
      const addon = addons.find((a) => a.kind === requested.kind);
      if (!addon) continue;
      const qty = Math.max(0, Math.floor(requested.quantity));
      lines.push({
        label: `${requested.kind} x${qty}`,
        amountCents: addon.unit_price_cents * qty,
      });
    }

    return {
      currency: base.currency,
      lines,
      totalCents: lines.reduce((sum, l) => sum + l.amountCents, 0),
    };
  }

  /**
   * §16 market reference → recommendation. The recommendation is data only:
   * publishing a price still requires an explicit Chief action.
   */
  async recordMarketRate(
    input: { key: string; valueCents: number; currency?: string; source: string; note?: string },
    req: Context,
    chief: UserRow,
  ) {
    await this.c.packages.recordMarketRate({
      key: input.key,
      valueCents: input.valueCents,
      currency: input.currency ?? 'INR',
      source: input.source,
      note: input.note,
    });
    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: 'MARKET_RATE_RECORDED',
      targetType: 'market_rate',
      targetId: input.key,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
    return this.recommend(input.key, input.valueCents);
  }

  /** Deterministic recommendation formula — advisory only, never auto-applied. */
  recommend(key: string, marketCents: number) {
    const suggested = Math.round((marketCents * 0.95) / 100) * 100; // 5% under market, rounded to ₹1
    return {
      key,
      marketCents,
      suggestedCents: suggested,
      deltaCents: suggested - marketCents,
      requiresChiefReview: true,
      autoApplied: false,
    };
  }

  async marketRates(limit = 50) {
    return this.c.packages.latestMarketRates(limit);
  }

  /** §15 server-side limit enforcement. */
  async limitsFor(admin: UserRow): Promise<PackageLimits> {
    if (!admin.package_id) return { ...DEFAULT_LIMITS };
    const pkg = await this.c.packages.findById(admin.package_id);
    if (!pkg) return { ...DEFAULT_LIMITS };
    return parseLimits(pkg.limits_json);
  }

  async enforceLimit(
    admin: UserRow,
    resource: keyof Pick<
      PackageLimits,
      'userLimit' | 'leadLimit' | 'contactLimit' | 'aiUsage' | 'whatsappUsage' | 'storageMb'
    >,
    currentUsage: number,
  ): Promise<void> {
    const limits = await this.limitsFor(admin);
    const max = limits[resource] ?? 0;
    if (currentUsage >= max) {
      throw new AppError(
        'FORBIDDEN',
        `Package limit reached for ${resource} (${currentUsage}/${max}). Upgrade the package to continue.`,
        { code: 'PACKAGE_LIMIT_REACHED', resource, currentUsage, max },
      );
    }
  }

  async assertFeature(admin: UserRow, feature: keyof Pick<PackageLimits, 'crm' | 'ai' | 'automation' | 'documents' | 'invoices' | 'api' | 'support'>): Promise<void> {
    const limits = await this.limitsFor(admin);
    if (!limits[feature]) {
      throw new AppError('FORBIDDEN', `The ${feature} feature is not included in this package.`, {
        code: 'FEATURE_NOT_IN_PACKAGE',
        feature,
      });
    }
  }

  async createInvoiceFor(admin: UserRow, paymentId: string, amountCents: number, currency: string) {
    return this.c.invoices.create({
      userId: admin.id,
      paymentId,
      amountCents,
      currency,
    });
  }
}

export { newId };
