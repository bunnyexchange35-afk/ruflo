import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { ok } from '../http/errors';
import { body, query, zId, zPagination } from '../middleware/validate';
import { demoReadOnly, requireAuth, requireRole, resolveSession } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { RATE_LIMITS } from '../config';
import { AiService } from '../services/ai/orchestrator';
import { seedSkills } from '../services/ai/skills';

/**
 * /api/ai/* — §25-§30 AI platform.
 * Real LLM calls only; write actions stop for explicit confirmation (§30).
 */
export const ai = new Hono<AppEnv>();

ai.use('*', resolveSession, requireAuth, requireRole('ADMIN', 'SUPER_ADMIN', 'USER', 'DEMO_VIEWER'));

ai.get('/providers', async (c) => {
  const service = new AiService(c.get('container'));
  return ok(c, service.providerStatus());
});

ai.get('/skills', async (c) => {
  const service = new AiService(c.get('container'));
  return ok(c, await service.skills());
});

/** Admin-only bootstrap that loads the skill catalogue into the database. */
ai.post('/skills/seed', requireRole('SUPER_ADMIN'), demoReadOnly, async (c) => {
  const count = await seedSkills(c.get('container'));
  return ok(c, { seeded: count });
});

ai.get('/conversations', async (c) => {
  const service = new AiService(c.get('container'));
  return ok(c, await service.conversations(c.get('auth')!.user));
});

ai.post('/conversations', demoReadOnly, async (c) => {
  const input = await body(
    c,
    z.object({
      title: z.string().max(160).optional(),
      skillCode: z.string().max(60).optional(),
    }),
  );
  const conversation = await c.get('container').conversations.create({
    userId: c.get('auth')!.user.id,
    role: c.get('auth')!.user.role,
    title: input.title ?? '',
    skillCode: input.skillCode ?? null,
  });
  return ok(c, conversation, 201);
});

ai.get('/conversations/:id/messages', async (c) => {
  const service = new AiService(c.get('container'));
  return ok(c, await service.messages(c.get('auth')!.user, c.req.param('id')));
});

const chatSchema = z.object({
  conversationId: z.string().max(64).optional(),
  message: z.string().min(1).max(8000),
  skillCode: z.string().max(60).optional(),
  model: z.string().max(80).optional(),
});

ai.post('/chat', rateLimit({ bucket: 'ai', ...RATE_LIMITS.AI_CHAT }), async (c) => {
  const input = await body(c, chatSchema);
  const service = new AiService(c.get('container'));
  return ok(c, await service.chat(c.get('auth')!.user, input, c));
});

/** §27 streaming. */
ai.post('/chat/stream', rateLimit({ bucket: 'ai', ...RATE_LIMITS.AI_CHAT }), async (c) => {
  const input = await body(c, chatSchema);
  const service = new AiService(c.get('container'));
  const stream = service.stream(c.get('auth')!.user, input);

  const encoder = new TextEncoder();
  const body$ = new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (err) {
        controller.enqueue(encoder.encode(`\n[error] ${(err as Error).message}`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(body$, {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-request-id': c.get('requestId'),
    },
  });
});

/** §30 actions awaiting explicit approval. */
ai.get('/actions', async (c) => {
  const service = new AiService(c.get('container'));
  return ok(c, await service.pendingActions(c.get('auth')!.user));
});

ai.post('/actions/:id/approve', demoReadOnly, async (c) => {
  const service = new AiService(c.get('container'));
  return ok(c, await service.resolveAction(c.get('auth')!.user, c.req.param('id'), true, c));
});

ai.post('/actions/:id/reject', async (c) => {
  const service = new AiService(c.get('container'));
  return ok(c, await service.resolveAction(c.get('auth')!.user, c.req.param('id'), false, c));
});

ai.get('/usage', async (c) => {
  const since = Number(c.req.query('since') ?? Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const usage = await c.get('container').aiUsage.totalsForUser(c.get('auth')!.user.id, since);
  return ok(c, usage);
});

ai.get('/tool-calls', async (c) => {
  const { limit, offset } = query(c, zPagination);
  return ok(
    c,
    await c.get('container').toolCalls.list({
      actorUserId: c.get('auth')!.user.id,
      limit,
      offset,
    }),
  );
});

ai.get('/tool-calls/:id', async (c) => {
  const id = zId.parse(c.req.param('id'));
  const call = await c.get('container').toolCalls.findById(id);
  if (!call || call.actor_user_id !== c.get('auth')!.user.id) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Tool call not found.' } }, 404);
  }
  return ok(c, call);
});
