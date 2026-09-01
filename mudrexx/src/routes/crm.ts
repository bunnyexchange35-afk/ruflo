import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { ok } from '../http/errors';
import { body, query, zId, zPagination } from '../middleware/validate';
import { demoReadOnly, requireAuth, requireRole, resolveSession } from '../middleware/auth';
import { CrmService } from '../services/crm-service';
import { RoutingService } from '../services/routing-service';

/**
 * /api/crm/* — the MASTER LEAD CONTROLLER (§24).
 * Every lead source funnels through here into one canonical Lead record.
 */
export const crm = new Hono<AppEnv>();

// §39 demo may VIEW CRM; writes are blocked by demoReadOnly on the write router.
crm.use('*', resolveSession, requireAuth, requireRole('ADMIN', 'SUPER_ADMIN', 'USER', 'DEMO_VIEWER'));

/* --------------------------------- reads --------------------------------- */

const readRoutes = new Hono<AppEnv>();

readRoutes.get('/dashboard', async (c) => {
  const service = new CrmService(c.get('container'));
  return ok(c, await service.dashboard(c.get('auth')!.user));
});

readRoutes.get('/contacts', async (c) => {
  const input = query(c, zPagination.merge(z.object({ q: z.string().max(100).optional() })));
  const service = new CrmService(c.get('container'));
  return ok(c, await service.listContacts(c.get('auth')!.user, input));
});

readRoutes.get('/lists', async (c) => {
  const service = new CrmService(c.get('container'));
  return ok(c, await service.listLists(c.get('auth')!.user));
});

readRoutes.get('/lists/:id/members', async (c) => {
  const service = new CrmService(c.get('container'));
  return ok(c, await service.listMembers(c.get('auth')!.user, c.req.param('id')));
});

readRoutes.get('/leads', async (c) => {
  const input = query(
    c,
    zPagination.merge(
      z.object({
        q: z.string().max(100).optional(),
        stage: z.string().max(40).optional(),
        source: z.string().max(40).optional(),
        minScore: z.coerce.number().int().min(0).max(100).optional(),
        assignedTo: z.string().max(64).optional(),
      }),
    ),
  );
  const service = new CrmService(c.get('container'));
  return ok(c, await service.listLeads(c.get('auth')!.user, input));
});

readRoutes.get('/leads/:id', async (c) => {
  const service = new CrmService(c.get('container'));
  const result = await service.listLeads(c.get('auth')!.user, { limit: 1, offset: 0 });
  void result;
  const lead = await c.get('container').leads.findById(c.req.param('id'));
  if (!lead || lead.owner_admin_id !== c.get('auth')!.user.id) {
    return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Lead not found.' } }, 404);
  }
  return ok(c, { lead, activities: await service.leadActivities(c.get('auth')!.user, lead.id) });
});

readRoutes.get('/leads/:id/activities', async (c) => {
  const service = new CrmService(c.get('container'));
  return ok(c, await service.leadActivities(c.get('auth')!.user, c.req.param('id')));
});

/* --------------------------------- writes --------------------------------- */

const writeRoutes = new Hono<AppEnv>();
writeRoutes.use('*', demoReadOnly);

writeRoutes.post('/contacts', async (c) => {
  const input = await body(
    c,
    z.object({
      phone: z.string().trim().min(3).max(40),
      name: z.string().trim().max(200).optional(),
      email: z.string().trim().max(200).optional(),
      country: z.string().trim().max(10).optional(),
      language: z.string().trim().max(10).optional(),
      optedIn: z.boolean().optional(),
      source: z.string().trim().max(40).optional(),
    }),
  );
  const service = new CrmService(c.get('container'));
  return ok(c, await service.createContact(c.get('auth')!.user, input, c), 201);
});

/** §31 CSV import with per-row validation, normalisation and dedupe reporting. */
writeRoutes.post('/contacts/import', async (c) => {
  const input = await body(
    c,
    z.object({
      csv: z.string().min(1).max(2_000_000),
      markOptIn: z.boolean().optional(),
      source: z.string().max(40).optional(),
    }),
  );
  const service = new CrmService(c.get('container'));
  return ok(c, await service.importContacts(c.get('auth')!.user, input, c));
});

writeRoutes.post('/contacts/:id/opt-in', async (c) => {
  const input = await body(c, z.object({ optedIn: z.boolean() }));
  const service = new CrmService(c.get('container'));
  return ok(c, await service.setOptIn(c.get('auth')!.user, c.req.param('id'), input.optedIn, c));
});

writeRoutes.post('/lists', async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(120) }));
  const service = new CrmService(c.get('container'));
  return ok(c, await service.createList(c.get('auth')!.user, input.name, c), 201);
});

writeRoutes.post('/lists/:id/members', async (c) => {
  const input = await body(c, z.object({ contactIds: z.array(zId).min(1).max(1000) }));
  const service = new CrmService(c.get('container'));
  return ok(c, await service.addToList(c.get('auth')!.user, c.req.param('id'), input.contactIds, c));
});

/** Canonical lead ingestion endpoint — used by web forms, imports, API and AI. */
writeRoutes.post('/leads', async (c) => {
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(200),
      phone: z.string().trim().min(3).max(40),
      email: z.string().trim().max(200).optional(),
      source: z.enum(['WEBSITE', 'FORM', 'AI', 'WHATSAPP', 'IMPORT', 'API', 'CAMPAIGN', 'REFERRAL']).default('API'),
      campaignId: z.string().max(64).optional(),
      score: z.number().int().min(0).max(100).optional(),
      intent: z.string().max(40).optional(),
      language: z.string().max(10).optional(),
      country: z.string().max(10).optional(),
      consent: z.boolean().optional(),
      stage: z.string().max(40).optional(),
      assignedTo: z.string().max(64).optional(),
    }),
  );
  const service = new CrmService(c.get('container'));
  return ok(c, await service.ingestLead(c.get('auth')!.user, input, c), 201);
});

writeRoutes.patch('/leads/:id', async (c) => {
  const input = await body(
    c,
    z.object({
      stage: z.string().max(40).optional(),
      score: z.number().int().min(0).max(100).optional(),
      status: z.string().max(40).optional(),
      assignedTo: z.string().max(64).optional(),
      intent: z.string().max(40).optional(),
    }),
  );
  const service = new CrmService(c.get('container'));
  return ok(c, await service.updateLead(c.get('auth')!.user, c.req.param('id'), input, c));
});

/** §33 evaluate routing rules for a lead (Lead → Qualification → Rule → Destination). */
writeRoutes.post('/leads/:id/route', async (c) => {
  const service = new RoutingService(c.get('container'));
  return ok(c, await service.routeLead(c.get('auth')!.user, c.req.param('id'), c));
});

crm.route('/', readRoutes);
crm.route('/', writeRoutes);

/* ------------------------- destinations & routing ------------------------- */

export const destinations = new Hono<AppEnv>();
destinations.use('*', resolveSession, requireAuth, requireRole('ADMIN', 'SUPER_ADMIN'));

destinations.get('/', async (c) => {
  const service = new RoutingService(c.get('container'));
  return ok(c, await service.listDestinations(c.get('auth')!.user));
});

destinations.post('/', demoReadOnly, async (c) => {
  const input = await body(
    c,
    z.object({
      kind: z.enum(['TELEGRAM', 'WEBHOOK']),
      name: z.string().trim().min(1).max(120),
      // Only a secret NAME is stored; the value lives in Worker secrets.
      secretRef: z.string().trim().max(80).optional(),
      config: z.record(z.unknown()).optional(),
    }),
  );
  const service = new RoutingService(c.get('container'));
  return ok(c, await service.createDestination(c.get('auth')!.user, input, c), 201);
});

destinations.patch('/:id', demoReadOnly, async (c) => {
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(120).optional(),
      config: z.record(z.unknown()).optional(),
      isActive: z.boolean().optional(),
      secretRef: z.string().trim().max(80).optional(),
    }),
  );
  const service = new RoutingService(c.get('container'));
  return ok(c, await service.updateDestination(c.get('auth')!.user, c.req.param('id'), input, c));
});

destinations.get('/rules', async (c) => {
  const service = new RoutingService(c.get('container'));
  return ok(c, await service.listRules(c.get('auth')!.user));
});

destinations.post('/rules', demoReadOnly, async (c) => {
  const input = await body(
    c,
    z.object({
      name: z.string().trim().min(1).max(120),
      destinationId: zId,
      minScore: z.number().int().min(0).max(100).optional(),
      intent: z.string().max(40).optional(),
      campaignId: z.string().max(64).optional(),
      language: z.string().max(10).optional(),
      country: z.string().max(10).optional(),
      source: z.string().max(40).optional(),
      stage: z.string().max(40).optional(),
      requiresConsent: z.boolean().optional(),
      priority: z.number().int().min(0).max(1000).optional(),
    }),
  );
  const service = new RoutingService(c.get('container'));
  return ok(c, await service.createRule(c.get('auth')!.user, input, c), 201);
});

destinations.post('/rules/:id/active', demoReadOnly, async (c) => {
  const input = await body(c, z.object({ isActive: z.boolean() }));
  const service = new RoutingService(c.get('container'));
  return ok(c, await service.setRuleActive(c.get('auth')!.user, c.req.param('id'), input.isActive, c));
});

destinations.get('/deliveries', async (c) => {
  const input = query(c, zPagination.merge(z.object({ leadId: z.string().max(64).optional() })));
  const service = new RoutingService(c.get('container'));
  return ok(c, await service.deliveries(c.get('auth')!.user, input));
});
