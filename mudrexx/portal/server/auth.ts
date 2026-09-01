/**
 * Authorization for the control-plane routes.
 *
 * These functions run on Vercel, outside the MUDREXX Worker, so they cannot
 * read the session from D1. They must also never trust anything the browser
 * says about who it is — the session cookie is opaque and HttpOnly by design.
 *
 * So authorization is delegated to the one component that owns it: the request
 * is replayed against the Worker's /api/auth/me with the caller's own cookie.
 * If the Worker does not recognise the session, or the role is not SUPER_ADMIN,
 * the request is refused. There is exactly one source of truth for identity.
 */

export interface ChiefIdentity {
  id: string;
  email: string;
  role: string;
  fullName: string | null;
}

export class AuthError extends Error {
  // Declared as plain fields rather than TypeScript parameter properties:
  // parameter properties need a code transform, which Node's type-stripping
  // (used by the test runner) refuses to do.
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

export async function requireChief(request: Request): Promise<ChiefIdentity> {
  const origin = process.env.MUDREXX_API_ORIGIN;
  if (!origin) {
    throw new AuthError(
      503,
      'NOT_CONFIGURED',
      'MUDREXX_API_ORIGIN is not set, so this deployment cannot verify who is calling. Control-plane routes are refused until it is.',
    );
  }

  const cookie = request.headers.get('cookie');
  if (!cookie) throw new AuthError(401, 'UNAUTHENTICATED', 'No session cookie was sent.');

  let response: Response;
  try {
    response = await fetch(new URL('/api/auth/me', origin).toString(), {
      headers: { cookie, accept: 'application/json' },
    });
  } catch (err) {
    throw new AuthError(
      502,
      'UPSTREAM_UNREACHABLE',
      `Could not reach MUDREXX to verify the session: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(401, 'UNAUTHENTICATED', 'The session is not valid.');
  }
  if (!response.ok) {
    throw new AuthError(502, 'UPSTREAM_ERROR', `MUDREXX returned HTTP ${response.status}.`);
  }

  const payload = (await response.json()) as {
    success?: boolean;
    data?: { user?: ChiefIdentity } & Partial<ChiefIdentity>;
  };
  const user = payload?.data?.user ?? (payload?.data as ChiefIdentity | undefined);

  if (!user?.id) {
    throw new AuthError(401, 'UNAUTHENTICATED', 'MUDREXX did not return a user for this session.');
  }

  // The portal is SUPER_ADMIN only. An ADMIN session is a valid session and
  // still must not reach the control plane.
  if (user.role !== 'SUPER_ADMIN') {
    throw new AuthError(403, 'FORBIDDEN', 'The control plane is restricted to SUPER_ADMIN.');
  }

  return user;
}
