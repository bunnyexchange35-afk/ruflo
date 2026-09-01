/**
 * Response helpers that keep the control-plane routes on the same JSON
 * envelope the MUDREXX backend uses, so the portal's API client can consume
 * both without special-casing.
 */

import { AuthError } from './auth.ts';
import { ConfigError } from './dynamo.ts';

export function ok<T>(data: T, status = 200): Response {
  return json({ success: true, data }, status);
}

export function fail(status: number, code: string, message: string): Response {
  return json({ success: false, error: { code, message } }, status);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Maps a thrown error onto the envelope. AWS errors are translated rather than
 * leaked verbatim: an operator needs to know which misconfiguration to fix, and
 * the raw SDK message is rarely that.
 */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof AuthError) return fail(err.status, err.code, err.message);
  if (err instanceof ConfigError) return fail(503, 'NOT_CONFIGURED', err.message);

  const name = (err as { name?: string })?.name ?? '';
  const message = err instanceof Error ? err.message : String(err);

  switch (name) {
    case 'ResourceNotFoundException':
      return fail(
        502,
        'TABLE_NOT_FOUND',
        `DynamoDB reports the table does not exist in this region. Check DYNAMODB_TABLE_NAME and AWS_REGION. (${message})`,
      );
    case 'AccessDeniedException':
    case 'NotAuthorizedException':
      return fail(
        502,
        'ACCESS_DENIED',
        `The assumed role is not permitted to perform this action on the table. Check the IAM policy on AWS_ROLE_ARN. (${message})`,
      );
    case 'ValidationException':
      return fail(
        502,
        'SCHEMA_MISMATCH',
        `DynamoDB rejected the request. This usually means DYNAMODB_TABLE_PARTITION_KEY / DYNAMODB_TABLE_SORT_KEY do not match the table's real key names. (${message})`,
      );
    case 'CredentialsProviderError':
      return fail(
        502,
        'OIDC_FAILED',
        `Could not exchange the Vercel OIDC token for AWS credentials. Confirm OIDC is enabled on the project and that the role's trust policy allows this project and environment. (${message})`,
      );
    default:
      return fail(500, 'INTERNAL', message);
  }
}
