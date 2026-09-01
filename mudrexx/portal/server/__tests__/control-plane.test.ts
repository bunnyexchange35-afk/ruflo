/**
 * Tests for the parts of the control plane that can be verified without AWS:
 * the authorization boundary, configuration handling, and error translation.
 *
 * The DynamoDB calls themselves are not covered here — they need real
 * credentials, which only exist inside a Vercel deployment via OIDC.
 *
 * Run: npm test
 */

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import { AuthError, requireChief } from '../auth.ts';
import { ConfigError, noteKeys, readTableConfig } from '../dynamo.ts';
import { toErrorResponse } from '../http.ts';

const realFetch = globalThis.fetch;
const realEnv = { ...process.env };

afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...realEnv };
});

/** Minimal Request carrying a cookie header. */
function req(cookie?: string) {
  return new Request('https://portal.example/api/cp/notes', {
    headers: cookie ? { cookie } : {},
  });
}

function stubWorker(status: number, body: unknown) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
}

async function expectAuthError(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AuthError, `expected AuthError, got ${err}`);
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    return true;
  });
}

describe('requireChief — the authorization boundary', () => {
  it('refuses when MUDREXX_API_ORIGIN is unset, rather than failing open', async () => {
    delete process.env.MUDREXX_API_ORIGIN;
    await expectAuthError(requireChief(req('mudrexx_session=x')), 503, 'NOT_CONFIGURED');
  });

  it('rejects a request with no session cookie', async () => {
    process.env.MUDREXX_API_ORIGIN = 'https://worker.example';
    await expectAuthError(requireChief(req()), 401, 'UNAUTHENTICATED');
  });

  it('rejects when the Worker does not recognise the session', async () => {
    process.env.MUDREXX_API_ORIGIN = 'https://worker.example';
    stubWorker(401, { success: false });
    await expectAuthError(requireChief(req('mudrexx_session=bad')), 401, 'UNAUTHENTICATED');
  });

  it('rejects an authenticated ADMIN — valid session, wrong role', async () => {
    process.env.MUDREXX_API_ORIGIN = 'https://worker.example';
    stubWorker(200, {
      success: true,
      data: { user: { id: 'usr_1', email: 'a@b.c', role: 'ADMIN', fullName: 'A' } },
    });
    await expectAuthError(requireChief(req('mudrexx_session=ok')), 403, 'FORBIDDEN');
  });

  it('accepts a SUPER_ADMIN and returns the identity from the Worker', async () => {
    process.env.MUDREXX_API_ORIGIN = 'https://worker.example';
    stubWorker(200, {
      success: true,
      data: { user: { id: 'usr_9', email: 'chief@b.c', role: 'SUPER_ADMIN', fullName: 'Chief' } },
    });
    const chief = await requireChief(req('mudrexx_session=ok'));
    assert.equal(chief.id, 'usr_9');
    assert.equal(chief.email, 'chief@b.c');
  });

  it('forwards the caller cookie to the Worker and never invents one', async () => {
    process.env.MUDREXX_API_ORIGIN = 'https://worker.example';
    let seen: string | null = null;
    globalThis.fetch = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      seen = new Headers(init?.headers).get('cookie');
      return new Response(
        JSON.stringify({ success: true, data: { user: { id: 'u', email: 'e', role: 'SUPER_ADMIN' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof globalThis.fetch;
    await requireChief(req('mudrexx_session=abc123'));
    assert.equal(seen, 'mudrexx_session=abc123');
  });

  it('surfaces an unreachable Worker as 502, not as success', async () => {
    process.env.MUDREXX_API_ORIGIN = 'https://worker.example';
    globalThis.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expectAuthError(requireChief(req('mudrexx_session=x')), 502, 'UPSTREAM_UNREACHABLE');
  });
});

describe('readTableConfig', () => {
  it('reports every missing variable at once', () => {
    delete process.env.DYNAMODB_TABLE_NAME;
    delete process.env.AWS_REGION;
    delete process.env.AWS_ROLE_ARN;
    try {
      readTableConfig();
      assert.fail('expected ConfigError');
    } catch (err) {
      assert.ok(err instanceof ConfigError);
      for (const name of ['DYNAMODB_TABLE_NAME', 'AWS_REGION', 'AWS_ROLE_ARN']) {
        assert.ok(err.message.includes(name), `expected ${name} in: ${err.message}`);
      }
    }
  });

  it('honours the key names from the environment', () => {
    process.env.DYNAMODB_TABLE_NAME = 'ruflo-cp';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ROLE_ARN = 'arn:aws:iam::1:role/x';
    process.env.DYNAMODB_TABLE_PARTITION_KEY = 'US';
    process.env.DYNAMODB_TABLE_SORT_KEY = 'SK';

    const config = readTableConfig();
    assert.equal(config.partitionKey, 'US');
    assert.equal(config.sortKey, 'SK');

    // The layout must use the configured attribute names verbatim.
    const key = noteKeys(config, 'admin:usr_1', '2026-01-01T00:00:00.000Z#abcd');
    assert.deepEqual(key, {
      US: 'NOTE#admin:usr_1',
      SK: '2026-01-01T00:00:00.000Z#abcd',
    });
  });

  it('falls back to PK/SK when the key names are not provided', () => {
    process.env.DYNAMODB_TABLE_NAME = 'ruflo-cp';
    process.env.AWS_REGION = 'us-east-1';
    process.env.AWS_ROLE_ARN = 'arn:aws:iam::1:role/x';
    delete process.env.DYNAMODB_TABLE_PARTITION_KEY;
    delete process.env.DYNAMODB_TABLE_SORT_KEY;

    const config = readTableConfig();
    assert.equal(config.partitionKey, 'PK');
    assert.equal(config.sortKey, 'SK');
  });
});

describe('toErrorResponse — actionable AWS failures', () => {
  const cases: [string, number, string][] = [
    ['ResourceNotFoundException', 502, 'TABLE_NOT_FOUND'],
    ['AccessDeniedException', 502, 'ACCESS_DENIED'],
    ['ValidationException', 502, 'SCHEMA_MISMATCH'],
    ['CredentialsProviderError', 502, 'OIDC_FAILED'],
  ];

  for (const [name, status, code] of cases) {
    it(`maps ${name} to ${code}`, async () => {
      const err = Object.assign(new Error('boom'), { name });
      const response = toErrorResponse(err);
      assert.equal(response.status, status);
      const body = await response.json();
      assert.equal(body.success, false);
      assert.equal(body.error.code, code);
    });
  }

  it('passes an AuthError through with its own status', async () => {
    const response = toErrorResponse(new AuthError(403, 'FORBIDDEN', 'nope'));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'FORBIDDEN');
  });
});
