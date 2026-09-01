import type { Container } from '../container';
import { AppError } from '../http/errors';
import { hashPassword } from '../lib/crypto';
import type { UserRow } from '../types';

/**
 * §39 DEMO.
 *
 * Demo is read-only and its data is isolated: every demo CRM/lead/task row is
 * owned by the demo account's own id, so a demo user can never read production
 * CRM data. Writes are blocked in the RBAC middleware (DEMO_READ_ONLY), not by
 * hiding buttons in the UI.
 */
export class DemoService {
  constructor(private readonly c: Container) {}

  /**
   * Provision (or reuse) the demo account and its sample dataset.
   * Demo credentials are intentionally fixed and published — the account can
   * only read, and only its own sample rows.
   */
  async ensureDemoUser(): Promise<{ email: string; password: string; userId: string }> {
    const email = 'demo@mudrexx.local';
    const password = 'Mudrexx-Demo-2026';

    const existing = await this.c.users.findByEmail(email);
    if (existing) {
      await this.seed(existing);
      return { email, password, userId: existing.id };
    }

    const hash = await hashPassword(password);
    const user = await this.c.users.create({
      email,
      passwordHash: hash,
      role: 'DEMO_VIEWER',
      fullName: 'Demo User',
      firstName: 'Demo',
      lastName: 'User',
      status: 'ACTIVE',
      isDemo: true,
    });
    await this.c.passwordHistory.record(user.id, hash);
    await this.seed(user);
    return { email, password, userId: user.id };
  }

  /** Idempotent sample dataset scoped entirely to the demo user's own id. */
  async seed(user: UserRow): Promise<void> {
    const ownerId = user.id;
    const existing = await this.c.db.count(
      `SELECT COUNT(*) AS c FROM leads WHERE owner_admin_id = ?`,
      ownerId,
    );
    if (existing > 0) return;

    const samples = [
      { name: 'Aarav Sharma', phone: '+919900000001', source: 'WEBSITE', score: 82, stage: 'QUALIFIED', intent: 'BUY', language: 'hi', country: 'IN' },
      { name: 'Priya Nair', phone: '+919900000002', source: 'WHATSAPP', score: 64, stage: 'NEW', intent: 'RESEARCH', language: 'en', country: 'IN' },
      { name: 'Imran Khan', phone: '+919900000003', source: 'CAMPAIGN', score: 91, stage: 'QUALIFIED', intent: 'BUY', language: 'en', country: 'IN' },
      { name: 'Sneha Rao', phone: '+919900000004', source: 'IMPORT', score: 35, stage: 'NURTURE', intent: 'BROWSE', language: 'kn', country: 'IN' },
      { name: 'Vikram Patel', phone: '+919900000005', source: 'AI', score: 77, stage: 'QUALIFIED', intent: 'BUY', language: 'gu', country: 'IN' },
    ];

    for (const s of samples) {
      const contact = await this.c.contacts.upsert({
        ownerAdminId: ownerId,
        phone: s.phone,
        name: s.name,
        country: s.country,
        language: s.language,
        optedIn: true,
        source: s.source,
      });
      const { lead } = await this.c.leads.upsert({
        ownerAdminId: ownerId,
        contactId: contact.id,
        name: s.name,
        phone: s.phone,
        source: s.source,
        stage: s.stage,
        score: s.score,
        intent: s.intent,
        language: s.language,
        country: s.country,
        consent: true,
      });
      await this.c.leads.addActivity({
        leadId: lead.id,
        type: 'NOTE',
        body: `Sample ${s.source} lead`,
        actorType: 'SYSTEM',
        actorId: ownerId,
      });
      await this.c.tasks.create({
        ownerAdminId: ownerId,
        title: `Follow up with ${s.name}`,
        description: 'Sample demo follow-up task',
        priority: s.score >= 80 ? 'HIGH' : 'MEDIUM',
        assignedName: s.name,
        source: 'SYSTEM',
        createdBy: ownerId,
        dedupeKey: `demo:followup:${s.phone}`,
      });
    }
  }

  /** Snapshot for the demo dashboard — always the demo's own isolated rows. */
  async snapshot(user: UserRow) {
    if (user.role !== 'DEMO_VIEWER' || user.is_demo !== 1) {
      throw new AppError('FORBIDDEN', 'This account is not a demo account.');
    }
    const ownerId = user.id;
    const [leads, tasks, contacts] = await Promise.all([
      this.c.leads.list({ ownerAdminId: ownerId, limit: 20, offset: 0 }),
      this.c.tasks.list({ ownerAdminId: ownerId, limit: 20, offset: 0 }),
      this.c.contacts.list({ ownerAdminId: ownerId, limit: 20, offset: 0 }),
    ]);

    return {
      readOnly: true,
      isolation: 'demo-owned rows only',
      leads: { rows: leads.rows, total: leads.total },
      tasks: { rows: tasks.rows, total: tasks.total },
      contacts: { rows: contacts.rows, total: contacts.total },
      stages: await this.c.leads.countsByStage(ownerId),
    };
  }
}
