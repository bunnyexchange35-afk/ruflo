import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app-types';
import { ok } from '../http/errors';
import { query, zId } from '../middleware/validate';
import { PackageService } from '../services/package-service';
import { SettingsService } from '../services/settings-service';

/**
 * Unauthenticated surface.
 * §40 the portal identity is served from the database, not hardcoded in the UI.
 */
export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/portal', async (c) => {
  const service = new SettingsService(c.get('container'));
  return ok(c, await service.getPortal());
});

publicRoutes.get('/packages', async (c) => {
  const service = new PackageService(c.get('container'));
  return ok(c, await service.list());
});

publicRoutes.get('/packages/quote', async (c) => {
  const input = query(
    c,
    z.object({
      packageId: zId,
      period: z.enum(['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL']),
    }),
  );
  const service = new PackageService(c.get('container'));
  return ok(c, await service.quote({ packageId: input.packageId, period: input.period }));
});
