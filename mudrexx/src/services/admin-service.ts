import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { hashPassword } from '../lib/crypto';
import { clientIp, userAgentOf } from '../lib/http';
import { AUDIT_ACTIONS } from '../repositories/platform';
import type { PaymentStatus, UserRow } from '../types';
import { SessionService } from './session-service';

/**
 * §12/§13 Admin lifecycle.
 *
 * REGISTER → PROFILE → ADMIN ID → PACKAGE → PAYMENT → PAYMENT REVIEW →
 * CHIEF VERIFICATION → CHIEF APPROVAL → ADMIN ACTIVE → LOGIN
 *
 * An admin can never self-approve, self-verify a payment, or self-activate.
 */
export class AdminService {
  private readonly sessions: SessionService;

  constructor(private readonly c: Container) {
    this.sessions = new SessionService(c);
  }

  /** Public admin registration. Always lands in PENDING — never auto-approved. */
  async register(
    input: {
      email: string;
      password: string;
      fullName: string;
      phone?: string;
      businessName?: string;
      packageId?: string | null;
    },
    req: Context,
  ): Promise<{ user: UserRow; adminId: string }> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AppError('VALIDATION_ERROR', 'A valid email address is required.');
    }
    if (!input.password || input.password.length < 10) {
      throw new AppError('VALIDATION_ERROR', 'Password must be at least 10 characters.');
    }

    const existing = await this.c.users.findByEmail(email);
    if (existing) throw new AppError('CONFLICT', 'An account with this email already exists.');

    if (input.packageId) {
      const pkg = await this.c.packages.findById(input.packageId);
      if (!pkg) throw new AppError('VALIDATION_ERROR', 'Selected package does not exist.');
    }

    const passwordHash = await hashPassword(input.password);
    const [firstName, ...rest] = input.fullName.trim().split(/\s+/);

    const user = await this.c.users.create({
      email,
      passwordHash,
      role: 'ADMIN',
      fullName: input.fullName.trim(),
      firstName: firstName ?? '',
      lastName: rest.join(' '),
      phone: input.phone,
      // §13 an admin stays PENDING until payment + approval + active.
      status: 'PENDING',
      packageId: input.packageId ?? null,
    });

    const profile = await this.c.users.createAdminProfile(user.id, input.businessName ?? '');
    await this.c.passwordHistory.record(user.id, passwordHash);
    await this.c.wallets.ensure(user.id);

    await this.c.audit.record({
      actorId: user.id,
      actorRole: 'ADMIN',
      action: AUDIT_ACTIONS.ADMIN_CREATED,
      targetType: 'admin',
      targetId: user.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { adminId: profile.admin_id, packageId: input.packageId ?? null },
    });

    return { user, adminId: profile.admin_id };
  }

  /** §12 admin profile: name, admin id, email, status, package, payment, approval, activity. */
  async profile(adminUserId: string) {
    const user = await this.c.users.findById(adminUserId);
    if (!user) throw new AppError('NOT_FOUND', 'Admin not found.');
    const profile = await this.c.users.getAdminProfile(user.id);
    const pkg = user.package_id ? await this.c.packages.findById(user.package_id) : null;
    const device = user.last_device_id ? await this.c.devices.findById(user.last_device_id) : null;
    const sessions = await this.c.sessions.listActiveForUser(user.id);
    const payment = await this.c.payments.latestForAdmin(user.id);

    return {
      id: user.id,
      adminId: profile?.admin_id ?? null,
      name: user.full_name,
      firstName: user.first_name,
      lastName: user.last_name,
      email: user.email,
      phone: user.phone,
      status: user.status,
      package: pkg ? { id: pkg.id, code: pkg.code, name: pkg.name } : null,
      paymentStatus: user.payment_status,
      approvalStatus: user.approval_status,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
      lastActiveAt: user.last_active_at,
      lastDevice: device
        ? { id: device.id, label: device.label, browser: device.browser, os: device.os }
        : null,
      lastIp: user.last_ip,
      activeSessions: sessions.length,
      latestPayment: payment
        ? { id: payment.id, status: payment.status, amountCents: payment.amount_cents }
        : null,
      businessName: profile?.business_name ?? '',
    };
  }

  async list(opts: { limit: number; offset: number; status?: string }) {
    return this.c.users.list({ role: 'ADMIN', limit: opts.limit, offset: opts.offset });
  }

  /**
   * §13 Chief approval. Requires a VERIFIED payment; the Chief may optionally
   * verify the payment in the same action, but the actor is always recorded and
   * can never be the admin being approved.
   */
  async approve(adminUserId: string, chief: UserRow, req: Context, note?: string): Promise<UserRow> {
    const admin = await this.requireAdmin(adminUserId);
    if (admin.id === chief.id) {
      throw new AppError('FORBIDDEN', 'You cannot approve your own account.');
    }
    if (admin.payment_status !== 'VERIFIED') {
      throw new AppError(
        'PAYMENT_REQUIRED',
        'Payment must be verified before an admin can be approved.',
        { paymentStatus: admin.payment_status },
      );
    }

    await this.c.users.setApproval(admin.id, 'APPROVED', admin.payment_status);
    await this.c.users.setStatus(admin.id, 'ACTIVE');

    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.ADMIN_APPROVED,
      targetType: 'admin',
      targetId: admin.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { note: note ?? '' },
    });

    return (await this.c.users.findById(admin.id))!;
  }

  async reject(adminUserId: string, chief: UserRow, reason: string, req: Context): Promise<UserRow> {
    const admin = await this.requireAdmin(adminUserId);
    if (admin.id === chief.id) {
      throw new AppError('FORBIDDEN', 'You cannot reject your own account.');
    }
    await this.c.users.setApproval(admin.id, 'REJECTED', admin.payment_status);
    await this.c.users.setStatus(admin.id, 'SUSPENDED');
    await this.sessions.revokeAllForUser(admin.id, 'ADMIN_REJECTED');

    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.ADMIN_REJECTED,
      targetType: 'admin',
      targetId: admin.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { reason },
    });
    return (await this.c.users.findById(admin.id))!;
  }

  async block(adminUserId: string, chief: UserRow, req: Context): Promise<UserRow> {
    const admin = await this.requireAdmin(adminUserId);
    await this.c.users.setStatus(admin.id, 'BLOCKED');
    await this.sessions.revokeAllForUser(admin.id, 'ADMIN_BLOCKED');
    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.ADMIN_BLOCKED,
      targetType: 'admin',
      targetId: admin.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
    return (await this.c.users.findById(admin.id))!;
  }

  async unblock(adminUserId: string, chief: UserRow, req: Context): Promise<UserRow> {
    const admin = await this.requireAdmin(adminUserId);
    // Unblocking does NOT grant approval or payment status — those stay as they were.
    await this.c.users.setStatus(
      admin.id,
      admin.approval_status === 'APPROVED' && admin.payment_status === 'VERIFIED'
        ? 'ACTIVE'
        : 'PENDING',
    );
    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.ADMIN_UNBLOCKED,
      targetType: 'admin',
      targetId: admin.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
    return (await this.c.users.findById(admin.id))!;
  }

  async remove(adminUserId: string, chief: UserRow, req: Context): Promise<void> {
    const admin = await this.requireAdmin(adminUserId);
    if (admin.role === 'SUPER_ADMIN') {
      throw new AppError('FORBIDDEN', 'A Chief Admin account cannot be deleted through this API.');
    }
    await this.sessions.revokeAllForUser(admin.id, 'ADMIN_DELETED');
    await this.c.devices.resetAllForUser(admin.id);
    await this.c.db.run(`DELETE FROM admin_profiles WHERE user_id = ?`, admin.id);
    await this.c.db.run(`DELETE FROM users WHERE id = ?`, admin.id);
    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.ADMIN_DELETED,
      targetType: 'admin',
      targetId: adminUserId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
  }

  async assignPackage(
    adminUserId: string,
    packageId: string,
    chief: UserRow,
    req: Context,
  ): Promise<UserRow> {
    const admin = await this.requireAdmin(adminUserId);
    const pkg = await this.c.packages.findById(packageId);
    if (!pkg) throw new AppError('NOT_FOUND', 'Package not found.');
    await this.c.users.update(admin.id, { package_id: pkg.id });
    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.PACKAGE_CHANGED,
      targetType: 'admin',
      targetId: admin.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { packageId: pkg.id, code: pkg.code },
    });
    return (await this.c.users.findById(admin.id))!;
  }

  /** §41 Chief security action: reset an admin's device binding. */
  async resetDevice(adminUserId: string, chief: UserRow, req: Context): Promise<number> {
    const admin = await this.requireAdmin(adminUserId);
    const revoked = await this.c.devices.resetAllForUser(admin.id);
    await this.sessions.revokeAllForUser(admin.id, 'DEVICE_RESET');
    await this.c.loginHistory.record({
      userId: admin.id,
      emailKey: admin.email ?? '',
      event: 'DEVICE_RESET',
      browser: '',
      os: '',
      ip: clientIp(req),
      reason: `reset by ${chief.id}`,
    });
    await this.c.audit.record({
      actorId: chief.id,
      actorRole: chief.role,
      action: AUDIT_ACTIONS.DEVICE_RESET,
      targetType: 'admin',
      targetId: admin.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { devicesRevoked: revoked },
    });
    return revoked;
  }

  async setPaymentStatus(
    adminUserId: string,
    status: PaymentStatus,
    chief: UserRow,
    req: Context,
  ): Promise<UserRow> {
    const admin = await this.requireAdmin(adminUserId);
    await this.c.users.update(admin.id, { payment_status: status });
    return (await this.c.users.findById(admin.id))!;
  }

  private async requireAdmin(id: string): Promise<UserRow> {
    const user = await this.c.users.findById(id);
    if (!user) throw new AppError('NOT_FOUND', 'Admin not found.');
    if (user.role !== 'ADMIN') throw new AppError('VALIDATION_ERROR', 'Target account is not an admin.');
    return user;
  }
}
