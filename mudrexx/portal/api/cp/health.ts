/**
 * GET /api/cp/health — control-plane diagnostics.
 *
 * Reports which of the three things the integration needs actually work:
 * configuration, OIDC role assumption, and table access. When something is
 * wrong this is the endpoint that says which one, instead of a generic 500 on
 * the pages that use the data.
 *
 * It performs a zero-item Query, which touches the table and its key schema
 * without reading or writing any data.
 */

import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { requireChief } from '../../server/auth.ts';
import { getDocClient, readTableConfig } from '../../server/dynamo.ts';
import { ok, toErrorResponse } from '../../server/http.ts';

export const config = { runtime: 'nodejs' };

export default async function handler(request: Request): Promise<Response> {
  try {
    await requireChief(request);
    const table = readTableConfig();

    const started = Date.now();
    const client = getDocClient(table);
    await client.send(
      new QueryCommand({
        TableName: table.tableName,
        KeyConditionExpression: '#pk = :pk',
        ExpressionAttributeNames: { '#pk': table.partitionKey },
        ExpressionAttributeValues: { ':pk': '__healthcheck__' },
        Limit: 1,
      }),
    );

    return ok({
      status: 'ok',
      table: table.tableName,
      region: table.region,
      // Echoed so a mismatch with the real schema is obvious at a glance.
      keySchema: { partitionKey: table.partitionKey, sortKey: table.sortKey },
      credentials: 'vercel-oidc',
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
