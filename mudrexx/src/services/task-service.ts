import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { clientIp, userAgentOf } from '../lib/http';
import { AUDIT_ACTIONS } from '../repositories/platform';
import type { UserRow } from '../types';
import type { TaskRow } from '../repositories/tasks';

export type DateFilter =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'custom';

export interface JoiningFilter {
  preset?: DateFilter;
  from?: string;
  to?: string;
}

/** §36 Joining-date filters, computed in UTC days for determinism. */
export function resolveRange(filter: JoiningFilter): { from: number; to: number } {
  const now = new Date();
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const day = 24 * 60 * 60 * 1000;

  if (filter.preset === 'custom') {
    const from = filter.from ? Date.parse(filter.from) : NaN;
    const to = filter.to ? Date.parse(filter.to) : NaN;
    if (Number.isNaN(from) || Number.isNaN(to)) {
      throw new AppError('VALIDATION_ERROR', 'A custom range requires valid from and to dates.');
    }
    if (from >= to) throw new AppError('VALIDATION_ERROR', '`from` must be earlier than `to`.');
    return { from, to };
  }

  switch (filter.preset) {
    case 'today':
      return { from: utcMidnight, to: utcMidnight + day };
    case 'yesterday':
      return { from: utcMidnight - day, to: utcMidnight };
    case 'this_week': {
      const dow = now.getUTCDay(); // 0=Sunday
      const start = utcMidnight - dow * day;
      return { from: start, to: start + 7 * day };
    }
    case 'last_week': {
      const dow = now.getUTCDay();
      const start = utcMidnight - dow * day;
      return { from: start - 7 * day, to: start };
    }
    case 'this_month':
      return {
        from: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
        to: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      };
    case 'last_month':
      return {
        from: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
        to: Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      };
    default:
      return { from: 0, to: Date.now() + day };
  }
}

/**
 * §34/§36/§37 Tasks.
 *
 * Bulk assignment is a two-step flow: `plan` shows exactly who would receive
 * the task and which ones already have it; `commit` only runs with an explicit
 * confirmation and skips duplicates rather than silently duplicating.
 */
export class TaskService {
  constructor(private readonly c: Container) {}

  private ownerFor(actor: UserRow): string {
    return actor.id;
  }

  async create(
    actor: UserRow,
    input: {
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
    },
    req: Context,
  ) {
    if (!input.title?.trim()) throw new AppError('VALIDATION_ERROR', 'A task title is required.');

    // §34 assignment may reference a user by id, name or phone.
    let assignedUserId = input.assignedUserId ?? null;
    if (!assignedUserId && input.assignedPhone) {
      const byPhone = await this.c.users.findByPhone(input.assignedPhone);
      assignedUserId = byPhone?.id ?? null;
    }
    if (!assignedUserId && input.assignedName) {
      const results = await this.c.users.search({
        q: input.assignedName,
        role: 'USER',
        limit: 1,
        offset: 0,
      });
      assignedUserId = results.rows[0]?.id ?? null;
    }

    const { task, created } = await this.c.tasks.create({
      ownerAdminId: this.ownerFor(actor),
      title: input.title.trim(),
      description: input.description,
      priority: input.priority,
      dueAt: input.dueAt ?? null,
      assignedUserId,
      assignedName: input.assignedName,
      assignedPhone: input.assignedPhone,
      category: input.category,
      status: input.status,
      source: input.source ?? 'MANUAL',
      tags: input.tags,
      notes: input.notes,
      createdBy: actor.id,
    });

    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'TASK_CREATED',
      targetType: 'task',
      targetId: task.id,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { created, source: task.source },
    });

    return { task, created };
  }

  /**
   * Pre-flight for bulk assignment: returns the candidate users and splits them
   * into "already assigned" vs "new assignments" so the UI can show counts and
   * allow deselection before anything is written (§36, §37).
   */
  async planBulkAssign(
    actor: UserRow,
    input: {
      title: string;
      dueAt?: number | null;
      priority?: TaskRow['priority'];
      category?: string;
      filter?: JoiningFilter;
      userIds?: string[];
    },
  ) {
    if (!input.title?.trim()) throw new AppError('VALIDATION_ERROR', 'A task title is required.');

    let candidates: Awaited<ReturnType<typeof this.c.users.search>>['rows'];
    if (input.userIds?.length) {
      candidates = [];
      for (const id of input.userIds) {
        const user = await this.c.users.findById(id);
        if (user && user.role === 'USER' && !user.is_demo) candidates.push(user);
      }
    } else {
      const { from, to } = resolveRange(input.filter ?? {});
      candidates = await this.c.users.listByJoiningRange(from, to, 'USER');
    }

    const dedupeKeys = candidates.map((u) =>
      dedupeKeyFor(input.title, u.id, input.dueAt ?? null),
    );
    const existing = await this.c.tasks.findExisting(this.ownerFor(actor), dedupeKeys);
    const existingByKey = new Map(existing.map((t) => [t.dedupe_key, t]));

    const alreadyAssigned: { userId: string; name: string; humanId: string; taskId: string }[] = [];
    const newAssignments: { userId: string; name: string; humanId: string; joinedAt: number }[] = [];

    for (const user of candidates) {
      const key = dedupeKeyFor(input.title, user.id, input.dueAt ?? null);
      const found = existingByKey.get(key);
      if (found) {
        alreadyAssigned.push({
          userId: user.id,
          name: user.full_name,
          humanId: user.human_id,
          taskId: found.id,
        });
      } else {
        newAssignments.push({
          userId: user.id,
          name: user.full_name,
          humanId: user.human_id,
          joinedAt: user.created_at,
        });
      }
    }

    return {
      title: input.title.trim(),
      totalCandidates: candidates.length,
      newCount: newAssignments.length,
      duplicateCount: alreadyAssigned.length,
      alreadyAssigned,
      newAssignments,
      requiresConfirmation: true,
    };
  }

  /** §36 requires explicit confirmation before bulk writes. */
  async commitBulkAssign(
    actor: UserRow,
    input: {
      title: string;
      description?: string;
      priority?: TaskRow['priority'];
      dueAt?: number | null;
      category?: string;
      userIds: string[];
      confirm: boolean;
    },
    req: Context,
  ) {
    if (!input.confirm) {
      throw new AppError('CONFIRMATION_REQUIRED', 'Bulk assignment requires confirmation.');
    }
    if (!input.userIds?.length) {
      throw new AppError('VALIDATION_ERROR', 'Select at least one user.');
    }

    const created: string[] = [];
    const skipped: { userId: string; reason: string }[] = [];

    for (const userId of input.userIds) {
      const user = await this.c.users.findById(userId);
      if (!user || user.role !== 'USER' || user.is_demo) {
        skipped.push({ userId, reason: 'NOT_ASSIGNABLE' });
        continue;
      }
      const { task, created: isNew } = await this.c.tasks.create({
        ownerAdminId: this.ownerFor(actor),
        title: input.title.trim(),
        description: input.description,
        priority: input.priority,
        dueAt: input.dueAt ?? null,
        assignedUserId: user.id,
        assignedName: user.full_name,
        category: input.category,
        source: 'MANUAL',
        createdBy: actor.id,
      });
      if (isNew) created.push(task.id);
      else skipped.push({ userId, reason: 'ALREADY_ASSIGNED' });
    }

    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'TASK_BULK_ASSIGNED',
      targetType: 'task',
      targetId: '',
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { requested: input.userIds.length, created: created.length, skipped },
    });

    return { created, skipped, createdCount: created.length, skippedCount: skipped.length };
  }

  async list(
    actor: UserRow,
    opts: {
      status?: TaskRow['status'] | 'ALL';
      assignedUserId?: string;
      source?: TaskRow['source'];
      q?: string;
      limit: number;
      offset: number;
    },
  ) {
    return this.c.tasks.list({ ownerAdminId: this.ownerFor(actor), ...opts });
  }

  async update(
    actor: UserRow,
    taskId: string,
    patch: Omit<Partial<TaskRow>, 'tags'> & { tags?: string[]; dueAt?: number | null },
    req: Context,
  ) {
    const task = await this.c.tasks.findById(taskId);
    if (!task || task.owner_admin_id !== this.ownerFor(actor)) {
      throw new AppError('NOT_FOUND', 'Task not found.');
    }
    const updated = await this.c.tasks.update(taskId, patch);
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'TASK_UPDATED',
      targetType: 'task',
      targetId: taskId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: patch,
    });
    return updated;
  }

  async remove(actor: UserRow, taskId: string, req: Context) {
    const task = await this.c.tasks.findById(taskId);
    if (!task || task.owner_admin_id !== this.ownerFor(actor)) {
      throw new AppError('NOT_FOUND', 'Task not found.');
    }
    await this.c.tasks.delete(taskId);
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: 'TASK_DELETED',
      targetType: 'task',
      targetId: taskId,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
    });
  }

  /** Used by the AI tool layer — always tagged with source AI (§34). */
  async createFromAutomation(
    actor: UserRow,
    input: { title: string; description?: string; dueAt?: number | null; leadId?: string; priority?: TaskRow['priority'] },
    source: 'AI' | 'AUTOMATION' | 'SYSTEM',
  ) {
    return this.c.tasks.create({
      ownerAdminId: this.ownerFor(actor),
      title: input.title,
      description: input.description,
      priority: input.priority ?? 'MEDIUM',
      dueAt: input.dueAt ?? null,
      source,
      createdBy: actor.id,
      dedupeKey: input.leadId
        ? `auto:${source}:${input.leadId}:${input.title.trim().toLowerCase()}`
        : undefined,
    });
  }

  async stats(actor: UserRow) {
    return this.c.tasks.countsByStatus(this.ownerFor(actor));
  }
}

function dedupeKeyFor(title: string, userId: string, dueAt: number | null): string {
  return [title.trim().toLowerCase(), userId, dueAt ?? 'none'].join('|');
}
