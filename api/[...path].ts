/**
 * Same-origin proxy: /api/* on the Vercel domain -> the MUDREXX Worker.
 *
 * This exists because the MUDREXX session cookie is HttpOnly + SameSite=Strict
 * (mudrexx/src/routes/session-cookie.ts). If the browser called the Worker
 * directly on another origin, it would never attach that cookie, so the portal
 * would authenticate once and then 401 on every subsequent request. Proxying
 * keeps every request first-party to the Vercel domain, and Set-Cookie from the
 * Worker is re-scoped to that domain on the way back.
 *
 * Configure MUDREXX_API_ORIGIN in the Vercel project, e.g.
 *   https://mudrexx-backend.<subdomain>.workers.dev
 */

export const config = { runtime: 'edge' };

// Hop-by-hop headers must not be forwarded to the upstream Worker.
const STRIP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'content-length',
]);

const STRIP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'content-encoding',
  'content-length',
]);

function json(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ success: false, error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default async function handler(request: Request): Promise<Response> {
  const origin = process.env.MUDREXX_API_ORIGIN;

  if (!origin) {
    return json(
      503,
      'NOT_CONFIGURED',
      'MUDREXX_API_ORIGIN is not set on this deployment. Set it to the MUDREXX Worker URL in the Vercel project settings and redeploy.',
    );
  }

  let target: URL;
  try {
    const incoming = new URL(request.url);
    // Preserve the full /api/... path and query exactly as received.
    target = new URL(incoming.pathname + incoming.search, origin);
  } catch {
    return json(500, 'BAD_CONFIG', `MUDREXX_API_ORIGIN is not a valid URL: "${origin}"`);
  }

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!STRIP_REQUEST_HEADERS.has(key.toLowerCase())) headers.set(key, value);
  });
  // Let the Worker's CORS/origin logic see a consistent first-party origin.
  headers.set('x-forwarded-host', new URL(request.url).host);

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      redirect: 'manual',
    });
  } catch (err) {
    return json(
      502,
      'UPSTREAM_UNREACHABLE',
      `Could not reach the MUDREXX API at ${target.origin}. ${err instanceof Error ? err.message : ''}`.trim(),
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) responseHeaders.append(key, value);
  });

  // Set-Cookie needs explicit handling: iterating Headers folds duplicates into
  // one comma-joined value, which corrupts multiple cookies.
  const getSetCookie = (upstream.headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (typeof getSetCookie === 'function') {
    const cookies = getSetCookie.call(upstream.headers);
    if (cookies.length) {
      responseHeaders.delete('set-cookie');
      for (const cookie of cookies) responseHeaders.append('set-cookie', cookie);
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
