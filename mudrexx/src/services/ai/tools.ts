import type { Context } from 'hono';
import type { Container } from '../../container';
import { AppError } from '../../http/errors';
import { clientIp, userAgentOf } from '../../lib/http';
import { AUDIT_ACTIONS } from '../../repositories/platform';
import type { Role, UserRow } from '../../types';
import { CrmService } from '../crm-service';
import { TaskService } from '../task-service';

/**
 * §29 AI tools.
 *
 * Every tool declares its side effect and the roles allowed to run it. The
 * orchestrator authorises before executing and writes an audit record after,
 * so the AI can never exceed the caller's own permissions.
 */

export interface ToolContext {
  actor: UserRow;
  container: Container;
  req: Context;
}

export interface AiTool {
  name: string;
  description: string;
  sideEffect: 'READ' | 'WRITE';
  allowedRoles: Role[];
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

const MAX_TOOL_PAGE = 50;

function page(value: unknown): number {
  const n = Number(value ?? 20);
  if (!Number.isFinite(n) || n <= 0) return 20;
  return Math.min(Math.floor(n), MAX_TOOL_PAGE);
}

function str(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string') throw new AppError('VALIDATION_ERROR', `Tool argument "${field}" must be a string.`);
  return value.slice(0, max);
}

export function buildTools(container: Container): AiTool[] {
  const crm = new CrmService(container);
  const tasks = new TaskService(container);

  return [
    {
      name: 'search_leads',
      description: 'Search CRM leads by name, phone, email, stage, source or minimum score.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Free-text search' },
          stage: { type: 'string' },
          source: { type: 'string' },
          minScore: { type: 'number' },
          limit: { type: 'number' },
        },
      },
      async execute(args, ctx) {
        const result = await crm.listLeads(ctx.actor, {
          q: typeof args.query === 'string' ? args.query : undefined,
          stage: typeof args.stage === 'string' ? args.stage : undefined,
          source: typeof args.source === 'string' ? args.source : undefined,
          minScore: typeof args.minScore === 'number' ? args.minScore : undefined,
          limit: page(args.limit),
          offset: 0,
        });
        return { total: result.total, leads: result.rows };
      },
    },
    {
      name: 'get_lead',
      description: 'Fetch one lead by id, including its recent activity.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async execute(args, ctx) {
        const lead = await ctx.container.leads.findById(str(args.id, 'id', 64));
        if (!lead || lead.owner_admin_id !== ctx.actor.id) {
          throw new AppError('NOT_FOUND', 'Lead not found.');
        }
        return { lead, activities: await ctx.container.leads.activities(lead.id, 20) };
      },
    },
    {
      name: 'create_lead',
      description: 'Create or update a canonical CRM lead. Deduplicates by phone.',
      sideEffect: 'WRITE',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN'],
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          source: { type: 'string' },
          score: { type: 'number' },
          intent: { type: 'string' },
          language: { type: 'string' },
          country: { type: 'string' },
          consent: { type: 'boolean' },
        },
        required: ['name', 'phone'],
      },
      async execute(args, ctx) {
        return crm.ingestLead(
          ctx.actor,
          {
            name: str(args.name, 'name', 200),
            phone: str(args.phone, 'phone', 40),
            email: typeof args.email === 'string' ? args.email : undefined,
            source: typeof args.source === 'string' ? args.source : 'AI',
            score: typeof args.score === 'number' ? args.score : undefined,
            intent: typeof args.intent === 'string' ? args.intent : undefined,
            language: typeof args.language === 'string' ? args.language : undefined,
            country: typeof args.country === 'string' ? args.country : undefined,
            consent: args.consent === true,
          },
          ctx.req,
        );
      },
    },
    {
      name: 'update_lead',
      description: 'Update stage, score, status, assignment or intent of a lead.',
      sideEffect: 'WRITE',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN'],
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          stage: { type: 'string' },
          score: { type: 'number' },
          status: { type: 'string' },
          intent: { type: 'string' },
          assignedTo: { type: 'string' },
        },
        required: ['id'],
      },
      async execute(args, ctx) {
        return crm.updateLead(
          ctx.actor,
          str(args.id, 'id', 64),
          {
            stage: typeof args.stage === 'string' ? args.stage : undefined,
            score: typeof args.score === 'number' ? args.score : undefined,
            status: typeof args.status === 'string' ? args.status : undefined,
            intent: typeof args.intent === 'string' ? args.intent : undefined,
            assignedTo: typeof args.assignedTo === 'string' ? args.assignedTo : undefined,
          },
          ctx.req,
        );
      },
    },
    {
      name: 'search_contacts',
      description: 'Search CRM contacts by name, phone or email.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
      async execute(args, ctx) {
        return crm.listContacts(ctx.actor, {
          q: typeof args.query === 'string' ? args.query : undefined,
          limit: page(args.limit),
          offset: 0,
        });
      },
    },
    {
      name: 'get_contact',
      description: 'Fetch one CRM contact by id.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      async execute(args, ctx) {
        const contact = await ctx.container.contacts.findById(str(args.id, 'id', 64));
        if (!contact || contact.owner_admin_id !== ctx.actor.id) {
          throw new AppError('NOT_FOUND', 'Contact not found.');
        }
        return contact;
      },
    },
    {
      name: 'create_task',
      description: 'Create a task. Duplicate detection prevents assigning the same task twice.',
      sideEffect: 'WRITE',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
          dueAt: { type: 'number' },
          assignedUserId: { type: 'string' },
          assignedName: { type: 'string' },
          assignedPhone: { type: 'string' },
          category: { type: 'string' },
        },
        required: ['title'],
      },
      async execute(args, ctx) {
        return tasks.create(
          ctx.actor,
          {
            title: str(args.title, 'title', 200),
            description: typeof args.description === 'string' ? args.description : undefined,
            priority: args.priority as never,
            dueAt: typeof args.dueAt === 'number' ? args.dueAt : null,
            assignedUserId: typeof args.assignedUserId === 'string' ? args.assignedUserId : null,
            assignedName: typeof args.assignedName === 'string' ? args.assignedName : undefined,
            assignedPhone: typeof args.assignedPhone === 'string' ? args.assignedPhone : undefined,
            category: typeof args.category === 'string' ? args.category : undefined,
            source: 'AI',
          },
          ctx.req,
        );
      },
    },
    {
      name: 'update_task',
      description: 'Update the status, priority or due date of a task.',
      sideEffect: 'WRITE',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          status: { type: 'string', enum: ['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED'] },
          priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] },
          dueAt: { type: 'number' },
        },
        required: ['id'],
      },
      async execute(args, ctx) {
        return tasks.update(
          ctx.actor,
          str(args.id, 'id', 64),
          {
            status: args.status as never,
            priority: args.priority as never,
            due_at: typeof args.dueAt === 'number' ? args.dueAt : undefined,
          },
          ctx.req,
        );
      },
    },
    {
      name: 'create_followup',
      description: 'Create a follow-up task tied to a lead.',
      sideEffect: 'WRITE',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN'],
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string' },
          title: { type: 'string' },
          dueAt: { type: 'number' },
          priority: { type: 'string' },
        },
        required: ['leadId', 'title'],
      },
      async execute(args, ctx) {
        const leadId = str(args.leadId, 'leadId', 64);
        const lead = await ctx.container.leads.findById(leadId);
        if (!lead || lead.owner_admin_id !== ctx.actor.id) {
          throw new AppError('NOT_FOUND', 'Lead not found.');
        }
        const result = await tasks.createFromAutomation(
          ctx.actor,
          {
            title: str(args.title, 'title', 200),
            dueAt: typeof args.dueAt === 'number' ? args.dueAt : null,
            leadId,
            priority: args.priority as never,
          },
          'AI',
        );
        await ctx.container.leads.addActivity({
          leadId,
          type: 'FOLLOWUP',
          body: str(args.title, 'title', 200),
          actorType: 'AI',
          actorId: ctx.actor.id,
        });
        return result;
      },
    },
    {
      name: 'search_orders',
      description: 'Search orders for the current account.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
      async execute(args, ctx) {
        return ctx.container.db.many(
          `SELECT id, status, amount_cents, currency, created_at FROM orders
           WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
          ctx.actor.id,
          page(args.limit),
        );
      },
    },
    {
      name: 'search_wallets',
      description: 'List wallet balances for the current account.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: { type: 'object', properties: {} },
      async execute(_args, ctx) {
        return ctx.container.wallets.listForUser(ctx.actor.id);
      },
    },
    {
      name: 'search_campaigns',
      description: 'List WhatsApp campaigns for the current account.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN'],
      parameters: { type: 'object', properties: {} },
      async execute(_args, ctx) {
        return ctx.container.campaigns.list(ctx.actor.id);
      },
    },
    {
      name: 'campaign_analytics',
      description: 'Delivery statistics for a WhatsApp campaign.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN'],
      parameters: { type: 'object', properties: { campaignId: { type: 'string' } }, required: ['campaignId'] },
      async execute(args, ctx) {
        const campaignId = str(args.campaignId, 'campaignId', 64);
        const stats = await ctx.container.waMessages.stats(ctx.actor.id, campaignId);
        return { campaignId, stats };
      },
    },
    {
      name: 'search_documents',
      description: 'List documents owned by the current account.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN'],
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
      async execute(args, ctx) {
        return ctx.container.documents.list(ctx.actor.id, page(args.limit), 0);
      },
    },
    {
      name: 'search_invoices',
      description: 'List invoices for the current account.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
      async execute(args, ctx) {
        return ctx.container.invoices.listForUser(ctx.actor.id, page(args.limit), 0);
      },
    },
    {
      name: 'search_support',
      description: 'List support tickets for the current account.',
      sideEffect: 'READ',
      allowedRoles: ['ADMIN', 'SUPER_ADMIN', 'USER'],
      parameters: { type: 'object', properties: { limit: { type: 'number' } } },
      async execute(args, ctx) {
        return ctx.container.support.list({ userId: ctx.actor.id, limit: page(args.limit), offset: 0 });
      },
    },
  ];
}

/**
 * §29 authenticate → authorise → execute → audit.
 * This is the ONLY path through which the AI can touch data.
 */
export async function executeTool(
  tool: AiTool,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  if (!ctx.actor) throw new AppError('UNAUTHORIZED', 'Authentication required.');
  if (!tool.allowedRoles.includes(ctx.actor.role)) {
    await ctx.container.audit.record({
      actorId: ctx.actor.id,
      actorRole: ctx.actor.role,
      action: AUDIT_ACTIONS.AI_TOOL_ACTION,
      targetType: 'ai_tool',
      targetId: tool.name,
      ip: clientIp(ctx.req),
      userAgent: userAgentOf(ctx.req),
      requestId: ctx.req.get('requestId'),
      meta: { status: 'DENIED', reason: 'ROLE_NOT_ALLOWED', args },
    });
    throw new AppError('FORBIDDEN', `Your role may not use the ${tool.name} tool.`, {
      tool: tool.name,
    });
  }
  if (ctx.actor.role === 'DEMO_VIEWER') {
    throw new AppError('DEMO_READ_ONLY', 'Demo accounts cannot execute AI tool actions.');
  }

  const result = await tool.execute(args, ctx);

  await ctx.container.audit.record({
    actorId: ctx.actor.id,
    actorRole: ctx.actor.role,
    action: AUDIT_ACTIONS.AI_TOOL_ACTION,
    targetType: 'ai_tool',
    targetId: tool.name,
    ip: clientIp(ctx.req),
    userAgent: userAgentOf(ctx.req),
    requestId: ctx.req.get('requestId'),
    meta: { status: 'EXECUTED', sideEffect: tool.sideEffect, args },
  });

  return result;
}
