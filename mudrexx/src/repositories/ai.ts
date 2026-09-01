import { Db } from '../db/client';
import { newId } from '../lib/crypto';

export interface ConversationRow {
  id: string;
  user_id: string;
  role: string;
  title: string;
  model: string;
  skill_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | 'TOOL';
  content: string;
  provider: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  created_at: number;
}

export interface ToolCallRow {
  id: string;
  conversation_id: string | null;
  actor_user_id: string;
  tool: string;
  args_json: string;
  result_json: string | null;
  side_effect: 'READ' | 'WRITE';
  status: 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'FAILED' | 'DENIED';
  requires_confirmation: number;
  denial_reason: string | null;
  created_at: number;
  decided_at: number | null;
}

export interface SkillRow {
  code: string;
  name: string;
  category: string;
  description: string;
  system_prompt: string;
  tools_json: string;
  is_active: number;
  created_at: number;
}

export class ConversationRepository {
  constructor(private readonly db: Db) {}

  async create(input: {
    userId: string;
    role: string;
    title?: string;
    model?: string;
    skillCode?: string | null;
  }): Promise<ConversationRow> {
    const now = Date.now();
    const id = newId('cnv');
    await this.db.run(
      `INSERT INTO ai_conversations (id, user_id, role, title, model, skill_code, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.userId,
      input.role,
      input.title ?? '',
      input.model ?? '',
      input.skillCode ?? null,
      now,
      now,
    );
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<ConversationRow | null> {
    return this.db.one<ConversationRow>(`SELECT * FROM ai_conversations WHERE id = ?`, id);
  }

  async listForUser(userId: string, limit = 50, offset = 0): Promise<ConversationRow[]> {
    return this.db.many<ConversationRow>(
      `SELECT * FROM ai_conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      userId,
      limit,
      offset,
    );
  }

  async touch(id: string): Promise<void> {
    await this.db.run(
      `UPDATE ai_conversations SET updated_at = ? WHERE id = ?`,
      Date.now(),
      id,
    );
  }

  async setSkill(id: string, skillCode: string | null): Promise<void> {
    await this.db.run(
      `UPDATE ai_conversations SET skill_code = ?, updated_at = ? WHERE id = ?`,
      skillCode,
      Date.now(),
      id,
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM ai_conversations WHERE id = ?`, id);
  }
}

export class MessageRepository {
  constructor(private readonly db: Db) {}

  async add(input: {
    conversationId: string;
    role: MessageRow['role'];
    content: string;
    provider?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
  }): Promise<MessageRow> {
    const id = newId('aim');
    await this.db.run(
      `INSERT INTO ai_messages (id, conversation_id, role, content, provider, model, tokens_in,
        tokens_out, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.conversationId,
      input.role,
      input.content,
      input.provider ?? '',
      input.model ?? '',
      input.tokensIn ?? 0,
      input.tokensOut ?? 0,
      Date.now(),
    );
    return (await this.db.one<MessageRow>(`SELECT * FROM ai_messages WHERE id = ?`, id))!;
  }

  async list(conversationId: string, limit = 100): Promise<MessageRow[]> {
    return this.db.many<MessageRow>(
      `SELECT * FROM ai_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?`,
      conversationId,
      limit,
    );
  }
}

export class ToolCallRepository {
  constructor(private readonly db: Db) {}

  /** §30 write tools start as PROPOSED and only run after explicit approval. */
  async propose(input: {
    conversationId: string | null;
    actorUserId: string;
    tool: string;
    args: unknown;
    sideEffect: 'READ' | 'WRITE';
    requiresConfirmation: boolean;
  }): Promise<ToolCallRow> {
    const id = newId('ait');
    await this.db.run(
      `INSERT INTO ai_tool_calls (id, conversation_id, actor_user_id, tool, args_json, side_effect,
        status, requires_confirmation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PROPOSED', ?, ?)`,
      id,
      input.conversationId,
      input.actorUserId,
      input.tool,
      JSON.stringify(input.args ?? {}),
      input.sideEffect,
      input.requiresConfirmation ? 1 : 0,
      Date.now(),
    );
    return (await this.db.one<ToolCallRow>(`SELECT * FROM ai_tool_calls WHERE id = ?`, id))!;
  }

  async findById(id: string): Promise<ToolCallRow | null> {
    return this.db.one<ToolCallRow>(`SELECT * FROM ai_tool_calls WHERE id = ?`, id);
  }

  async mark(input: {
    id: string;
    status: ToolCallRow['status'];
    result?: unknown;
    denialReason?: string | null;
  }): Promise<void> {
    await this.db.run(
      `UPDATE ai_tool_calls SET status = ?, result_json = COALESCE(?, result_json),
        denial_reason = ?, decided_at = ?
       WHERE id = ?`,
      input.status,
      input.result !== undefined ? JSON.stringify(input.result) : null,
      input.denialReason ?? null,
      Date.now(),
      input.id,
    );
  }

  async pendingForActor(actorUserId: string, limit = 50): Promise<ToolCallRow[]> {
    return this.db.many<ToolCallRow>(
      `SELECT * FROM ai_tool_calls WHERE actor_user_id = ? AND status = 'PROPOSED'
       ORDER BY created_at DESC LIMIT ?`,
      actorUserId,
      limit,
    );
  }

  async list(opts: { actorUserId?: string; status?: ToolCallRow['status']; limit: number; offset: number }) {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.actorUserId) {
      clauses.push('actor_user_id = ?');
      params.push(opts.actorUserId);
    }
    if (opts.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.many<ToolCallRow>(
      `SELECT * FROM ai_tool_calls ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
  }
}

export class UsageRepository {
  constructor(private readonly db: Db) {}

  async record(input: {
    userId: string;
    provider: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    costMicros: number;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO ai_usage (id, user_id, provider, model, tokens_in, tokens_out, cost_micros, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('usu'),
      input.userId,
      input.provider,
      input.model,
      input.tokensIn,
      input.tokensOut,
      input.costMicros,
      Date.now(),
    );
  }

  async totalsForUser(userId: string, sinceMs: number) {
    const row = await this.db.one<{ tokens_in: number; tokens_out: number; cost_micros: number; calls: number }>(
      `SELECT COALESCE(SUM(tokens_in),0) AS tokens_in, COALESCE(SUM(tokens_out),0) AS tokens_out,
        COALESCE(SUM(cost_micros),0) AS cost_micros, COUNT(*) AS calls
       FROM ai_usage WHERE user_id = ? AND created_at >= ?`,
      userId,
      sinceMs,
    );
    return row ?? { tokens_in: 0, tokens_out: 0, cost_micros: 0, calls: 0 };
  }
}

export class SkillRepository {
  constructor(private readonly db: Db) {}

  async upsert(input: {
    code: string;
    name: string;
    category: string;
    description: string;
    systemPrompt: string;
    tools: string[];
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO ai_skills (code, name, category, description, system_prompt, tools_json, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(code) DO UPDATE SET name = excluded.name, category = excluded.category,
         description = excluded.description, system_prompt = excluded.system_prompt,
         tools_json = excluded.tools_json`,
      input.code,
      input.name,
      input.category,
      input.description,
      input.systemPrompt,
      JSON.stringify(input.tools),
      Date.now(),
    );
  }

  async list(activeOnly = true): Promise<SkillRow[]> {
    return this.db.many<SkillRow>(
      `SELECT * FROM ai_skills ${activeOnly ? 'WHERE is_active = 1' : ''} ORDER BY category, name`,
    );
  }

  async findByCode(code: string): Promise<SkillRow | null> {
    return this.db.one<SkillRow>(`SELECT * FROM ai_skills WHERE code = ?`, code);
  }
}
