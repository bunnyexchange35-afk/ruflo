import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './app-types';
import { createContainer } from './container';
import { errorBoundary } from './middleware/errors';
import { observability } from './middleware/observability';
import { health } from './routes/health';
import { auth } from './routes/auth';
import { admin } from './routes/admin';
import { chief } from './routes/chief';
import { crm, destinations } from './routes/crm';
import { tasks } from './routes/tasks';
import { ai } from './routes/ai';
import { whatsapp } from './routes/whatsapp';
import { webhooks } from './routes/webhooks';
import { publicRoutes } from './routes/public';

/**
 * MUDREXX central backend (§2, §42).
 *
 * Route precedence is explicit and deliberate (§6, §7, §54):
 *
 *   1. /api/<namespace>/*  — every API namespace is mounted BEFORE any
 *      wildcard, so a generic handler can never intercept a specific route.
 *   2. /api/*              — unmatched API paths return JSON 404.
 *   3. everything else     — SPA/browser fallback, which is only reachable for
 *      non-API paths.
 */
const app = new Hono<AppEnv>();

app.use('*', observability);

app.use('*', async (c, next) => {
  if (!c.get('container')) c.set('container', createContainer(c.env));
  await next();
});

app.use(
  '/api/*',
  cors({
    origin: (origin, c) => {
      const allowed = (c.env.ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((o: string) => o.trim())
        .filter(Boolean);
      if (!allowed.length) return origin || '*';
      return allowed.includes(origin) ? origin : allowed[0];
    },
    credentials: true,
    allowHeaders: ['content-type', 'authorization', 'x-request-id'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }),
);

/* ------------------------- 1. API namespaces ------------------------- */

app.route('/api', health); // /api/health, /api/health/db
app.route('/api', publicRoutes); // /api/portal, /api/packages
app.route('/api/auth', auth); // /api/auth/*, /api/auth/admin/login, /api/auth/super-admin/login
app.route('/api/admin', admin); // /api/admin/*
app.route('/api/chief', chief); // /api/chief/*
app.route('/api/crm', crm); // /api/crm/*
app.route('/api/destinations', destinations); // /api/destinations/*
app.route('/api/tasks', tasks); // /api/tasks/*
app.route('/api/ai', ai); // /api/ai/*
app.route('/api/whatsapp', whatsapp); // /api/whatsapp/*
app.route('/api/webhooks', webhooks); // /api/webhooks/*

/* ------------------- 2. API 404 — JSON, never HTML ------------------- */

app.all('/api/*', (c) =>
  c.json(
    {
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: `No API route matches ${c.req.method} ${new URL(c.req.url).pathname}`,
      },
    },
    404,
  ),
);

/* ------------------- 3. Browser / SPA fallback only ------------------- */

app.get('*', async (c) => {
  const url = new URL(c.req.url);

  // Defensive: the API namespace must never reach the SPA fallback.
  if (url.pathname.startsWith('/api/')) {
    return c.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'No API route matches this path.' } },
      404,
    );
  }

  // Serve the built frontend when the Worker has an ASSETS binding.
  if (c.env.ASSETS) {
    try {
      const response = await c.env.ASSETS.fetch(c.req.raw);
      if (response.status !== 404) return response;
      // SPA route: fall back to index.html for client-side routing.
      const indexUrl = new URL('/index.html', url.origin);
      const index = await c.env.ASSETS.fetch(new Request(indexUrl.toString()));
      if (index.ok) return new Response(index.body, { status: 200, headers: index.headers });
    } catch {
      /* fall through to the backend-only shell */
    }
  }

  return c.html(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MUDREXX Backend</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
             margin: 0; display: grid; place-items: center; min-height: 100vh; background: #0b1020; color: #e6e9f2; }
      main { max-width: 40rem; padding: 2rem; }
      code { background: #172040; padding: 0.15rem 0.4rem; border-radius: 0.25rem; }
      a { color: #8ab4ff; }
    </style>
  </head>
  <body>
    <main>
      <h1>MUDREXX backend</h1>
      <p>The API is live. This Worker is running without a bundled frontend build.</p>
      <ul>
        <li><a href="/api/health">/api/health</a> — service health</li>
        <li><a href="/api/health/db">/api/health/db</a> — D1 health (safe fields only)</li>
        <li><a href="/api/portal">/api/portal</a> — portal configuration</li>
        <li><a href="/api/packages">/api/packages</a> — packages and pricing</li>
      </ul>
      <p>Deploy a frontend build with the <code>ASSETS</code> binding to serve the SPA here.</p>
    </main>
  </body>
</html>`,
    200,
  );
});

/* --------------------------- error contract --------------------------- */

app.onError(errorBoundary);
app.notFound((c) => {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) {
    return c.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'No API route matches this path.' } },
      404,
    );
  }
  return c.json({ success: false, error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404);
});

export default app;
