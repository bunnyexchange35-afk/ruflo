/**
 * Shared config + DynamoDB client for the ruflo-cp control-plane table.
 *
 * Auth is OIDC federation, not static keys: Vercel mints a short-lived OIDC
 * token, the provider exchanges it via sts:AssumeRoleWithWebIdentity for
 * temporary credentials on AWS_ROLE_ARN. Nothing here reads an access key, and
 * there is no AWS secret in the repo or in the environment.
 *
 * This requires the Node.js runtime — the AWS SDK and the credential provider
 * do not run on the edge runtime, which is why these routes are Node while the
 * MUDREXX proxy stays on edge.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';

export interface TableConfig {
  tableName: string;
  partitionKey: string;
  sortKey: string;
  region: string;
  roleArn: string;
}

export class ConfigError extends Error {}

/**
 * Key names come from the environment rather than being hard-coded.
 *
 * The Vercel AWS integration exports DYNAMODB_TABLE_PARTITION_KEY and
 * DYNAMODB_TABLE_SORT_KEY, and the attribute names must match the table's
 * actual schema exactly or every request fails with ValidationException.
 * Reading them keeps this code correct whatever the table was created with.
 */
export function readTableConfig(): TableConfig {
  const tableName = process.env.DYNAMODB_TABLE_NAME;
  const region = process.env.AWS_REGION;
  const roleArn = process.env.AWS_ROLE_ARN;

  const missing = [
    ['DYNAMODB_TABLE_NAME', tableName],
    ['AWS_REGION', region],
    ['AWS_ROLE_ARN', roleArn],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new ConfigError(
      `Missing environment variable(s): ${missing.join(', ')}. Add them in the Vercel project (the AWS integration sets them automatically) and redeploy.`,
    );
  }

  return {
    tableName: tableName!,
    region: region!,
    roleArn: roleArn!,
    partitionKey: process.env.DYNAMODB_TABLE_PARTITION_KEY || 'PK',
    sortKey: process.env.DYNAMODB_TABLE_SORT_KEY || 'SK',
  };
}

let cached: DynamoDBDocumentClient | null = null;

/** The client is reused across invocations on a warm function instance. */
export function getDocClient(config: TableConfig): DynamoDBDocumentClient {
  if (cached) return cached;

  const client = new DynamoDBClient({
    region: config.region,
    credentials: awsCredentialsProvider({
      roleArn: config.roleArn,
      clientConfig: { region: config.region },
    }),
  });

  cached = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cached;
}

/** Builds the composite key for a note, so the layout lives in one place. */
export function noteKeys(config: TableConfig, entity: string, sort: string) {
  return {
    [config.partitionKey]: `NOTE#${entity}`,
    [config.sortKey]: sort,
  } as Record<string, string>;
}
