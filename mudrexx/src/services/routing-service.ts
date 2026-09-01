import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { clientIp, userAgentOf } from '../lib/http';
import { AUDIT_ACTIONS } from '../repositories/platform';
import type { UserRow } from '../types';
import type { DestinationRow, RoutingRuleRow } from '../repositories/messaging';
import type { LeadRow } from '../repositories/crm';

/**
 * §32/§33 Destinations and lead routing.
 *
 * Lead → Qualification → Rule → Destination.
 *
 * Rules: the bot token / webhook secret is never stored in the database and is
 * never returned by any API. Destinations reference a Worker secret BY NAME.
 * Deliveries are deduplicated, so a lead is never pushed twice for one rule.
 */
export class RoutingService {
  constructor(private readonly c: Container) {}

  /* --------------------------- destinations --------------------------- */

  private resolveSecret(destination: DestinationRow): string {
    const ref = destination.secret_ref;
    if (ref) {
      const value = (this.c.env as unknown as Record<string, string | undefined>)[ref];
      if (value) return value;
    }
    // Fall back to the platform-wide secret for this destination kind.
    return destination.kind === 'TELEGRAM' ? this.c.env.TELEGRAM_BOT_TOKEN ?? '' : '';
  }

  /** Response shape never includes the secret. */
  private publicView(destination: DestinationRow) {
    const config = safeJson(destination.config_json);
    return {
      id: destination.id,
      kind: destination.kind,
      name: destination.name,
      isActive: destination.is_active === 1,
      // Only the secret NAME is exposed — never its value.
      secretRef: destination.secret_ref || null,
      secretConfigured: Boolean(this.resolveSecret(destination)),
      config: config,
      createdAt: destination.created_at,
    };
  }

  async createDestination(
    actor: UserRow,
    input: {
      kind: DestinationRow['kind'];
      name: string;
      secretRef?: string;
      config?: Record<string, unknown>;
    },
    req: Context,
  ) {
    if (!input.name?.trim()) throw new AppError('VALIDATION_ERROR', 'Destination name is required.');
    if (!['TELEGRAM', 'WEBHOOK'].includes(input.kind)) {
      throw new AppError('VALIDATION_ERROR', 'Destination kind must be TELEGRAM or WEBHOOK.');
    }
    if (input.kind === 'WEBHOOK') {
      const url = String(input.config?.url ?? '');
      if (!/^https:\/\//.test(url)) {
        throw new AppError('VALIDATION_ERROR', 'Webhook destinations require an https URL.');
      }
    }

    const destination = await this.c.destinations.create({
      ownerAdminId: actor.id,
      kind: input.kind,
      name: input.name.trim(),
      secretRef: input.secretRef ?? '',
      config: input.config ?? {},
    });
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'DESTINATION_CREATED',
      targetType: 'destination',
      targetId: destination.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { kind: destination.kind },
    });
    return this.publicView(destination);
  }

  async listDestinations(actor: UserRow) {
    const rows = await this.c.destinations.list(actor.id);
    return rows.map((d) => this.publicView(d));
  }

  async updateDestination(
    actor: UserRow,
    id: string,
    patch: { name?: string; config?: Record<string, unknown>; isActive?: boolean; secretRef?: string },
    req: Context,
  ) {
    const destination = await this.c.destinations.findById(id);
    if (!destination || destination.owner_admin_id !== actor.id) {
      throw new AppError('NOT_FOUND', 'Destination not found.');
    }
    const updated = await this.c.destinations.update(id, patch);
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'DESTINATION_UPDATED',
      targetType: 'destination',
      targetId: id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { patch: Object.keys(patch) },
    });
    return updated ? this.publicView(updated) : null;
  }

  /* ------------------------------ rules ------------------------------ */

  async createRule(
    actor: UserRow,
    input: {
      name: string;
      destinationId: string;
      minScore?: number;
      intent?: string;
      campaignId?: string;
      language?: string;
      country?: string;
      source?: string;
      stage?: string;
      requiresConsent?: boolean;
      priority?: number;
    },
    req: Context,
  ) {
    if (!input.name?.trim()) throw new AppError('VALIDATION_ERROR', 'Rule name is required.');
    const destination = await this.c.destinations.findById(input.destinationId);
    if (!destination || destination.owner_admin_id !== actor.id) {
      throw new AppError('NOT_FOUND', 'Destination not found.');
    }
    const rule = await this.c.routingRules.create({
      ownerAdminId: actor.id,
      name: input.name.trim(),
      destinationId: input.destinationId,
      minScore: input.minScore ?? 0,
      intent: input.intent,
      campaignId: input.campaignId ?? null,
      language: input.language,
      country: input.country,
      source: input.source,
      stage: input.stage,
      requiresConsent: input.requiresConsent ?? true,
      priority: input.priority ?? 100,
    });
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'ROUTING_RULE_CREATED',
      targetType: 'routing_rule',
      targetId: rule.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
    return rule;
  }

  async listRules(actor: UserRow) {
    return this.c.routingRules.list(actor.id);
  }

  async setRuleActive(actor: UserRow, id: string, isActive: boolean, req: Context) {
    const rule = await this.c.routingRules.findById(id);
    if (!rule || rule.owner_admin_id !== actor.id) {
      throw new AppError('NOT_FOUND', 'Rule not found.');
    }
    await this.c.routingRules.setActive(id, isActive);
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'ROUTING_RULE_TOGGLED',
      targetType: 'routing_rule',
      targetId: id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { isActive },
    });
    return this.c.routingRules.findById(id);
  }

  /* ---------------------------- evaluation ---------------------------- */

  /** §33 rule matching. Every field present on the rule must match the lead. */
  matches(rule: RoutingRuleRow, lead: LeadRow): boolean {
    if (rule.is_active !== 1) return false;
    if (lead.score < rule.min_score) return false;
    if (rule.intent && lead.intent.toLowerCase() !== rule.intent.toLowerCase()) return false;
    if (rule.campaign_id && lead.campaign_id !== rule.campaign_id) return false;
    if (rule.language && lead.language.toLowerCase() !== rule.language.toLowerCase()) return false;
    if (rule.country && lead.country.toLowerCase() !== rule.country.toLowerCase()) return false;
    if (rule.source && lead.source.toLowerCase() !== rule.source.toLowerCase()) return false;
    if (rule.stage && lead.stage.toLowerCase() !== rule.stage.toLowerCase()) return false;
    return true;
  }

  /**
   * Route one lead through the matching rules.
   * Consent is required by default; the dedupe key prevents duplicate pushes.
   */
  async routeLead(actor: UserRow, leadId: string, req: Context) {
    const lead = await this.c.leads.findById(leadId);
    if (!lead || lead.owner_admin_id !== actor.id) {
      throw new AppError('NOT_FOUND', 'Lead not found.');
    }

    const rules = (await this.c.routingRules.list(actor.id, true))
      .filter((r) => this.matches(r, lead))
      .sort((a, b) => a.priority - b.priority);

    const outcomes: {
      ruleId: string;
      destinationId: string;
      status: string;
      error?: string;
      deduped?: boolean;
    }[] = [];

    for (const rule of rules) {
      const dedupeKey = `rule:${rule.id}:lead:${lead.id}`;
      const { row, created } = await this.c.deliveries.create({
        ruleId: rule.id,
        destinationId: rule.destination_id,
        leadId: lead.id,
        dedupeKey,
      });

      if (!created) {
        outcomes.push({
          ruleId: rule.id,
          destinationId: rule.destination_id,
          status: row.status,
          deduped: true,
        });
        continue;
      }

      if (rule.requires_consent === 1 && lead.consent !== 1) {
        await this.c.deliveries.mark({ id: row.id, status: 'SKIPPED', error: 'CONSENT_REQUIRED' });
        outcomes.push({
          ruleId: rule.id,
          destinationId: rule.destination_id,
          status: 'SKIPPED',
          error: 'CONSENT_REQUIRED',
        });
        continue;
      }

      const destination = await this.c.destinations.findById(rule.destination_id);
      if (!destination || destination.is_active !== 1) {
        await this.c.deliveries.mark({
          id: row.id,
          status: 'SKIPPED',
          error: 'DESTINATION_INACTIVE',
        });
        outcomes.push({
          ruleId: rule.id,
          destinationId: rule.destination_id,
          status: 'SKIPPED',
          error: 'DESTINATION_INACTIVE',
        });
        continue;
      }

      try {
        await this.deliver(destination, lead);
        await this.c.deliveries.mark({ id: row.id, status: 'SENT' });
        await this.c.leads.addActivity({
          leadId: lead.id,
          type: 'ROUTED',
          body: `Routed to ${destination.kind} destination "${destination.name}"`,
          actorType: 'SYSTEM',
          actorId: actor.id,
        });
        outcomes.push({ ruleId: rule.id, destinationId: destination.id, status: 'SENT' });
      } catch (err) {
        const message = (err as Error).message;
        await this.c.deliveries.mark({ id: row.id, status: 'FAILED', error: message });
        outcomes.push({
          ruleId: rule.id,
          destinationId: destination.id,
          status: 'FAILED',
          error: message,
        });
      }
    }

    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.TELEGRAM_ROUTE,
      targetType: 'lead',
      targetId: lead.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { outcomes },
    });

    return { leadId: lead.id, matchedRules: rules.length, outcomes };
  }

  /** Real outbound delivery. Fails loudly when the destination is unconfigured. */
  private async deliver(destination: DestinationRow, lead: LeadRow): Promise<void> {
    const config = safeJson(destination.config_json);
    const text = `Lead ${lead.name} (${lead.phone}) score=${lead.score} intent=${lead.intent || 'n/a'} source=${lead.source}`;

    if (destination.kind === 'TELEGRAM') {
      const token = this.resolveSecret(destination);
      if (!token) {
        throw new AppError(
          'PROVIDER_NOT_CONFIGURED',
          'Telegram destination has no configured bot token secret.',
          { destinationId: destination.id },
        );
      }
      const chatId = String(config.chatId ?? '');
      if (!chatId) throw new AppError('VALIDATION_ERROR', 'Telegram destination is missing chatId.');

      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      if (!res.ok) {
        throw new AppError('PROVIDER_ERROR', `Telegram delivery failed with HTTP ${res.status}`, {
          status: res.status,
        });
      }
      return;
    }

    const url = String(config.url ?? '');
    if (!/^https:\/\//.test(url)) {
      throw new AppError('VALIDATION_ERROR', 'Webhook destination requires an https URL.');
    }
    const payload = JSON.stringify({
      type: 'lead.routed',
      lead: {
        id: lead.id,
        name: lead.name,
        phone: lead.phone,
        email: lead.email,
        score: lead.score,
        intent: lead.intent,
        source: lead.source,
        stage: lead.stage,
        consent: lead.consent === 1,
      },
      destination: { id: destination.id, name: destination.name },
      sentAt: Date.now(),
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const signingSecret = this.c.env.WEBHOOK_DELIVERY_SECRET;
    if (signingSecret) headers['x-mudrexx-signature'] = await hmacHex(signingSecret, payload);

    const res = await fetch(url, { method: 'POST', headers, body: payload });
    if (!res.ok) {
      throw new AppError('PROVIDER_ERROR', `Webhook delivery failed with HTTP ${res.status}`, {
        status: res.status,
      });
    }
  }

  async deliveries(actor: UserRow, opts: { leadId?: string; limit: number; offset: number }) {
    return this.c.deliveries.list({ ...opts });
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
