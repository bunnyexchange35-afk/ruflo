import { Hono } from 'hono';
import type { AppEnv } from '../app-types';
import { ok } from '../http/errors';

/**
 * §10 Database health.
 *
 * The response is deliberately minimal: it proves the D1 binding works and
 * reports table/column counts. It never exposes credentials, connection
 * strings, DSNs or secrets.
 */
export const health = new Hono<AppEnv>();

/**
 * §45 environment validation.
 * Reports which integrations are configured — presence only, never a value.
 */
function configPresence(c: Parameters<typeof ok>[0]) {
  const env = c.env;
  const llmProviders = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GOOGLE_API_KEY'].filter(
    (key) => Boolean((env as unknown as Record<string, string | undefined>)[key]),
  ).length;

  return {
    environment: env.ENVIRONMENT ?? 'production',
    recovery: Boolean(env.RECOVERY_SECRET),
    llmProvidersConfigured: llmProviders,
    whatsapp: Boolean(
      (env.WHATSAPP_ACCESS_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) ||
        (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM),
    ),
    telegram: Boolean(env.TELEGRAM_BOT_TOKEN),
    corsAllowlist: Boolean(env.ALLOWED_ORIGINS),
  };
}

health.get('/health', (c) =>
  ok(c, {
    status: 'ok',
    service: 'mudrexx-backend',
    environment: c.env.ENVIRONMENT ?? 'production',
    time: new Date().toISOString(),
    config: configPresence(c),
  }),
);

health.get('/health/db', async (c) => {
  const container = c.get('container');
  const started = Date.now();

  try {
    const [{ tables }, { users }, { sessions }, { leads }] = await Promise.all([
      container.db
        .one<{ tables: number }>(
          `SELECT COUNT(*) AS tables FROM sqlite_master WHERE type = 'table'
           AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'`,
        )
        .then((r) => ({ tables: r?.tables ?? 0 })),
      container.db.count(`SELECT COUNT(*) AS c FROM users`).then((c2) => ({ users: c2 })),
      container.db.count(`SELECT COUNT(*) AS c FROM sessions`).then((c2) => ({ sessions: c2 })),
      container.db.count(`SELECT COUNT(*) AS c FROM leads`).then((c2) => ({ leads: c2 })),
    ]);

    const activeSessions = await container.sessions.countActive();

    return ok(c, {
      status: 'ok',
      database: 'd1',
      reachable: true,
      latencyMs: Date.now() - started,
      // Counts only — no credentials, DSN or secret values are ever returned.
      tables,
      counts: { users, sessions, leads, activeSessions },
    });
  } catch (err) {
    return c.json(
      {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Database health check failed.',
          detail: (err as Error).message,
        },
      },
      500,
    );
  }
});
