import { env, SELF } from 'cloudflare:test';
import { createContainer, type Container } from '../../src/container';
import { hashPassword } from '../../src/lib/crypto';
import type { ApprovalStatus, Env, PaymentStatus, Role, UserRow } from '../../src/types';
import { json, jsonRequest } from './db';

export function testEnv(): Env {
  return env as unknown as Env;
}

export function testContainer(): Container {
  return createContainer(testEnv());
}

export interface SeededUser {
  user: UserRow;
  password: string;
  email: string;
}

/** Create an account directly through the repositories (test setup only). */
export async function seedUser(
  role: Role,
  opts: {
    email?: string;
    password?: string;
    status?: UserRow['status'];
    approval?: ApprovalStatus;
    payment?: PaymentStatus;
    isDemo?: boolean;
    fullName?: string;
    packageId?: string | null;
  } = {},
): Promise<SeededUser> {
  const c = testContainer();
  const password = opts.password ?? 'TestPass-12345';
  const email = opts.email ?? `${role.toLowerCase()}-${crypto.randomUUID()}@test.local`;

  const user = await c.users.create({
    email,
    passwordHash: await hashPassword(password),
    role,
    fullName: opts.fullName ?? 'Test Account',
    firstName: 'Test',
    lastName: 'Account',
    status: opts.status ?? 'ACTIVE',
    isDemo: opts.isDemo ?? false,
    packageId: opts.packageId ?? null,
  });

  if (opts.approval || opts.payment) {
    await c.users.update(user.id, {
      approval_status: opts.approval ?? 'PENDING',
      payment_status: opts.payment ?? 'PENDING',
    });
  }

  if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
    await c.users.createAdminProfile(user.id, 'Test Business');
  }

  return { user, password, email };
}

export async function seedActiveAdmin(opts: { email?: string; password?: string } = {}) {
  return seedUser('ADMIN', {
    ...opts,
    status: 'ACTIVE',
    approval: 'APPROVED',
    payment: 'VERIFIED',
  });
}

export async function seedChief(opts: { email?: string; password?: string } = {}) {
  return seedUser('SUPER_ADMIN', { ...opts, status: 'ACTIVE' });
}

/* ------------------------------- HTTP helpers ------------------------------- */

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  meta?: Record<string, unknown>;
}

export async function api<T = unknown>(
  path: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: ApiEnvelope<T> }> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await SELF.fetch(
    jsonRequest(path, { method: init.method, body: init.body, headers }),
  );
  return { status: res.status, body: await json<ApiEnvelope<T>>(res) };
}

export async function login(
  portal: 'user' | 'admin' | 'chief',
  email: string,
  password: string,
): Promise<{ status: number; body: ApiEnvelope<{ token: string; user: { id: string; role: string; humanId: string } }> }> {
  const path =
    portal === 'user'
      ? '/api/auth/login'
      : portal === 'admin'
        ? '/api/auth/admin/login'
        : '/api/auth/super-admin/login';
  return api(path, { method: 'POST', body: { email, password } });
}

export async function registerUser(input: {
  email: string;
  password: string;
  fullName: string;
  phone?: string;
}): Promise<{
  status: number;
  body: ApiEnvelope<{ token: string; user: { humanId: string; id: string; role: string } }>;
}> {
  return api('/api/auth/register', { method: 'POST', body: input });
}
