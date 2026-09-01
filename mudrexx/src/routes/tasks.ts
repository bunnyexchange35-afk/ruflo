import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { ok } from '../http/errors';
import { body, query, zId, zPagination } from '../middleware/validate';
import { demoReadOnly, requireAuth, requireRole, resolveSession } from '../middleware/auth';
import { TaskService } from '../services/task-service';

/** /api/tasks/* — §34/§36/§37 manual, AI, automation and system tasks. */
export const tasks = new Hono<AppEnv>();

// §39 demo may VIEW task lists; every mutation is blocked by demoReadOnly.
tasks.use('*', resolveSession, requireAuth, requireRole('ADMIN', 'SUPER_ADMIN', 'USER', 'DEMO_VIEWER'));

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
  dueAt: z.number().int().min(0).optional(),
  assignedUserId: z.string().max(64).optional(),
  // §34 assignment may reference a user by name or phone as well as id.
  assignedName: z.string().trim().max(200).optional(),
  assignedPhone: z.string().trim().max(40).optional(),
  category: z.string().trim().max(80).optional(),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
  source: z.enum(['MANUAL', 'AI', 'AUTOMATION', 'SYSTEM']).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  notes: z.string().max(5000).optional(),
});

tasks.get('/', async (c) => {
  const input = query(
    c,
    zPagination.merge(
      z.object({
        status: z.enum(['ALL', 'OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
        assignedUserId: z.string().max(64).optional(),
        source: z.enum(['MANUAL', 'AI', 'AUTOMATION', 'SYSTEM']).optional(),
        q: z.string().max(100).optional(),
      }),
    ),
  );
  const service = new TaskService(c.get('container'));
  return ok(c, await service.list(c.get('auth')!.user, input));
});

tasks.get('/stats', async (c) => {
  const service = new TaskService(c.get('container'));
  return ok(c, await service.stats(c.get('auth')!.user));
});

tasks.post('/', demoReadOnly, async (c) => {
  const input = await body(c, createSchema);
  const service = new TaskService(c.get('container'));
  return ok(c, await service.create(c.get('auth')!.user, input, c), 201);
});

/**
 * §36/§37 Pre-flight: shows how many users would receive the task and which of
 * them already have it, so the UI can show counts and allow deselection.
 */
tasks.post('/bulk/plan', async (c) => {
  const input = await body(
    c,
    z.object({
      title: z.string().trim().min(1).max(200),
      dueAt: z.number().int().min(0).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
      category: z.string().max(80).optional(),
      userIds: z.array(zId).max(5000).optional(),
      filter: z
        .object({
          preset: z
            .enum(['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'custom'])
            .optional(),
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .optional(),
    }),
  );
  const service = new TaskService(c.get('container'));
  return ok(c, await service.planBulkAssign(c.get('auth')!.user, input));
});

/** §36 bulk assignment requires explicit confirmation. */
tasks.post('/bulk/assign', demoReadOnly, async (c) => {
  const input = await body(
    c,
    z.object({
      title: z.string().trim().min(1).max(200),
      description: z.string().max(5000).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
      dueAt: z.number().int().min(0).optional(),
      category: z.string().max(80).optional(),
      userIds: z.array(zId).min(1).max(5000),
      confirm: z.boolean(),
    }),
  );
  const service = new TaskService(c.get('container'));
  return ok(c, await service.commitBulkAssign(c.get('auth')!.user, input, c));
});

tasks.patch('/:id', demoReadOnly, async (c) => {
  const input = await body(
    c,
    z.object({
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().max(5000).optional(),
      priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
      status: z.enum(['OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED']).optional(),
      dueAt: z.number().int().min(0).optional(),
      category: z.string().max(80).optional(),
      notes: z.string().max(5000).optional(),
      tags: z.array(z.string().max(40)).max(20).optional(),
    }),
  );
  const service = new TaskService(c.get('container'));
  return ok(c, await service.update(c.get('auth')!.user, c.req.param('id'), input, c));
});

tasks.delete('/:id', demoReadOnly, async (c) => {
  const service = new TaskService(c.get('container'));
  await service.remove(c.get('auth')!.user, c.req.param('id'), c);
  return ok(c, { deleted: true });
});
