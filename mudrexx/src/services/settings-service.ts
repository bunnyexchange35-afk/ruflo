import type { Context } from 'hono';
import type { Container } from '../container';
import { AppError } from '../http/errors';
import { clientIp, userAgentOf } from '../lib/http';
import { AUDIT_ACTIONS } from '../repositories/platform';
import { DEFAULT_PORTAL_SETTINGS, type PortalSettings, type UserRow } from '../types';

const SETTINGS_KEY = 'portal';

/**
 * §40 Portal configuration.
 *
 * Portal name, browser title, login title, dashboard title and footer live in
 * the database. Nothing about the portal identity is hardcoded across files.
 */
export class SettingsService {
  constructor(private readonly c: Container) {}

  async getPortal(): Promise<PortalSettings> {
    const stored = await this.c.settings.get<Partial<PortalSettings>>(SETTINGS_KEY, {});
    return { ...DEFAULT_PORTAL_SETTINGS, ...stored };
  }

  async updatePortal(
    patch: Partial<PortalSettings>,
    actor: UserRow,
    req: Context,
  ): Promise<PortalSettings> {
    const merged = { ...(await this.getPortal()), ...patch };

    for (const [key, value] of Object.entries(merged)) {
      if (typeof value !== 'string' || value.length > 200) {
        throw new AppError('VALIDATION_ERROR', `Portal setting "${key}" must be a string of at most 200 characters.`);
      }
    }
    if (!merged.portalName.trim()) {
      throw new AppError('VALIDATION_ERROR', 'Portal name cannot be empty.');
    }

    await this.c.settings.set(SETTINGS_KEY, merged, actor.id);
    await this.c.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AUDIT_ACTIONS.PORTAL_CONFIG_UPDATED,
      targetType: 'settings',
      targetId: SETTINGS_KEY,
      ip: clientIp(req),
      userAgent: userAgentOf(req),
      requestId: req.get('requestId'),
      meta: { patch },
    });
    return merged;
  }

  async all() {
    return this.c.settings.all();
  }
}
