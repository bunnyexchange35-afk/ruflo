import { Db } from '../db/client';
import { allocateHumanId } from '../lib/ids';
import { newId } from '../lib/crypto';
import type { ApprovalStatus, PaymentStatus, Role, UserRow } from '../types';

export interface AdminProfileRow {
  user_id: string;
  admin_id: string;
  business_name: string;
  last_device_label: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  role: Role;
  fullName: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  status?: UserRow['status'];
  isDemo?: boolean;
  packageId?: string | null;
}

const USER_COLUMNS = `id, human_id, email, phone, password_hash, password_algo, role, status,
  full_name, first_name, last_name, package_id, payment_status, approval_status, is_demo,
  failed_attempts, locked_until, password_changed_at, created_at, updated_at,
  last_login_at, last_active_at, last_device_id, last_ip`;

export class UserRepository {
  constructor(private readonly db: Db) {}

  async create(input: CreateUserInput): Promise<UserRow> {
    const now = Date.now();
    const id = newId('usr');
    const humanId = await allocateHumanId(this.db.raw, 'users', 'human_id');

    await this.db.run(
      `INSERT INTO users (id, human_id, email, phone, password_hash, password_algo, role, status,
        full_name, first_name, last_name, package_id, payment_status, approval_status,
        is_demo, failed_attempts, locked_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'PBKDF2-SHA256', ?, ?, ?, ?, ?, ?, 'PENDING', 'PENDING', ?, 0, NULL, ?, ?)`,
      id,
      humanId,
      input.email.toLowerCase(),
      input.phone ?? null,
      input.passwordHash,
      input.role,
      input.status ?? 'PENDING',
      input.fullName,
      input.firstName ?? '',
      input.lastName ?? '',
      input.packageId ?? null,
      input.isDemo ? 1 : 0,
      now,
      now,
    );

    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`, id);
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower(?)`,
      email,
    );
  }

  async findByHumanId(humanId: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE human_id = ?`, humanId);
  }

  async findByPhone(phone: string): Promise<UserRow | null> {
    return this.db.one<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE phone = ?`, phone);
  }

  async update(id: string, patch: Partial<UserRow>): Promise<UserRow | null> {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return this.findById(id);
    const assignments = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
    await this.db.run(
      `UPDATE users SET ${assignments}, updated_at = ? WHERE id = ?`,
      ...values,
      Date.now(),
      id,
    );
    return this.findById(id);
  }

  async setPassword(id: string, passwordHash: string): Promise<void> {
    await this.db.run(
      `UPDATE users SET password_hash = ?, password_algo = 'PBKDF2-SHA256',
        password_changed_at = ?, updated_at = ?, failed_attempts = 0, locked_until = NULL
       WHERE id = ?`,
      passwordHash,
      Date.now(),
      Date.now(),
      id,
    );
  }

  async touchActive(id: string, ip: string, deviceId: string | null): Promise<void> {
    await this.db.run(
      `UPDATE users SET last_active_at = ?, last_ip = ?, last_device_id = COALESCE(?, last_device_id)
       WHERE id = ?`,
      Date.now(),
      ip,
      deviceId,
      id,
    );
  }

  async recordLogin(id: string, ip: string, deviceId: string | null): Promise<void> {
    await this.db.run(
      `UPDATE users SET last_login_at = ?, last_active_at = ?, last_ip = ?, last_device_id = ?,
        failed_attempts = 0, locked_until = NULL, updated_at = ?
       WHERE id = ?`,
      Date.now(),
      Date.now(),
      ip,
      deviceId,
      Date.now(),
      id,
    );
  }

  /** §20 login attempt protection. */
  async registerFailedAttempt(id: string, maxAttempts: number, lockMs: number): Promise<void> {
    await this.db.run(
      `UPDATE users SET failed_attempts = failed_attempts + 1,
        locked_until = CASE WHEN failed_attempts + 1 >= ? THEN ? ELSE locked_until END,
        updated_at = ?
       WHERE id = ?`,
      maxAttempts,
      Date.now() + lockMs,
      Date.now(),
      id,
    );
  }

  async clearFailedAttempts(id: string): Promise<void> {
    await this.db.run(
      `UPDATE users SET failed_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
      Date.now(),
      id,
    );
  }

  async setStatus(id: string, status: UserRow['status']): Promise<void> {
    await this.db.run(
      `UPDATE users SET status = ?, updated_at = ? WHERE id = ?`,
      status,
      Date.now(),
      id,
    );
  }

  async setApproval(id: string, approval: ApprovalStatus, payment: PaymentStatus): Promise<void> {
    await this.db.run(
      `UPDATE users SET approval_status = ?, payment_status = ?, updated_at = ? WHERE id = ?`,
      approval,
      payment,
      Date.now(),
      id,
    );
  }

  /**
   * §35 server-side, case-insensitive, partial, indexed, paginated user search.
   * Never loads the whole table into the browser.
   */
  /**
   * §35 server-side, case-insensitive, partial, indexed, paginated search over
   * name parts, phone and the human ID. `includeEmail` extends the predicate to
   * email addresses (used by the Chief portal to locate an admin account).
   */
  async search(opts: {
    q: string;
    role?: Role;
    limit: number;
    offset: number;
    includeDemo?: boolean;
    includeEmail?: boolean;
  }): Promise<{ rows: UserRow[]; total: number }> {
    const like = `%${opts.q.trim().toLowerCase()}%`;
    const roleClause = opts.role ? `AND role = ?` : '';
    const demoClause = opts.includeDemo ? '' : 'AND is_demo = 0';
    const roleParams: unknown[] = opts.role ? [opts.role] : [];

    const where = `WHERE (
        lower(full_name) LIKE ? OR lower(first_name) LIKE ? OR lower(last_name) LIKE ?
        OR lower(COALESCE(phone,'')) LIKE ? OR human_id LIKE ?
        ${opts.includeEmail ? `OR lower(COALESCE(email,'')) LIKE ?` : ''}
      ) ${roleClause} ${demoClause}`;

    const params = opts.includeEmail
      ? [like, like, like, like, like, like, ...roleParams]
      : [like, like, like, like, like, ...roleParams];
    const rows = await this.db.many<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM users ${where}`,
      ...params,
    );
    return { rows, total };
  }

  async list(opts: {
    role?: Role;
    limit: number;
    offset: number;
    includeDemo?: boolean;
  }): Promise<{ rows: UserRow[]; total: number }> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.role) {
      clauses.push('role = ?');
      params.push(opts.role);
    }
    if (!opts.includeDemo) clauses.push('is_demo = 0');
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = await this.db.many<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
    const total = await this.db.count(`SELECT COUNT(*) AS c FROM users ${where}`, ...params);
    return { rows, total };
  }

  /** §36 joining-date based assignment (today/week/month/custom ranges). */
  async listByJoiningRange(fromMs: number, toMs: number, role?: Role): Promise<UserRow[]> {
    const params: unknown[] = [fromMs, toMs];
    let roleClause = '';
    if (role) {
      roleClause = 'AND role = ?';
      params.push(role);
    }
    return this.db.many<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users
       WHERE created_at >= ? AND created_at < ? AND is_demo = 0 ${roleClause}
       ORDER BY created_at DESC`,
      ...params,
    );
  }

  /* ------------------------- admin profiles (§12) ------------------------- */

  async createAdminProfile(userId: string, businessName = ''): Promise<AdminProfileRow> {
    const now = Date.now();
    const adminId = await allocateHumanId(this.db.raw, 'admin_profiles', 'admin_id');
    await this.db.run(
      `INSERT INTO admin_profiles (user_id, admin_id, business_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      userId,
      adminId,
      businessName,
      now,
      now,
    );
    return (await this.getAdminProfile(userId))!;
  }

  async getAdminProfile(userId: string): Promise<AdminProfileRow | null> {
    return this.db.one<AdminProfileRow>(
      `SELECT * FROM admin_profiles WHERE user_id = ?`,
      userId,
    );
  }

  async getAdminProfileByAdminId(adminId: string): Promise<AdminProfileRow | null> {
    return this.db.one<AdminProfileRow>(
      `SELECT * FROM admin_profiles WHERE admin_id = ?`,
      adminId,
    );
  }

  async listAdminProfiles(limit: number, offset: number): Promise<AdminProfileRow[]> {
    return this.db.many<AdminProfileRow>(
      `SELECT * FROM admin_profiles ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      limit,
      offset,
    );
  }

  async setAdminDeviceLabel(userId: string, label: string): Promise<void> {
    await this.db.run(
      `UPDATE admin_profiles SET last_device_label = ?, updated_at = ? WHERE user_id = ?`,
      label,
      Date.now(),
      userId,
    );
  }
}
