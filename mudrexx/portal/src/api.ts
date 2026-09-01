/**
 * Typed client for the MUDREXX API.
 *
 * Every request is same-origin and sends credentials, because authorization is
 * resolved server-side from the HttpOnly session cookie. Nothing here ever
 * stores or inspects a token — the backend contract is explicit that a
 * client-held value must never decide authorization.
 */

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiError {
  success: false;
  error: { code: string; message: string; details?: unknown };
}

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiRequestError(
      'NETWORK',
      'Could not reach the MUDREXX API. If this is a Vercel deployment, check that MUDREXX_API_ORIGIN is set.',
      0,
    );
  }

  // A proxy misconfiguration typically returns the SPA's index.html here, which
  // is far more confusing than an explicit error.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    throw new ApiRequestError(
      'BAD_GATEWAY',
      `Expected JSON from /api${path} but received "${contentType || 'no content-type'}" (HTTP ${response.status}). The /api proxy is probably not reaching the Worker.`,
      response.status,
    );
  }

  const payload = (await response.json()) as ApiSuccess<T> | ApiError;

  if (!response.ok || payload.success === false) {
    const err = (payload as ApiError).error;
    throw new ApiRequestError(
      err?.code ?? 'UNKNOWN',
      err?.message ?? `Request failed with HTTP ${response.status}`,
      response.status,
    );
  }

  return payload.data;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/* ------------------------------- API types ------------------------------- */

export interface PublicUser {
  id: string;
  humanId: number | string | null;
  email: string;
  phone: string | null;
  role: string;
  status: string;
  fullName: string | null;
  isDemo: boolean;
  packageId: string | null;
  createdAt: string | number | null;
  lastLoginAt: string | number | null;
}

export interface PaymentRow {
  id: string;
  user_id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  created_at?: string | number;
  [key: string]: unknown;
}

export interface AuditRow {
  id: string;
  action?: string;
  actor_id?: string | null;
  created_at?: string | number;
  [key: string]: unknown;
}

export interface SessionRow {
  id: string;
  user_id?: string;
  created_at?: string | number;
  expires_at?: string | number;
  [key: string]: unknown;
}

export interface Dashboard {
  portal: string;
  sections: unknown;
  counts: { users: number; admins: number; activeSessions: number; payments: number };
  recentAdmins: PublicUser[];
  recentPayments: PaymentRow[];
  recentAudit: AuditRow[];
}

export interface Paginated<T> {
  rows?: T[];
  total?: number;
  [key: string]: unknown;
}

/** The list endpoints are not perfectly uniform; normalise defensively. */
export function rowsOf<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['rows', 'items', 'data', 'results']) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}
