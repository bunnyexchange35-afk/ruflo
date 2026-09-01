import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { ok } from '../http/errors';
import { body, query, zId, zPagination } from '../middleware/validate';
import { demoReadOnly, requireAuth, requireRole, resolveSession } from '../middleware/auth';
import { rateLimit } from '../middleware/rate-limit';
import { RATE_LIMITS } from '../config';
import { WhatsAppService } from '../services/whatsapp/service';

/**
 * /api/whatsapp/* — §31 contacts, lists, templates, campaigns, bulk messaging,
 * message logs, analytics. Delivery status comes from the provider only.
 */
export const whatsapp = new Hono<AppEnv>();

// §39 demo may VIEW campaigns and logs; sending is blocked by demoReadOnly.
whatsapp.use('*', resolveSession, requireAuth, requireRole('ADMIN', 'SUPER_ADMIN', 'DEMO_VIEWER'));

whatsapp.get('/templates', async (c) => {
  const service = new WhatsAppService(c.get('container'));
  return ok(c, await service.listTemplates(c.get('auth')!.user));
});

whatsapp.post('/templates', demoReadOnly, async (c) => {
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(120),
      body: z.string().min(1).max(2000),
      language: z.string().trim().max(10).optional(),
      variables: z.array(z.string().max(40)).max(20).optional(),
    }),
  );
  const service = new WhatsAppService(c.get('container'));
  return ok(c, await service.createTemplate(c.get('auth')!.user, input, c), 201);
});

whatsapp.get('/campaigns', async (c) => {
  const service = new WhatsAppService(c.get('container'));
  return ok(c, await service.listCampaigns(c.get('auth')!.user));
});

whatsapp.post('/campaigns', demoReadOnly, async (c) => {
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(120),
      templateId: zId.optional(),
      listId: zId.optional(),
      rateLimitPerMin: z.number().int().min(1).max(1000).optional(),
    }),
  );
  const service = new WhatsAppService(c.get('container'));
  return ok(c, await service.createCampaign(c.get('auth')!.user, input, c), 201);
});

/** Queue eligible (opted-in) contacts, bounded by package quota and rate limit. */
whatsapp.post('/campaigns/:id/queue', demoReadOnly, async (c) => {
  const service = new WhatsAppService(c.get('container'));
  return ok(c, await service.queueCampaign(c.get('auth')!.user, c.req.param('id'), c));
});

/** Real send. Fails loudly if the provider is not configured. */
whatsapp.post(
  '/campaigns/:id/send',
  demoReadOnly,
  rateLimit({ bucket: 'bulk_message', ...RATE_LIMITS.BULK_MESSAGE }),
  async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const service = new WhatsAppService(c.get('container'));
    return ok(
      c,
      await service.sendBatch(
        c.get('auth')!.user,
        c.req.param('id'),
        Math.min(Math.max(limit, 1), 100),
        c,
      ),
    );
  },
);

whatsapp.post('/messages', demoReadOnly, async (c) => {
  const input = await body(
    c,
    z.object({ to: z.string().trim().min(3).max(40), body: z.string().min(1).max(2000) }),
  );
  const service = new WhatsAppService(c.get('container'));
  return ok(c, await service.sendSingle(c.get('auth')!.user, input, c), 201);
});

whatsapp.get('/messages', async (c) => {
  const input = query(
    c,
    zPagination.merge(
      z.object({
        campaignId: z.string().max(64).optional(),
        status: z
          .enum(['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'REJECTED'])
          .optional(),
      }),
    ),
  );
  const service = new WhatsAppService(c.get('container'));
  return ok(c, await service.messages(c.get('auth')!.user, input));
});

whatsapp.get('/analytics', async (c) => {
  const campaignId = c.req.query('campaignId');
  const service = new WhatsAppService(c.get('container'));
  return ok(c, await service.analytics(c.get('auth')!.user, campaignId));
});

whatsapp.get('/providers', async (c) => {
  const service = new WhatsAppService(c.get('container'));
  return ok(c, service.status());
});
