import { Db } from '../db/client';
import { newId } from '../lib/crypto';

export interface TemplateRow {
  id: string;
  owner_admin_id: string;
  name: string;
  language: string;
  body: string;
  variables_json: string;
  status: string;
  created_at: number;
}

export interface CampaignRow {
  id: string;
  owner_admin_id: string;
  name: string;
  template_id: string | null;
  list_id: string | null;
  status: 'DRAFT' | 'QUEUED' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED';
  rate_limit_per_min: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

export interface MessageRow {
  id: string;
  campaign_id: string | null;
  owner_admin_id: string;
  contact_id: string | null;
  to_phone: string;
  body: string;
  provider: string;
  provider_message_id: string | null;
  status: 'QUEUED' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'REJECTED';
  error: string | null;
  created_at: number;
  updated_at: number;
}

export class TemplateRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    ownerAdminId: string;
    name: string;
    body: string;
    language?: string;
    variables?: string[];
  }): Promise<TemplateRow> {
    const id = newId('tpl');
    await this.db.run(
      `INSERT INTO whatsapp_templates (id, owner_admin_id, name, language, body, variables_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?)`,
      id,
      input.ownerAdminId,
      input.name,
      input.language ?? 'en',
      input.body,
      JSON.stringify(input.variables ?? []),
      Date.now(),
    );
    return (await this.db.one<TemplateRow>(
      `SELECT * FROM whatsapp_templates WHERE id = ?`,
      id,
    ))!;
  }

  async list(ownerAdminId: string): Promise<TemplateRow[]> {
    return this.db.many<TemplateRow>(
      `SELECT * FROM whatsapp_templates WHERE owner_admin_id = ? ORDER BY created_at DESC`,
      ownerAdminId,
    );
  }

  async findById(id: string): Promise<TemplateRow | null> {
    return this.db.one<TemplateRow>(`SELECT * FROM whatsapp_templates WHERE id = ?`, id);
  }
}

export class CampaignRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    ownerAdminId: string;
    name: string;
    templateId?: string | null;
    listId?: string | null;
    rateLimitPerMin?: number;
  }): Promise<CampaignRow> {
    const id = newId('cmp');
    await this.db.run(
      `INSERT INTO whatsapp_campaigns (id, owner_admin_id, name, template_id, list_id, status,
        rate_limit_per_min, created_at)
       VALUES (?, ?, ?, ?, ?, 'DRAFT', ?, ?)`,
      id,
      input.ownerAdminId,
      input.name,
      input.templateId ?? null,
      input.listId ?? null,
      input.rateLimitPerMin ?? 60,
      Date.now(),
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<CampaignRow | null> {
    return this.db.one<CampaignRow>(`SELECT * FROM whatsapp_campaigns WHERE id = ?`, id);
  }

  async list(ownerAdminId: string): Promise<CampaignRow[]> {
    return this.db.many<CampaignRow>(
      `SELECT * FROM whatsapp_campaigns WHERE owner_admin_id = ? ORDER BY created_at DESC`,
      ownerAdminId,
    );
  }

  async setStatus(
    id: string,
    status: CampaignRow['status'],
  ): Promise<CampaignRow | null> {
    const now = Date.now();
    if (status === 'RUNNING') {
      await this.db.run(
        `UPDATE whatsapp_campaigns SET status = ?, started_at = COALESCE(started_at, ?) WHERE id = ?`,
        status,
        now,
        id,
      );
    } else if (status === 'COMPLETED' || status === 'FAILED') {
      await this.db.run(
        `UPDATE whatsapp_campaigns SET status = ?, completed_at = ? WHERE id = ?`,
        status,
        now,
        id,
      );
    } else {
      await this.db.run(`UPDATE whatsapp_campaigns SET status = ? WHERE id = ?`, status, id);
    }
    return this.findById(id);
  }
}

export class MessageRepository {
  constructor(private readonly db: Db) {}

  async enqueue(input: {
    campaignId: string | null;
    ownerAdminId: string;
    contactId: string | null;
    toPhone: string;
    body: string;
    provider: string;
  }): Promise<MessageRow> {
    const now = Date.now();
    const id = newId('msg');
    await this.db.run(
      `INSERT INTO whatsapp_messages (id, campaign_id, owner_admin_id, contact_id, to_phone, body,
        provider, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?)`,
      id,
      input.campaignId,
      input.ownerAdminId,
      input.contactId,
      input.toPhone,
      input.body,
      input.provider,
      now,
      now,
    );
    return (await this.db.one<MessageRow>(`SELECT * FROM whatsapp_messages WHERE id = ?`, id))!;
  }

  /** Delivery status is only ever set from a real provider response (§31). */
  async setStatus(input: {
    id: string;
    status: MessageRow['status'];
    providerMessageId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.db.run(
      `UPDATE whatsapp_messages SET status = ?, provider_message_id = COALESCE(?, provider_message_id),
        error = ?, updated_at = ?
       WHERE id = ?`,
      input.status,
      input.providerMessageId ?? null,
      input.error ?? null,
      Date.now(),
      input.id,
    );
  }

  async findByProviderMessageId(providerMessageId: string): Promise<MessageRow | null> {
    return this.db.one<MessageRow>(
      `SELECT * FROM whatsapp_messages WHERE provider_message_id = ?`,
      providerMessageId,
    );
  }

  async queuedForCampaign(campaignId: string, limit: number): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT * FROM whatsapp_messages WHERE campaign_id = ? AND status = 'QUEUED'
       ORDER BY created_at ASC LIMIT ?`,
      campaignId,
      limit,
    );
  }

  async list(opts: {
    ownerAdminId: string;
    campaignId?: string;
    status?: MessageRow['status'];
    limit: number;
    offset: number;
  }): Promise<{ rows: MessageRow[]; total: number }> {
    const clauses = ['owner_admin_id = ?'];
    const params: unknown[] = [opts.ownerAdminId];
    if (opts.campaignId) {
      clauses.push('campaign_id = ?');
      params.push(opts.campaignId);
    }
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const rows = await this.db.many<MessageRow>(
      `SELECT * FROM whatsapp_messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
    const total = await this.db.count(
      `SELECT COUNT(*) AS c FROM whatsapp_messages ${where}`,
      ...params,
    );
    return { rows, total };
  }

  async stats(ownerAdminId: string, campaignId?: string) {
    const params: unknown[] = [ownerAdminId];
    let where = 'WHERE owner_admin_id = ?';
    if (campaignId) {
      where += ' AND campaign_id = ?';
      params.push(campaignId);
    }
    const rows = await this.db.many<{ status: string; c: number }>(
      `SELECT status, COUNT(*) AS c FROM whatsapp_messages ${where} GROUP BY status`,
      ...params,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.c);
    return out;
  }
}

/* ============================ DESTINATIONS (§32) ============================ */

export interface DestinationRow {
  id: string;
  owner_admin_id: string;
  kind: 'TELEGRAM' | 'WEBHOOK';
  name: string;
  secret_ref: string;       // NAME of a Worker secret — never the secret itself
  config_json: string;      // non-secret config only (chat id, url, labels)
  is_active: number;
  created_at: number;
}

export class DestinationRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    ownerAdminId: string;
    kind: DestinationRow['kind'];
    name: string;
    secretRef?: string;
    config?: Record<string, unknown>;
  }): Promise<DestinationRow> {
    const id = newId('dst');
    await this.db.run(
      `INSERT INTO destinations (id, owner_admin_id, kind, name, secret_ref, config_json, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      id,
      input.ownerAdminId,
      input.kind,
      input.name,
      input.secretRef ?? '',
      JSON.stringify(input.config ?? {}),
      Date.now(),
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<DestinationRow | null> {
    return this.db.one<DestinationRow>(`SELECT * FROM destinations WHERE id = ?`, id);
  }

  async list(ownerAdminId: string, activeOnly = false): Promise<DestinationRow[]> {
    return this.db.many<DestinationRow>(
      `SELECT * FROM destinations WHERE owner_admin_id = ? ${activeOnly ? 'AND is_active = 1' : ''}
       ORDER BY created_at DESC`,
      ownerAdminId,
    );
  }

  async update(
    id: string,
    patch: { name?: string; config?: Record<string, unknown>; isActive?: boolean; secretRef?: string },
  ): Promise<DestinationRow | null> {
    const now = Date.now();
    if (patch.name !== undefined) {
      await this.db.run(`UPDATE destinations SET name = ? WHERE id = ?`, patch.name, id);
    }
    if (patch.config !== undefined) {
      await this.db.run(
        `UPDATE destinations SET config_json = ? WHERE id = ?`,
        JSON.stringify(patch.config),
        id,
      );
    }
    if (patch.isActive !== undefined) {
      await this.db.run(
        `UPDATE destinations SET is_active = ? WHERE id = ?`,
        patch.isActive ? 1 : 0,
        id,
      );
    }
    if (patch.secretRef !== undefined) {
      await this.db.run(
        `UPDATE destinations SET secret_ref = ? WHERE id = ?`,
        patch.secretRef,
        id,
      );
    }
    void now;
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM destinations WHERE id = ?`, id);
  }
}

export interface RoutingRuleRow {
  id: string;
  owner_admin_id: string;
  name: string;
  destination_id: string;
  min_score: number;
  intent: string;
  campaign_id: string | null;
  language: string;
  country: string;
  source: string;
  stage: string;
  requires_consent: number;
  priority: number;
  is_active: number;
  created_at: number;
}

export class RoutingRuleRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    ownerAdminId: string;
    name: string;
    destinationId: string;
    minScore?: number;
    intent?: string;
    campaignId?: string | null;
    language?: string;
    country?: string;
    source?: string;
    stage?: string;
    requiresConsent?: boolean;
    priority?: number;
  }): Promise<RoutingRuleRow> {
    const id = newId('rul');
    await this.db.run(
      `INSERT INTO routing_rules (id, owner_admin_id, name, destination_id, min_score, intent,
        campaign_id, language, country, source, stage, requires_consent, priority, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      id,
      input.ownerAdminId,
      input.name,
      input.destinationId,
      input.minScore ?? 0,
      input.intent ?? '',
      input.campaignId ?? null,
      input.language ?? '',
      input.country ?? '',
      input.source ?? '',
      input.stage ?? '',
      input.requiresConsent === false ? 0 : 1,
      input.priority ?? 100,
      Date.now(),
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<RoutingRuleRow | null> {
    return this.db.one<RoutingRuleRow>(`SELECT * FROM routing_rules WHERE id = ?`, id);
  }

  async list(ownerAdminId: string, activeOnly = false): Promise<RoutingRuleRow[]> {
    return this.db.many<RoutingRuleRow>(
      `SELECT * FROM routing_rules WHERE owner_admin_id = ? ${activeOnly ? 'AND is_active = 1' : ''}
       ORDER BY priority ASC, created_at ASC`,
      ownerAdminId,
    );
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    await this.db.run(
      `UPDATE routing_rules SET is_active = ? WHERE id = ?`,
      isActive ? 1 : 0,
      id,
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM routing_rules WHERE id = ?`, id);
  }
}

export interface DeliveryRow {
  id: string;
  rule_id: string;
  destination_id: string;
  lead_id: string;
  status: 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';
  attempts: number;
  last_error: string | null;
  dedupe_key: string;
  created_at: number;
  updated_at: number;
}

export class DeliveryRepository {
  constructor(private readonly db: Db) {}

  /** dedupe_key is UNIQUE — a lead is never pushed twice for the same rule (§32). */
  async create(input: {
    ruleId: string;
    destinationId: string;
    leadId: string;
    dedupeKey: string;
  }): Promise<{ row: DeliveryRow; created: boolean }> {
    const existing = await this.db.one<DeliveryRow>(
      `SELECT * FROM deliveries WHERE dedupe_key = ?`,
      input.dedupeKey,
    );
    if (existing) return { row: existing, created: false };

    const now = Date.now();
    const id = newId('dlv');
    await this.db.run(
      `INSERT INTO deliveries (id, rule_id, destination_id, lead_id, status, attempts, dedupe_key,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING', 0, ?, ?, ?)`,
      id,
      input.ruleId,
      input.destinationId,
      input.leadId,
      input.dedupeKey,
      now,
      now,
    );
    const row = (await this.db.one<DeliveryRow>(
      `SELECT * FROM deliveries WHERE id = ?`,
      id,
    ))!;
    return { row, created: true };
  }

  async mark(input: {
    id: string;
    status: DeliveryRow['status'];
    error?: string | null;
  }): Promise<void> {
    await this.db.run(
      `UPDATE deliveries SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
       WHERE id = ?`,
      input.status,
      input.error ?? null,
      Date.now(),
      input.id,
    );
  }

  async list(opts: {
    ownerAdminId?: string;
    leadId?: string;
    status?: DeliveryRow['status'];
    limit: number;
    offset: number;
  }): Promise<DeliveryRow[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.leadId) {
      clauses.push('lead_id = ?');
      params.push(opts.leadId);
    }
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.many<DeliveryRow>(
      `SELECT * FROM deliveries ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
  }

  async pending(limit: number): Promise<DeliveryRow[]> {
    return this.db.many<DeliveryRow>(
      `SELECT * FROM deliveries WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT ?`,
      limit,
    );
  }
}
