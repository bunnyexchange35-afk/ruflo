import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { clientIp, userAgentOf } from '../lib/http';
import { AUDIT_ACTIONS } from '../repositories/platform';
import type { PaymentStatus, UserRow } from '../types';
import { PAYMENT_STATUSES } from '../types';

/**
 * §14 Payment management.
 *
 * Allowed transitions are explicit. An admin may SUBMIT their own payment but
 * can never VERIFY it — verification is Chief-only and the actor is recorded.
 */
const TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING: ['SUBMITTED', 'UNDER_REVIEW', 'REJECTED', 'EXPIRED'],
  SUBMITTED: ['UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED'],
  UNDER_REVIEW: ['VERIFIED', 'REJECTED', 'EXPIRED'],
  VERIFIED: ['REFUNDED'],
  REJECTED: ['SUBMITTED', 'UNDER_REVIEW'],
  REFUNDED: [],
  EXPIRED: ['SUBMITTED'],
};

export class PaymentService {
  constructor(private readonly c: Container) {}

  async submitForAdmin(
    admin: UserRow,
    input: {
      packageId: string;
      amountCents: number;
      currency?: string;
      period?: string;
      method?: string;
      reference?: string;
    },
    req: Context,
  ) {
    const pkg = await this.c.packages.findById(input.packageId);
    if (!pkg) throw new AppError('NOT_FOUND', 'Package not found.');
    if (input.amountCents < 0) throw new AppError('VALIDATION_ERROR', 'Amount cannot be negative.');

    const payment = await this.c.payments.create({
      adminId: admin.id,
      packageId: pkg.id,
      amountCents: input.amountCents,
      currency: input.currency ?? pkg.currency,
      period: input.period ?? 'MONTHLY',
      method: input.method ?? '',
      reference: input.reference ?? '',
    });
    await this.c.payments.submit(payment.id);
    await this.c.users.update(admin.id, { package_id: pkg.id, payment_status: 'SUBMITTED' });

    await this.c.audit.record({
      actorId: admin.id,
      actorRole: admin.role,
      action: AUDIT_ACTIONS.PAYMENT_SUBMITTED,
      targetType: 'payment',
      targetId: payment.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { amountCents: input.amountCents, packageId: pkg.id },
    });

    return this.c.payments.findById(payment.id);
  }

  /**
   * §13 payment happens BEFORE the admin can log in, so submission is a public
   * endpoint identified by email + admin ID (both returned at registration).
   * It is rate-limited and only ever moves the payment to SUBMITTED — never to
   * VERIFIED, which stays Chief-only.
   */
  async submitForPendingAdmin(
    input: {
      email: string;
      adminId: string;
      packageId: string;
      amountCents: number;
      currency?: string;
      period?: string;
      method?: string;
      reference?: string;
    },
    req: Context,
  ) {
    const user = await this.c.users.findByEmail(input.email.trim().toLowerCase());
    if (!user || user.role !== 'ADMIN') {
      throw new AppError('NOT_FOUND', 'No admin account matches these details.');
    }
    const profile = await this.c.users.getAdminProfile(user.id);
    if (!profile || profile.admin_id !== input.adminId.trim()) {
      throw new AppError('NOT_FOUND', 'No admin account matches these details.');
    }
    if (user.status === 'BLOCKED') {
      throw new AppError('FORBIDDEN', 'This admin account is blocked.');
    }

    const pkg = await this.c.packages.findById(input.packageId);
    if (!pkg) throw new AppError('NOT_FOUND', 'Package not found.');

    const payment = await this.c.payments.create({
      adminId: user.id,
      packageId: pkg.id,
      amountCents: input.amountCents,
      currency: input.currency ?? pkg.currency,
      period: input.period ?? 'MONTHLY',
      method: input.method ?? '',
      reference: input.reference ?? '',
    });
    await this.c.payments.submit(payment.id);
    await this.c.users.update(user.id, { package_id: pkg.id, payment_status: 'SUBMITTED' });

    await this.c.audit.record({
      actorId: user.id,
      actorRole: 'ADMIN',
      action: AUDIT_ACTIONS.PAYMENT_SUBMITTED,
      targetType: 'payment',
      targetId: payment.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { amountCents: input.amountCents, packageId: pkg.id, channel: 'public' },
    });

    return this.c.payments.findById(payment.id);
  }

  async listForAdmin(admin: UserRow) {
    return this.c.payments.listForAdmin(admin.id);
  }

  async list(opts: { status?: PaymentStatus | 'ALL'; limit: number; offset: number }) {
    return this.c.payments.list(opts);
  }

  /**
   * Chief-only transition. The actor is checked against the payment owner —
   * an admin can never approve their own payment (§14).
   */
  async transition(
    paymentId: string,
    nextStatus: PaymentStatus,
    chief: UserRow,
    req: Context,
    opts: { note?: string; reason?: string } = {},
  ) {
    if (!PAYMENT_STATUSES.includes(nextStatus)) {
      throw new AppError('VALIDATION_ERROR', 'Unknown payment status.');
    }
    const payment = await this.c.payments.findById(paymentId);
    if (!payment) throw new AppError('NOT_FOUND', 'Payment not found.');

    if (payment.admin_id === chief.id) {
      throw new AppError('FORBIDDEN', 'You cannot review your own payment.');
    }
    if (!TRANSITIONS[payment.status].includes(nextStatus)) {
      throw new AppError(
        'CONFLICT',
        `Payment cannot move from ${payment.status} to ${nextStatus}.`,
        { from: payment.status, to: nextStatus },
      );
    }

    const updated = await this.c.payments.transition({
      id: paymentId,
      status: nextStatus,
      actorId: chief.id,
      note: opts.note,
      reason: opts.reason,
    });

    // Verification is what unlocks an admin account (§13).
    if (nextStatus === 'VERIFIED') {
      await this.c.users.update(payment.admin_id, { payment_status: 'VERIFIED' });
    } else if (nextStatus === 'REJECTED' || nextStatus === 'REFUNDED') {
      await this.c.users.update(payment.admin_id, {
        payment_status: nextStatus === 'REJECTED' ? 'REJECTED' : 'REFUNDED',
      });
    }

    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action:
        nextStatus === 'VERIFIED'
          ? AUDIT_ACTIONS.PAYMENT_VERIFIED
          : AUDIT_ACTIONS.PAYMENT_REJECTED,
      targetType: 'payment',
      targetId: paymentId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { from: payment.status, to: nextStatus, note: opts.note ?? '', reason: opts.reason ?? '' },
    });

    return updated;
  }

  /** §14 "request information" — keeps the payment open, records what is needed. */
  async requestInformation(
    paymentId: string,
    chief: UserRow,
    message: string,
    req: Context,
  ) {
    const payment = await this.c.payments.findById(paymentId);
    if (!payment) throw new AppError('NOT_FOUND', 'Payment not found.');
    if (payment.admin_id === chief.id) {
      throw new AppError('FORBIDDEN', 'You cannot review your own payment.');
    }
    const updated = await this.c.payments.transition({
      id: paymentId,
      status: 'UNDER_REVIEW',
      actorId: chief.id,
      note: message,
    });
    await this.c.users.update(payment.admin_id, { payment_status: 'UNDER_REVIEW' });
    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: 'PAYMENT_INFO_REQUESTED',
      targetType: 'payment',
      targetId: paymentId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { message },
    });
    return updated;
  }
}
