import { Db } from '../db/client';
import { newId } from '../lib/crypto';

export interface TaskRow {
  id: string;
  owner_admin_id: string;
  title: string;
  description: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  due_at: number | null;
  assigned_user_id: string | null;
  assigned_name: string;
  assigned_phone: string;
  category: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED';
  source: 'MANUAL' | 'AI' | 'AUTOMATION' | 'SYSTEM';
  tags: string;
  notes: string;
  dedupe_key: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const TASK_COLUMNS = `id, owner_admin_id, title, description, priority, due_at, assigned_user_id,
  assigned_name, assigned_phone, category, status, source, tags, notes, dedupe_key, created_by,
  created_at, updated_at`;

export class TaskRepository {
  constructor(private readonly db: Db) {}

  /**
   * §37 duplicate protection. `dedupeKey` is UNIQUE per owner: inserting an
   * identical assignment is a no-op rather than a silent duplicate.
   */
  async create(input: {
    ownerAdminId: string;
    title: string;
    description?: string;
    priority?: TaskRow['priority'];
    dueAt?: number | null;
    assignedUserId?: string | null;
    assignedName?: string;
    assignedPhone?: string;
    category?: string;
    status?: TaskRow['status'];
    source?: TaskRow['source'];
    tags?: string[];
    notes?: string;
    createdBy?: string | null;
    dedupeKey?: string;
  }): Promise<{ task: TaskRow; created: boolean }> {
    const dedupeKey =
      input.dedupeKey ||
      [
        input.title.trim().toLowerCase(),
        input.assignedUserId ?? `name:${(input.assignedName ?? '').trim().toLowerCase()}`,
        input.dueAt ?? 'none',
      ].join('|');

    const existing = await this.db.one<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE owner_admin_id = ? AND dedupe_key = ?`,
      input.ownerAdminId,
      dedupeKey,
    );
    if (existing) return { task: existing, created: false };

    const now = Date.now();
    const id = newId('tsk');
    await this.db.run(
      `INSERT INTO tasks (id, owner_admin_id, title, description, priority, due_at,
        assigned_user_id, assigned_name, assigned_phone, category, status, source, tags, notes,
        dedupe_key, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.ownerAdminId,
      input.title,
      input.description ?? '',
      input.priority ?? 'MEDIUM',
      input.dueAt ?? null,
      input.assignedUserId ?? null,
      input.assignedName ?? '',
      input.assignedPhone ?? '',
      input.category ?? '',
      input.status ?? 'OPEN',
      input.source ?? 'MANUAL',
      JSON.stringify(input.tags ?? []),
      input.notes ?? '',
      dedupeKey,
      input.createdBy ?? null,
      now,
      now,
    );
    const task = (await this.db.one<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`,
      id,
    ))!;
    return { task, created: true };
  }

  /** Pre-flight check: which of these dedupe keys already exist (§37 UI feedback). */
  async findExisting(ownerAdminId: string, dedupeKeys: string[]): Promise<TaskRow[]> {
    if (!dedupeKeys.length) return [];
    const placeholders = dedupeKeys.map(() => '?').join(', ');
    return this.db.many<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks
       WHERE owner_admin_id = ? AND dedupe_key IN (${placeholders})`,
      ownerAdminId,
      ...dedupeKeys,
    );
  }

  async findById(id: string): Promise<TaskRow | null> {
    return this.db.one<TaskRow>(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`, id);
  }

  async list(opts: {
    ownerAdminId: string;
    status?: TaskRow['status'] | 'ALL';
    assignedUserId?: string;
    source?: TaskRow['source'];
    q?: string;
    dueBefore?: number;
    limit: number;
    offset: number;
  }): Promise<{ rows: TaskRow[]; total: number }> {
    const clauses = ['owner_admin_id = ?'];
    const params: unknown[] = [opts.ownerAdminId];

    if (opts.status && opts.status !== 'ALL') {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts.assignedUserId) {
      clauses.push('assigned_user_id = ?');
      params.push(opts.assignedUserId);
    }
    if (opts.source) {
      clauses.push('source = ?');
      params.push(opts.source);
    }
    if (opts.q) {
      clauses.push(`(lower(title) LIKE ? OR lower(assigned_name) LIKE ? OR assigned_phone LIKE ?)`);
      const like = `%${opts.q.toLowerCase()}%`;
      params.push(like, like, like);
    }
    if (opts.dueBefore) {
      clauses.push('due_at IS NOT NULL AND due_at <= ?');
      params.push(opts.dueBefore);
    }

    const where = `WHERE ${clauses.join(' AND ')}`;
    const rows = await this.db.many<TaskRow>(
      `SELECT ${TASK_COLUMNS} FROM tasks ${where}
       ORDER BY COALESCE(due_at, 4102444800000) ASC, created_at DESC LIMIT ? OFFSET ?`,
      ...params,
      opts.limit,
      opts.offset,
    );
    const total = await this.db.count(`SELECT COUNT(*) AS c FROM tasks ${where}`, ...params);
    return { rows, total };
  }

  async update(
    id: string,
    patch: Omit<Partial<TaskRow>, 'tags'> & { tags?: string[] },
  ): Promise<TaskRow | null> {
    const clean: Record<string, unknown> = { ...patch } as Record<string, unknown>;
    if (Array.isArray(patch.tags)) clean.tags = JSON.stringify(patch.tags);
    const keys = Object.keys(clean).filter((k) => !['id', 'created_at'].includes(k));
    if (!keys.length) return this.findById(id);
    const assignments = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => clean[k]);
    await this.db.run(
      `UPDATE tasks SET ${assignments}, updated_at = ? WHERE id = ?`,
      ...values,
      Date.now(),
      id,
    );
    return this.findById(id);
  }

  async delete(id: string): Promise<void> {
    await this.db.run(`DELETE FROM tasks WHERE id = ?`, id);
  }

  async countsByStatus(ownerAdminId: string): Promise<Record<string, number>> {
    const rows = await this.db.many<{ status: string; c: number }>(
      `SELECT status, COUNT(*) AS c FROM tasks WHERE owner_admin_id = ? GROUP BY status`,
      ownerAdminId,
    );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = Number(r.c);
    return out;
  }
}
