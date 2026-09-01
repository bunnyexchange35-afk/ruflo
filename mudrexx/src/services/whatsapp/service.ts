import type { Context } from 'hono';
import type { Container } from '../../container';
import { AppError } from '../../http/errors';
import { clientIp, userAgentOf } from '../../lib/http';
import { RATE_LIMITS } from '../../config';
import { AUDIT_ACTIONS } from '../../repositories/platform';
import type { UserRow } from '../../types';
import type { MessageRow } from '../../repositories/messaging';
import { PackageService } from '../package-service';
import { resolveWhatsAppProvider, whatsAppStatus } from './provider';

/**
 * §31 WhatsApp campaigns: template variables, queue, rate limiting, retries
 * and real delivery status. Nothing here marks a message delivered without a
 * provider response or a provider webhook.
 */
export class WhatsAppService {
  private readonly packages: PackageService;

  constructor(private readonly c: Container) {
    this.packages = new PackageService(c);
  }

  status() {
    return whatsAppStatus(this.c.env);
  }

  /** Render `Hello {{1}}, your code is {{2}}` with positional variables. */
  renderTemplate(body: string, variables: Record<string, string>): string {
    return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, rawIndex: string) => {
      const value = variables[String(Number(rawIndex))];
      return value !== undefined ? value : match;
    });
  }

  async createTemplate(
    actor: UserRow,
    input: { name: string; body: string; language?: string; variables?: string[] },
    req: Context,
  ) {
    if (!input.name?.trim()) throw new AppError('VALIDATION_ERROR', 'Template name is required.');
    if (!input.body?.trim()) throw new AppError('VALIDATION_ERROR', 'Template body is required.');
    const template = await this.c.templates.create({
      ownerAdminId: actor.id,
      name: input.name.trim(),
      body: input.body,
      language: input.language ?? 'en',
      variables: input.variables ?? [],
    });
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'WHATSAPP_TEMPLATE_CREATED',
      targetType: 'whatsapp_template',
      targetId: template.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
    return template;
  }

  async listTemplates(actor: UserRow) {
    return this.c.templates.list(actor.id);
  }

  async createCampaign(
    actor: UserRow,
    input: { name: string; templateId?: string; listId?: string; rateLimitPerMin?: number },
    req: Context,
  ) {
    if (!input.name?.trim()) throw new AppError('VALIDATION_ERROR', 'Campaign name is required.');
    const campaign = await this.c.campaigns.create({
      ownerAdminId: actor.id,
      name: input.name.trim(),
      templateId: input.templateId ?? null,
      listId: input.listId ?? null,
      rateLimitPerMin: input.rateLimitPerMin ?? 60,
    });
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.CAMPAIGN_PUBLISHED,
      targetType: 'whatsapp_campaign',
      targetId: campaign.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { status: campaign.status },
    });
    return campaign;
  }

  async listCampaigns(actor: UserRow) {
    return this.c.campaigns.list(actor.id);
  }

  /**
   * Queue a campaign: opt-in contacts only, bounded by the package quota and
   * the per-minute rate limit. Messages are persisted as QUEUED.
   */
  async queueCampaign(actor: UserRow, campaignId: string, req: Context) {
    const campaign = await this.c.campaigns.findById(campaignId);
    if (!campaign || campaign.owner_admin_id !== actor.id) {
      throw new AppError('NOT_FOUND', 'Campaign not found.');
    }
    if (!campaign.list_id) throw new AppError('VALIDATION_ERROR', 'Campaign has no contact list.');
    if (!campaign.template_id) {
      throw new AppError('VALIDATION_ERROR', 'Campaign has no template.');
    }
    const template = await this.c.templates.findById(campaign.template_id);
    if (!template) throw new AppError('NOT_FOUND', 'Template not found.');

    const provider = resolveWhatsAppProvider(this.c.env);
    const contacts = await this.c.contacts.listMembers(campaign.list_id);
    const eligible = contacts.filter((c) => c.opted_in === 1);

    const limits = await this.packages.limitsFor(actor);
    const since = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1);
    const sentThisMonth = await this.c.db.count(
      `SELECT COUNT(*) AS c FROM whatsapp_messages
       WHERE owner_admin_id = ? AND created_at >= ? AND status != 'REJECTED'`,
      actor.id,
      since,
    );
    const capacity = Math.max(0, limits.whatsappUsage - sentThisMonth);
    const batch = eligible.slice(0, Math.min(capacity, campaign.rate_limit_per_min));

    let queued = 0;
    for (const contact of batch) {
      const body = this.renderTemplate(template.body, {
        '1': contact.name,
        '2': contact.phone,
      });
      await this.c.waMessages.enqueue({
        campaignId: campaign.id,
        ownerAdminId: actor.id,
        contactId: contact.id,
        toPhone: contact.phone_e164 || contact.phone,
        body,
        provider: provider.name,
      });
      queued += 1;
    }

    await this.c.campaigns.setStatus(campaign.id, 'QUEUED');
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.WHATSAPP_CAMPAIGN,
      targetType: 'whatsapp_campaign',
      targetId: campaign.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { queued, eligible: eligible.length, capacity, provider: provider.name },
    });

    return {
      campaignId: campaign.id,
      provider: provider.name,
      eligible: eligible.length,
      queued,
      skippedOptOut: contacts.length - eligible.length,
      capacity,
    };
  }

  /** Send a bounded batch. Real provider call per message; failures are recorded. */
  async sendBatch(actor: UserRow, campaignId: string, limit: number, req: Context) {
    const campaign = await this.c.campaigns.findById(campaignId);
    if (!campaign || campaign.owner_admin_id !== actor.id) {
      throw new AppError('NOT_FOUND', 'Campaign not found.');
    }

    const bucketKey = `wa:${actor.id}`;
    const allowed = await this.c.rateLimits.checkAndIncrement(
      bucketKey,
      RATE_LIMITS.BULK_MESSAGE.limit,
      RATE_LIMITS.BULK_MESSAGE.windowMs,
    );
    if (!allowed.allowed) {
      throw new AppError('RATE_LIMITED', 'Bulk messaging rate limit reached. Try again shortly.', {
        resetAt: allowed.resetAt,
      });
    }

    const provider = resolveWhatsAppProvider(this.c.env);
    const queued = await this.c.waMessages.queuedForCampaign(campaignId, Math.min(limit, 100));
    const results: { id: string; status: string; error?: string }[] = [];

    await this.c.campaigns.setStatus(campaignId, 'RUNNING');

    for (const message of queued) {
      try {
        const result = await provider.sendText(
          { to: message.to_phone, body: message.body },
          this.c.env,
        );
        if (result.status === 'SENT') {
          await this.c.waMessages.setStatus({
            id: message.id,
            status: 'SENT',
            providerMessageId: result.providerMessageId ?? null,
          });
        } else {
          await this.c.waMessages.setStatus({
            id: message.id,
            status: 'FAILED',
            error: result.error ?? 'Provider rejected the message',
          });
        }
        results.push({ id: message.id, status: result.status, error: result.error });
      } catch (err) {
        await this.c.waMessages.setStatus({
          id: message.id,
          status: 'FAILED',
          error: (err as Error).message,
        });
        results.push({ id: message.id, status: 'FAILED', error: (err as Error).message });
      }
    }

    const remaining = await this.c.waMessages.queuedForCampaign(campaignId, 1);
    if (!remaining.length) await this.c.campaigns.setStatus(campaignId, 'COMPLETED');

    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.WHATSAPP_CAMPAIGN,
      targetType: 'whatsapp_campaign',
      targetId: campaignId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { sent: results.filter((r) => r.status === 'SENT').length, failed: results.filter((r) => r.status === 'FAILED').length },
    });

    return { provider: provider.name, results };
  }

  /** Single outbound message (e.g. an AI-crafted reply). */
  async sendSingle(actor: UserRow, input: { to: string; body: string }, req: Context) {
    const provider = resolveWhatsAppProvider(this.c.env);
    const message = await this.c.waMessages.enqueue({
      campaignId: null,
      ownerAdminId: actor.id,
      contactId: null,
      toPhone: input.to,
      body: input.body,
      provider: provider.name,
    });
    const result = await provider.sendText({ to: input.to, body: input.body }, this.c.env);
    await this.c.waMessages.setStatus({
      id: message.id,
      status: result.status === 'SENT' ? 'SENT' : 'FAILED',
      providerMessageId: result.providerMessageId ?? null,
      error: result.error ?? null,
    });
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'WHATSAPP_MESSAGE_SENT',
      targetType: 'whatsapp_message',
      targetId: message.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { status: result.status },
    });
    return this.c.waMessages.list({ ownerAdminId: actor.id, limit: 1, offset: 0 }).then((r) => r.rows[0]);
  }

  /** Inbound provider webhook → real delivery status only. */
  async applyStatusUpdate(
    providerMessageId: string,
    status: MessageRow['status'],
    error?: string,
  ): Promise<void> {
    const message = await this.c.waMessages.findByProviderMessageId(providerMessageId);
    if (!message) return;
    await this.c.waMessages.setStatus({ id: message.id, status, error: error ?? null });
  }

  async analytics(actor: UserRow, campaignId?: string) {
    return this.c.waMessages.stats(actor.id, campaignId);
  }

  async messages(
    actor: UserRow,
    opts: { campaignId?: string; status?: MessageRow['status']; limit: number; offset: number },
  ) {
    return this.c.waMessages.list({ ownerAdminId: actor.id, ...opts });
  }
}
