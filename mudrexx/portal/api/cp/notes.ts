/**
 * /api/cp/notes — operator notes, stored in the ruflo-cp DynamoDB table.
 *
 * This is deliberately control-plane data, not MUDREXX domain data. Users,
 * admins, payments and the audit trail live in D1 behind the Worker and are not
 * duplicated here; these are annotations the operator writes while working in
 * the portal, keyed to whatever entity they were looking at.
 *
 * Single-table layout:
 *   PK  NOTE#<entityType>#<entityId>
 *   SK  <ISO-8601 createdAt>#<random suffix>
 *
 * The sort key is time-ordered, so listing a thread is one Query with no filter
 * and no scan, and newest-first is just ScanIndexForward: false.
 *
 *   GET    /api/cp/notes?entity=admin:usr_123
 *   POST   /api/cp/notes            { entity, body }
 *   DELETE /api/cp/notes?entity=…&sk=…
 */

import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { requireChief, type ChiefIdentity } from '../../server/auth.ts';
import { getDocClient, noteKeys, readTableConfig, type TableConfig } from '../../server/dynamo.ts';
import { fail, ok, toErrorResponse } from '../../server/http.ts';

export const config = { runtime: 'nodejs' };

const MAX_BODY = 2000;
const ENTITY_PATTERN = /^[a-zA-Z0-9_:.-]{1,128}$/;

export default async function handler(request: Request): Promise<Response> {
  try {
    const chief = await requireChief(request);
    const table = readTableConfig();
    const url = new URL(request.url);

    switch (request.method) {
      case 'GET':
        return await list(table, url);
      case 'POST':
        return await create(table, request, chief);
      case 'DELETE':
        return await remove(table, url);
      default:
        return fail(405, 'METHOD_NOT_ALLOWED', `${request.method} is not supported here.`);
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

function validEntity(value: string | null): string | null {
  if (!value || !ENTITY_PATTERN.test(value)) return null;
  return value;
}

async function list(table: TableConfig, url: URL): Promise<Response> {
  const entity = validEntity(url.searchParams.get('entity'));
  if (!entity) {
    return fail(400, 'INVALID', 'A valid "entity" query parameter is required, e.g. admin:usr_123.');
  }

  const limitParam = Number(url.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 50;

  const client = getDocClient(table);
  const result = await client.send(
    new QueryCommand({
      TableName: table.tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': table.partitionKey },
      ExpressionAttributeValues: { ':pk': `NOTE#${entity}` },
      ScanIndexForward: false, // newest first
      Limit: limit,
    }),
  );

  const items = (result.Items ?? []).map((item) => ({
    sk: String(item[table.sortKey] ?? ''),
    body: String(item.body ?? ''),
    authorEmail: item.authorEmail ? String(item.authorEmail) : null,
    createdAt: item.createdAt ? String(item.createdAt) : null,
  }));

  return ok({ entity, notes: items, count: items.length });
}

async function create(
  table: TableConfig,
  request: Request,
  chief: ChiefIdentity,
): Promise<Response> {
  let payload: { entity?: unknown; body?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return fail(400, 'INVALID', 'Request body must be JSON.');
  }

  const entity = validEntity(typeof payload.entity === 'string' ? payload.entity : null);
  if (!entity) {
    return fail(400, 'INVALID', 'A valid "entity" is required, e.g. admin:usr_123.');
  }

  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!body) return fail(400, 'INVALID', 'A non-empty "body" is required.');
  if (body.length > MAX_BODY) {
    return fail(400, 'INVALID', `"body" must be at most ${MAX_BODY} characters.`);
  }

  const createdAt = new Date().toISOString();
  // The suffix keeps two notes written in the same millisecond distinct.
  const sk = `${createdAt}#${Math.random().toString(36).slice(2, 10)}`;

  const client = getDocClient(table);
  await client.send(
    new PutCommand({
      TableName: table.tableName,
      Item: {
        ...noteKeys(table, entity, sk),
        type: 'NOTE',
        body,
        // Attribution comes from the verified session, never from the client.
        authorId: chief.id,
        authorEmail: chief.email,
        createdAt,
      },
      // Never silently overwrite an existing item.
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': table.partitionKey },
    }),
  );

  return ok({ entity, note: { sk, body, authorEmail: chief.email, createdAt } }, 201);
}

async function remove(table: TableConfig, url: URL): Promise<Response> {
  const entity = validEntity(url.searchParams.get('entity'));
  const sk = url.searchParams.get('sk');
  if (!entity || !sk) {
    return fail(400, 'INVALID', 'Both "entity" and "sk" query parameters are required.');
  }

  const client = getDocClient(table);
  await client.send(
    new DeleteCommand({ TableName: table.tableName, Key: noteKeys(table, entity, sk) }),
  );

  return ok({ deleted: true, entity, sk });
}
