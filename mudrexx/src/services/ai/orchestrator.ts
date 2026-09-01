import type { Context } from 'hono';
import type { Container } from '../../container';
import { AppError } from '../../http/errors';
import { clientIp, userAgentOf } from '../../lib/http';
import { AUDIT_ACTIONS } from '../../repositories/platform';
import type { UserRow } from '../../types';
import { PackageService } from '../package-service';
import { LlmRouter, type LlmMessage, type LlmToolSpec } from './provider';
import { buildTools, executeTool, type AiTool, type ToolContext } from './tools';

const MAX_TOOL_ITERATIONS = 4;
const HISTORY_LIMIT = 20;

export interface ChatInput {
  conversationId?: string;
  message: string;
  skillCode?: string;
  model?: string;
}

export interface ChatResult {
  conversationId: string;
  content: string;
  provider: string;
  model: string;
  usage: { tokensIn: number; tokensOut: number };
  pendingActions: {
    id: string;
    tool: string;
    args: unknown;
    requiresConfirmation: boolean;
  }[];
  executedTools: { tool: string; sideEffect: string }[];
}

/**
 * §25/§26/§30 AI orchestrator.
 *
 * - The caller's own role governs every tool.
 * - READ tools run immediately.
 * - WRITE tools never run inline: they are stored as PROPOSED actions and only
 *   execute after the user explicitly approves them.
 */
export class AiService {
  private readonly router: LlmRouter;
  private readonly tools: AiTool[];
  private readonly packages: PackageService;

  constructor(private readonly c: Container) {
    this.router = new LlmRouter(c.env);
    this.tools = buildTools(c);
    this.packages = new PackageService(c);
  }

  providerStatus() {
    return this.router.available();
  }

  private allowedTools(actor: UserRow): AiTool[] {
    return this.tools.filter((t) => t.allowedRoles.includes(actor.role));
  }

  private specsFor(actor: UserRow): LlmToolSpec[] {
    return this.allowedTools(actor).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async chat(actor: UserRow, input: ChatInput, req: Context): Promise<ChatResult> {
    if (actor.role === 'DEMO_VIEWER') {
      // §39 demo may view the interface but must not spend real AI quota.
      return {
        conversationId: input.conversationId ?? '',
        content:
          'Demo mode is read-only. Connect a configured LLM provider to run live AI responses.',
        provider: 'demo',
        model: 'none',
        usage: { tokensIn: 0, tokensOut: 0 },
        pendingActions: [],
        executedTools: [],
      };
    }

    // Platform capability first: with no provider key configured the request
    // fails closed (503) instead of reporting a quota problem.
    const configured = this.router.available().filter((p) => p.configured);
    if (!configured.length) {
      throw new AppError(
        'PROVIDER_NOT_CONFIGURED',
        'No LLM provider is configured. Set a provider API key as a Worker secret.',
        { providers: this.router.available() },
      );
    }

    // §15 server-side AI quota enforcement.
    const limits = await this.packages.limitsFor(actor);
    const since = startOfMonth();
    const used = await this.c.aiUsage.totalsForUser(actor.id, since);
    const usedTokens = Number(used.tokens_in) + Number(used.tokens_out);
    if (usedTokens >= limits.aiUsage) {
      throw new AppError('FORBIDDEN', 'AI usage limit for this package has been reached.', {
        code: 'PACKAGE_LIMIT_REACHED',
        resource: 'aiUsage',
        currentUsage: usedTokens,
        max: limits.aiUsage,
      });
    }

    const conversation = input.conversationId
      ? await this.c.conversations.findById(input.conversationId)
      : null;

    const conv =
      conversation && conversation.user_id === actor.id
        ? conversation
        : await this.c.conversations.create({
            userId: actor.id,
            role: actor.role,
            title: input.message.slice(0, 80),
            skillCode: input.skillCode ?? null,
          });

    if (input.skillCode) await this.c.conversations.setSkill(conv.id, input.skillCode);

    const skill = conv.skill_code ? await this.c.skills.findByCode(conv.skill_code) : null;
    const systemPrompt =
      skill?.system_prompt ??
      'You are the MUDREXX AI assistant. Be accurate, concise, and never invent data.';

    const history = await this.c.aiMessages.list(conv.id, HISTORY_LIMIT);
    const messages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({ role: m.role.toLowerCase() as LlmMessage['role'], content: m.content })),
      { role: 'user', content: input.message },
    ];

    await this.c.aiMessages.add({ conversationId: conv.id, role: 'USER', content: input.message });

    const ctx: ToolContext = { actor, container: this.c, req };
    const registry = new Map(this.tools.map((t) => [t.name, t]));
    const pendingActions: ChatResult['pendingActions'] = [];
    const executedTools: ChatResult['executedTools'] = [];

    let finalContent = '';
    let provider = '';
    let model = '';
    let tokensIn = 0;
    let tokensOut = 0;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const response = await this.router.chat({
        messages,
        model: input.model,
        tools: this.specsFor(actor),
      });

      provider = response.provider;
      model = response.model;
      tokensIn += response.tokensIn;
      tokensOut += response.tokensOut;

      if (!response.toolCalls.length) {
        finalContent = response.content;
        break;
      }

      for (const call of response.toolCalls) {
        const tool = registry.get(call.name);
        if (!tool) {
          messages.push({
            role: 'tool',
            content: JSON.stringify({ error: `Unknown tool ${call.name}` }),
          });
          continue;
        }

        if (tool.sideEffect === 'WRITE') {
          // §30 sensitive writes stop here and wait for explicit approval.
          const proposal = await this.c.toolCalls.propose({
            conversationId: conv.id,
            actorUserId: actor.id,
            tool: tool.name,
            args: call.args,
            sideEffect: 'WRITE',
            requiresConfirmation: true,
          });
          pendingActions.push({
            id: proposal.id,
            tool: tool.name,
            args: call.args,
            requiresConfirmation: true,
          });
        } else {
          try {
            const result = await executeTool(tool, call.args, ctx);
            executedTools.push({ tool: tool.name, sideEffect: 'READ' });
            messages.push({
              role: 'tool',
              content: JSON.stringify({ tool: tool.name, result }).slice(0, 8000),
            });
          } catch (err) {
            messages.push({
              role: 'tool',
              content: JSON.stringify({
                tool: tool.name,
                error: (err as Error).message,
              }),
            });
          }
        }
      }

      if (pendingActions.length) {
        finalContent =
          response.content ||
          `I can take ${pendingActions.length} action(s) that modify data. Review and approve them to continue.`;
        break;
      }
    }

    await this.c.aiMessages.add({
      conversationId: conv.id,
      role: 'ASSISTANT',
      content: finalContent,
      provider,
      model,
      tokensIn,
      tokensOut,
    });
    await this.c.conversations.touch(conv.id);
    await this.c.aiUsage.record({
      userId: actor.id,
      provider,
      model,
      tokensIn,
      tokensOut,
      costMicros: 0,
    });
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.AI_CHAT,
      targetType: 'ai_conversation',
      targetId: conv.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { provider, model, tokensIn, tokensOut, pending: pendingActions.length, skill: conv.skill_code },
    });

    return {
      conversationId: conv.id,
      content: finalContent,
      provider,
      model,
      usage: { tokensIn, tokensOut },
      pendingActions,
      executedTools,
    };
  }

  /** §30 approve/reject a proposed write action. */
  async resolveAction(
    actor: UserRow,
    toolCallId: string,
    approve: boolean,
    req: Context,
  ): Promise<{ status: string; result?: unknown }> {
    const call = await this.c.toolCalls.findById(toolCallId);
    if (!call) throw new AppError('NOT_FOUND', 'Proposed action not found.');
    if (call.actor_user_id !== actor.id) {
      throw new AppError('FORBIDDEN', 'You may only resolve actions you requested.');
    }
    if (call.status !== 'PROPOSED') {
      throw new AppError('CONFLICT', `This action was already ${call.status}.`);
    }

    if (!approve) {
      await this.c.toolCalls.mark({
        id: toolCallId,
        status: 'REJECTED',
        denialReason: 'USER_CANCELLED',
      });
      await this.c.audit.record({
        actorId: actor.id,
        actorRole: actor.role,
        action: AUDIT_ACTIONS.AI_TOOL_ACTION,
        targetType: 'ai_tool',
        targetId: call.tool,
        ip: clientIp(req),
        userAgent: userAgentOf(req),
        requestId: req.get('requestId'),
        meta: { status: 'REJECTED' },
      });
      return { status: 'REJECTED' };
    }

    const tool = this.tools.find((t) => t.name === call.tool);
    if (!tool) {
      await this.c.toolCalls.mark({ id: toolCallId, status: 'FAILED', denialReason: 'UNKNOWN_TOOL' });
      throw new AppError('NOT_FOUND', 'Unknown tool.');
    }

    try {
      const args = JSON.parse(call.args_json) as Record<string, unknown>;
      const result = await executeTool(tool, args, { actor, container: this.c, req });
      await this.c.toolCalls.mark({ id: toolCallId, status: 'EXECUTED', result });
      return { status: 'EXECUTED', result };
    } catch (err) {
      await this.c.toolCalls.mark({
        id: toolCallId,
        status: 'FAILED',
        denialReason: (err as Error).message,
      });
      throw err;
    }
  }

  async pendingActions(actor: UserRow) {
    return this.c.toolCalls.pendingForActor(actor.id);
  }

  async conversations(actor: UserRow) {
    return this.c.conversations.listForUser(actor.id);
  }

  async messages(actor: UserRow, conversationId: string) {
    const conv = await this.c.conversations.findById(conversationId);
    if (!conv || conv.user_id !== actor.id) throw new AppError('NOT_FOUND', 'Conversation not found.');
    return this.c.aiMessages.list(conversationId);
  }

  async skills() {
    return this.c.skills.list();
  }

  /** §27 streaming endpoint support. */
  async *stream(actor: UserRow, input: ChatInput): AsyncGenerator<string> {
    const history = input.conversationId
      ? await this.c.aiMessages.list(input.conversationId, HISTORY_LIMIT)
      : [];
    const messages: LlmMessage[] = [
      { role: 'system', content: 'You are the MUDREXX AI assistant. Be accurate and concise.' },
      ...history.map((m) => ({ role: m.role.toLowerCase() as LlmMessage['role'], content: m.content })),
      { role: 'user', content: input.message },
    ];
    let full = '';
    for await (const chunk of this.router.stream({ messages, model: input.model })) {
      if (chunk.delta) {
        full += chunk.delta;
        yield chunk.delta;
      }
    }
    if (input.conversationId) {
      await this.c.aiMessages.add({
        conversationId: input.conversationId,
        role: 'ASSISTANT',
        content: full,
      });
      await this.c.conversations.touch(input.conversationId);
    }
  }
}

function startOfMonth(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}
