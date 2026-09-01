import { Db } from '../db/client';
import { newId } from '../lib/crypto';

/**
 * §24 CRM is the MASTER LEAD CONTROLLER. Every source (website, form, AI,
 * WhatsApp, import, API, campaign, referral) writes a row into `leads` and
 * nothing else. There is exactly one canonical Lead record.
 */

export interface ContactRow {
  id: string;
  owner_admin_id: string;
  phone: string;
  phone_e164: string;
  email: string;
  name: string;
  country: string;
  language: string;
  opted_in: number;
  source: string;
  created_at: number;
  updated_at: number;
}

export interface LeadRow {
  id: string;
  owner_admin_id: string;
  contact_id: string | null;
  name: string;
  phone: string;
  email: string;
  source: string;
  campaign_id: string | null;
  stage: string;
  score: number;
  intent: string;
  language: string;
  country: string;
  consent: number;
  status: string;
  assigned_to: string | null;
  dedupe_key: string;
  created_at: number;
  updated_at: number;
}

/** §31 normalisation: keep digits, preserve a leading +, strip separators. */
export function normalizePhone(raw: string): { phone: string; e164: string } {
  const trimmed = (raw ?? '').trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return { phone: trimmed, e164: '' };
  return { phone: trimmed, e164: hasPlus ? `+${digits}` : digits };
}

export class ContactRepository {
  constructor(private readonly db: Db) {}

  async upsert(input: {
    ownerAdminId: string;
    phone: string;
    name?: string;
    email?: string;
    country?: string;
    language?: string;
    optedIn?: boolean;
    source?: string;
  }): Promise<ContactRow> {
    const { phone, e164 } = normalizePhone(input.phone);
    const existing = await this.db.one<ContactRow>(
      `SELECT * FROM crm_contacts WHERE owner_admin_id = ? AND phone = ?`,
      input.ownerAdminId,
      phone,
    );
    const now = Date.now();

    if (existing) {
      await this.db.run(
        `UPDATE crm_contacts SET name = COALESCE(NULLIF(?, ''), name),
          email = COALESCE(NULLIF(?, ''), email),
          country = COALESCE(NULLIF(?, ''), country),
          language = COALESCE(NULLIF(?, ''), language),
          phone_e164 = COALESCE(NULLIF(?, ''), phone_e164),
          updated_at = ?
         WHERE id = ?`,
        input.name ?? '',
        input.email ?? '',
        input.country ?? '',
        input.language ?? '',
        e164,
        now,
        existing.id,
      );
      return (await this.db.one<ContactRow>(
        `SELECT * FROM crm_contacts WHERE id = ?`,
        existing.id,
      ))!;
    }

    const id = newId('ctc');
    await this.db.run(
      `INSERT INTO crm_contacts (id, owner_admin_id, phone, phone_e164, email, name, country,
        language, opted_in, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.ownerAdminId,
      phone,
      e164,
      input.email ?? '',
      input.name ?? '',
      input.country ?? '',
      input.language ?? '',
      input.optedIn ? 1 : 0,
      input.source ?? '',
      now,
      now,
    );
    return (await this.db.one<ContactRow>(`SELECT * FROM crm_contacts WHERE id = ?`, id))!;
  }

  async findById(id: string): Promise<ContactRow | null> {
    return this.db.one<ContactRow>(`SELECT * FROM crm_contacts WHERE id = ?`, id);
  }

  async list(opts: {
    ownerAdminId: string;
    q?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: ContactRow[]; total: number }> {
    const params: unknown[] = [opts.ownerAdminId];
    let where = 'WHERE owner_admin_id = ?';
    if (opts.q) {
      where += ` AND (lower(name) LIKE ? OR phone LIKE ? OR lower(email) LIKE ?)`;
      const like = `%${opts.q.toLowerCase()}%`;
      params.push(like, like, like);
    }
    const rows = await this.db.many<ContactRow>(
      `SELECT * FROM crm_contacts ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM crm_contacts ${where}`,
      ...params,
    );
    return { rows, total };
  }

  async setOptIn(id: string, optedIn: boolean): Promise<void> {
    await this.db.run(
      `UPDATE crm_contacts SET opted_in = ?, updated_at = ? WHERE id = ?`,
      optedIn ? 1 : 0,
      Date.now(),
      id,
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM crm_contacts WHERE id = ?`, id);
  }

  /* ------------------------------ lists ------------------------------ */

  async createList(ownerAdminId: string, name: string): Promise<{ id: string }> {
    const id = newId('lst');
    await this.db.run(
      `INSERT INTO crm_lists (id, owner_admin_id, name, created_at) VALUES (?, ?, ?, ?)`,
      id,
      ownerAdminId,
      name,
      Date.now(),
    );
    return { id };
  }

  async listLists(ownerAdminId: string) {
    return this.db.many<{ id: string; name: string; created_at: number }>(
      `SELECT id, name, created_at FROM crm_lists WHERE owner_admin_id = ? ORDER BY created_at DESC`,
      ownerAdminId,
    );
  }

  async addToList(listId: string, contactIds: string[]): Promise<number> {
    let added = 0;
    for (const contactId of contactIds) {
      const res = await this.db.run(
        `INSERT OR IGNORE INTO crm_list_members (list_id, contact_id, added_at) VALUES (?, ?, ?)`,
        listId,
        contactId,
        Date.now(),
      );
      added += res.meta?.changes ?? 0;
    }
    return added;
  }

  async listMembers(listId: string): Promise<ContactRow[]> {
    return this.db.many<ContactRow>(
      `SELECT c.* FROM crm_list_members m
       JOIN crm_contacts c ON c.id = m.contact_id
       WHERE m.list_id = ? ORDER BY m.added_at DESC`,
      listId,
    );
  }
}

export class LeadRepository {
  constructor(private readonly db: Db) {}

  /**
   * Canonical lead write. `dedupeKey` is UNIQUE per owner, so re-importing the
   * same person from a different source updates instead of duplicating.
   */
  async upsert(input: {
    ownerAdminId: string;
    name: string;
    phone: string;
    email?: string;
    source: string;
    campaignId?: string | null;
    contactId?: string | null;
    stage?: string;
    score?: number;
    intent?: string;
    language?: string;
    country?: string;
    consent?: boolean;
    assignedTo?: string | null;
    dedupeKey?: string;
  }): Promise<{ lead: LeadRow; created: boolean }> {
    const { e164 } = normalizePhone(input.phone);
    const dedupeKey = input.dedupeKey || `phone:${e164 || input.phone}`;
    const now = Date.now();

    const existing = await this.db.one<LeadRow>(
      `SELECT * FROM leads WHERE owner_admin_id = ? AND dedupe_key = ?`,
      input.ownerAdminId,
      dedupeKey,
    );

    if (existing) {
      await this.db.run(
        `UPDATE leads SET name = COALESCE(NULLIF(?, ''), name),
          email = COALESCE(NULLIF(?, ''), email),
          score = CASE WHEN ? > score THEN ? ELSE score END,
          intent = COALESCE(NULLIF(?, ''), intent),
          language = COALESCE(NULLIF(?, ''), language),
          country = COALESCE(NULLIF(?, ''), country),
          consent = CASE WHEN ? = 1 THEN 1 ELSE consent END,
          contact_id = COALESCE(?, contact_id),
          updated_at = ?
         WHERE id = ?`,
        input.name,
        input.email ?? '',
        input.score ?? 0,
        input.score ?? 0,
        input.intent ?? '',
        input.language ?? '',
        input.country ?? '',
        input.consent ? 1 : 0,
        input.contactId ?? null,
        now,
        existing.id,
      );
      const lead = (await this.db.one<LeadRow>(`SELECT * FROM leads WHERE id = ?`, existing.id))!;
      return { lead, created: false };
    }

    const id = newId('led');
    await this.db.run(
      `INSERT INTO leads (id, owner_admin_id, contact_id, name, phone, email, source, campaign_id,
        stage, score, intent, language, country, consent, status, assigned_to, dedupe_key,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`,
      id,
      input.ownerAdminId,
      input.contactId ?? null,
      input.name,
      input.phone,
      input.email ?? '',
      input.source,
      input.campaignId ?? null,
      input.stage ?? 'NEW',
      input.score ?? 0,
      input.intent ?? '',
      input.language ?? '',
      input.country ?? '',
      input.consent ? 1 : 0,
      input.assignedTo ?? null,
      dedupeKey,
      now,
      now,
    );
    const lead = (await this.db.one<LeadRow>(`SELECT * FROM leads WHERE id = ?`, id))!;
    return { lead, created: true };
  }

  async findById(id: string): Promise<LeadRow | null> {
    return this.db.one<LeadRow>(`SELECT * FROM leads WHERE id = ?`, id);
  }

  async list(opts: {
    ownerAdminId: string;
    q?: string;
    stage?: string;
    source?: string;
    minScore?: number;
    assignedTo?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: LeadRow[]; total: number }> {
    const clauses = ['owner_admin_id = ?'];
    const params: unknown[] = [opts.ownerAdminId];

    if (opts.q) {
      clauses.push(`(lower(name) LIKE ? OR phone LIKE ? OR lower(email) LIKE ?)`);
      const like = `%${opts.q.toLowerCase()}%`;
      params.push(like, like, like);
    }
    if (opts.stage) {
      clauses.push('stage = ?');
      params.push(opts.stage);
    }
    if (opts.source) {
      clauses.push('source = ?');
      params.push(opts.source);
    }
    if (typeof opts.minScore === 'number') {
      clauses.push('score >= ?');
      params.push(opts.minScore);
    }
    if (opts.assignedTo) {
      clauses.push('assigned_to = ?');
      params.push(opts.assignedTo);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const rows = await this.db.many<LeadRow>(
      `SELECT * FROM leads ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
    const total = await this.db.count(`SELECT COUNT(*) AS c FROM leads ${where}`, ...params);
    return { rows, total };
  }

  async update(id: string, patch: Partial<LeadRow>): Promise<LeadRow | null> {
    const keys = Object.keys(patch).filter((k) => !['id', 'created_at'].includes(k));
    if (!keys.length) return this.findById(id);
    const assignments = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
    await this.db.run(
      `UPDATE leads SET ${assignments}, updated_at = ? WHERE id = ?`,
      ...values,
      Date.now(),
      id,
    );
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM leads WHERE id = ?`, id);
  }

  /* --------------------------- activities --------------------------- */

  async addActivity(input: {
    leadId: string;
    type: string;
    body: string;
    actorType: 'USER' | 'AI' | 'SYSTEM';
    actorId?: string | null;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO lead_activities (id, lead_id, type, body, actor_type, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId('act'),
      input.leadId,
      input.type,
      input.body,
      input.actorType,
      input.actorId ?? null,
      Date.now(),
    );
  }

  async activities(leadId: string, limit = 50) {
    return this.db.many<{
      id: string;
      type: string;
      body: string;
      actor_type: string;
      created_at: number;
    }>(
      `SELECT id, type, body, actor_type, created_at FROM lead_activities
       WHERE lead_id = ? ORDER BY created_at DESC LIMIT ?`,
      leadId,
      limit,
    );
  }

  async countsByStage(ownerAdminId: string): Promise<Record<string, number>> {
    const rows = await this.db.many<{ stage: string; c: number }>(
      `SELECT stage, COUNT(*) AS c FROM leads WHERE owner_admin_id = ? GROUP BY stage`,
      ownerAdminId,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.stage] = Number(r.c);
    return out;
  }
}
