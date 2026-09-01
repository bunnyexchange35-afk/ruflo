import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { clientIp, userAgentOf } from '../lib/http';
import { AUDIT_ACTIONS } from '../repositories/platform';
import { normalizePhone } from '../repositories/crm';
import type { UserRow } from '../types';
import { PackageService } from './package-service';

/**
 * §24 CRM is the MASTER LEAD CONTROLLER.
 * Every source — website, form, AI, WhatsApp, import, API, campaign, referral —
 * funnels through `ingestLead`, producing exactly one canonical Lead record.
 */
export class CrmService {
  private readonly packages: PackageService;

  constructor(private readonly c: Container) {
    this.packages = new PackageService(c);
  }

  /** Owner scope: an admin always works on their own CRM rows. */
  private ownerFor(actor: UserRow): string {
    // A Chief inspecting an admin's CRM passes ?ownerId=, handled at the route.
    // Default scope is the actor's own CRM.
    return actor.id;
  }

  /* ------------------------------- contacts ------------------------------- */

  async listContacts(actor: UserRow, opts: { q?: string; limit: number; offset: number }) {
    return this.c.contacts.list({
      ownerAdminId: this.ownerFor(actor),
      q: opts.q,
      limit: opts.limit,
      offset: opts.offset,
    });
  }

  async createContact(
    actor: UserRow,
    input: {
      phone: string;
      name?: string;
      email?: string;
      country?: string;
      language?: string;
      optedIn?: boolean;
      source?: string;
    },
    req: Context,
  ) {
    const { e164 } = normalizePhone(input.phone);
    if (!e164) throw new AppError('VALIDATION_ERROR', 'A valid phone number is required.');

    const limits = await this.packages.limitsFor(actor);
    const current = await this.c.db.count(
      `SELECT COUNT(*) AS c FROM crm_contacts WHERE owner_admin_id = ?`,
      this.ownerFor(actor),
    );
    if (current >= limits.contactLimit) {
      throw new AppError('FORBIDDEN', 'Contact limit for this package has been reached.', {
        code: 'PACKAGE_LIMIT_REACHED',
        resource: 'contactLimit',
        currentUsage: current,
        max: limits.contactLimit,
      });
    }

    const contact = await this.c.contacts.upsert({
      ownerAdminId: this.ownerFor(actor),
      phone: input.phone,
      name: input.name,
      email: input.email,
      country: input.country,
      language: input.language,
      optedIn: input.optedIn ?? false,
      source: input.source ?? 'MANUAL',
    });

    await this.auditCrm(actor, 'CONTACT_UPSERTED', contact.id, req, { phone: contact.phone });
    return contact;
  }

  /**
   * §31 CSV import: validate → normalise → deduplicate → opt-in gating.
   * Returns a per-row report instead of silently dropping bad data.
   */
  async importContacts(
    actor: UserRow,
    input: { csv: string; markOptIn?: boolean; source?: string },
    req: Context,
  ) {
    const rows = parseCsv(input.csv);
    if (!rows.length) throw new AppError('VALIDATION_ERROR', 'No rows found in the import file.');

    const header = rows[0].map((h) => h.trim().toLowerCase());
    const phoneIdx = indexOfAny(header, ['phone', 'mobile', 'number', 'whatsapp', 'contact']);
    const nameIdx = indexOfAny(header, ['name', 'full_name', 'fullname', 'contact_name']);
    const emailIdx = indexOfAny(header, ['email', 'e-mail', 'email_address']);
    const countryIdx = indexOfAny(header, ['country', 'country_code']);
    const langIdx = indexOfAny(header, ['language', 'lang']);

    if (phoneIdx === -1) {
      throw new AppError('VALIDATION_ERROR', 'The import file must contain a phone column.');
    }

    const ownerAdminId = this.ownerFor(actor);
    const limits = await this.packages.limitsFor(actor);
    const current = await this.c.db.count(
      `SELECT COUNT(*) AS c FROM crm_contacts WHERE owner_admin_id = ?`,
      ownerAdminId,
    );
    let capacity = Math.max(0, limits.contactLimit - current);

    const report = {
      total: Math.max(0, rows.length - 1),
      imported: 0,
      duplicates: 0,
      invalid: 0,
      overLimit: 0,
      errors: [] as { row: number; reason: string }[],
    };

    const seen = new Set<string>();
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      const raw = (row[phoneIdx] ?? '').trim();
      const { e164 } = normalizePhone(raw);
      if (!e164) {
        report.invalid += 1;
        report.errors.push({ row: i + 1, reason: 'Missing or invalid phone number' });
        continue;
      }
      if (seen.has(e164)) {
        report.duplicates += 1;
        continue;
      }
      seen.add(e164);

      if (capacity <= 0) {
        report.overLimit += 1;
        continue;
      }

      const existing = await this.c.db.one<{ id: string }>(
        `SELECT id FROM crm_contacts WHERE owner_admin_id = ? AND phone_e164 = ?`,
        ownerAdminId,
        e164,
      );
      if (existing) {
        report.duplicates += 1;
        continue;
      }

      await this.c.contacts.upsert({
        ownerAdminId,
        phone: raw,
        name: nameIdx >= 0 ? (row[nameIdx] ?? '').trim() : '',
        email: emailIdx >= 0 ? (row[emailIdx] ?? '').trim() : '',
        country: countryIdx >= 0 ? (row[countryIdx] ?? '').trim() : '',
        language: langIdx >= 0 ? (row[langIdx] ?? '').trim() : '',
        optedIn: input.markOptIn ?? false,
        source: input.source ?? 'IMPORT',
      });
      capacity -= 1;
      report.imported += 1;
    }

    await this.auditCrm(actor, 'CONTACTS_IMPORTED', '', req, { report });
    return report;
  }

  async setOptIn(actor: UserRow, contactId: string, optedIn: boolean, req: Context) {
    const contact = await this.c.contacts.findById(contactId);
    if (!contact || contact.owner_admin_id !== this.ownerFor(actor)) {
      throw new AppError('NOT_FOUND', 'Contact not found.');
    }
    await this.c.contacts.setOptIn(contactId, optedIn);
    await this.auditCrm(actor, 'CONTACT_OPTIN_CHANGED', contactId, req, { optedIn });
    return this.c.contacts.findById(contactId);
  }

  /* --------------------------- lists --------------------------- */

  async createList(actor: UserRow, name: string, req: Context) {
    const list = await this.c.contacts.createList(this.ownerFor(actor), name);
    await this.auditCrm(actor, 'LIST_CREATED', list.id, req, { name });
    return list;
  }

  async listLists(actor: UserRow) {
    return this.c.contacts.listLists(this.ownerFor(actor));
  }

  async addToList(actor: UserRow, listId: string, contactIds: string[], req: Context) {
    const added = await this.c.contacts.addToList(listId, contactIds);
    await this.auditCrm(actor, 'LIST_MEMBERS_ADDED', listId, req, { added });
    return { added };
  }

  async listMembers(actor: UserRow, listId: string) {
    return this.c.contacts.listMembers(listId);
  }

  /* --------------------------- leads (canonical) --------------------------- */

  /**
   * The single entry point for every lead source.
   * `dedupeKey` defaults to the normalised phone so the same person imported
   * from WhatsApp, a web form and a CSV remains ONE lead.
   */
  async ingestLead(
    actor: UserRow,
    input: {
      name: string;
      phone: string;
      email?: string;
      source: string;
      campaignId?: string | null;
      score?: number;
      intent?: string;
      language?: string;
      country?: string;
      consent?: boolean;
      stage?: string;
      assignedTo?: string | null;
      contactId?: string | null;
      dedupeKey?: string;
    },
    req: Context,
  ) {
    const ownerAdminId = this.ownerFor(actor);
    const { e164 } = normalizePhone(input.phone);
    if (!e164) throw new AppError('VALIDATION_ERROR', 'A valid phone number is required.');

    const limits = await this.packages.limitsFor(actor);
    const dedupeKey = input.dedupeKey || `phone:${e164}`;
    const existing = await this.c.db.one<{ id: string }>(
      `SELECT id FROM leads WHERE owner_admin_id = ? AND dedupe_key = ?`,
      ownerAdminId,
      dedupeKey,
    );

    if (!existing) {
      const current = await this.c.db.count(
        `SELECT COUNT(*) AS c FROM leads WHERE owner_admin_id = ?`,
        ownerAdminId,
      );
      if (current >= limits.leadLimit) {
        throw new AppError('FORBIDDEN', 'Lead limit for this package has been reached.', {
          code: 'PACKAGE_LIMIT_REACHED',
          resource: 'leadLimit',
          currentUsage: current,
          max: limits.leadLimit,
        });
      }
    }

    const { lead, created } = await this.c.leads.upsert({
      ownerAdminId,
      name: input.name,
      phone: input.phone,
      email: input.email,
      source: input.source,
      campaignId: input.campaignId ?? null,
      contactId: input.contactId ?? null,
      stage: input.stage,
      score: input.score,
      intent: input.intent,
      language: input.language,
      country: input.country,
      consent: input.consent ?? false,
      assignedTo: input.assignedTo ?? null,
      dedupeKey,
    });

    if (created) {
      await this.c.leads.addActivity({
        leadId: lead.id,
        type: 'CREATED',
        body: `Lead created from ${input.source}`,
        actorType: 'SYSTEM',
        actorId: actor.id,
      });
    }

    await this.auditCrm(actor, created ? 'LEAD_CREATED' : 'LEAD_UPDATED', lead.id, req, {
      source: input.source,
      score: input.score ?? 0,
    });

    return { lead, created };
  }

  async listLeads(
    actor: UserRow,
    opts: {
      q?: string;
      stage?: string;
      source?: string;
      minScore?: number;
      assignedTo?: string;
      limit: number;
      offset: number;
    },
  ) {
    return this.c.leads.list({ ownerAdminId: this.ownerFor(actor), ...opts });
  }

  async updateLead(
    actor: UserRow,
    leadId: string,
    patch: { stage?: string; score?: number; status?: string; assignedTo?: string; intent?: string },
    req: Context,
  ) {
    const lead = await this.c.leads.findById(leadId);
    if (!lead || lead.owner_admin_id !== this.ownerFor(actor)) {
      throw new AppError('NOT_FOUND', 'Lead not found.');
    }
    const updated = await this.c.leads.update(leadId, patch);
    await this.auditCrm(actor, 'LEAD_UPDATED', leadId, req, patch);
    return updated;
  }

  async leadActivities(actor: UserRow, leadId: string) {
    const lead = await this.c.leads.findById(leadId);
    if (!lead || lead.owner_admin_id !== this.ownerFor(actor)) {
      throw new AppError('NOT_FOUND', 'Lead not found.');
    }
    return this.c.leads.activities(leadId);
  }

  async dashboard(actor: UserRow) {
    const ownerAdminId = this.ownerFor(actor);
    const [byStage, leadTotal, contactTotal] = await Promise.all([
      this.c.leads.countsByStage(ownerAdminId),
      this.c.db.count(`SELECT COUNT(*) AS c FROM leads WHERE owner_admin_id = ?`, ownerAdminId),
      this.c.db.count(`SELECT COUNT(*) AS c FROM crm_contacts WHERE owner_admin_id = ?`, ownerAdminId),
    ]);
    return {
      leads: { total: leadTotal, byStage },
      contacts: { total: contactTotal },
    };
  }

  private async auditCrm(
    actor: UserRow,
    action: string,
    targetId: string,
    req: Context,
    meta: Record<string, unknown>,
  ) {
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.CRM_MUTATION,
      targetType: 'crm',
      targetId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { crmAction: action, ...meta },
    });
  }
}

/* ------------------------------- CSV helpers ------------------------------- */

/** Minimal RFC4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

function indexOfAny(header: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const idx = header.indexOf(candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}
