import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, GetCommand, type BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import type { IngestedReading } from '@snowball/shared';
import { NAMES } from '@snowball/shared';
import { batchGetAll } from './batch-get';
import { dataAccess } from './repositories/dynamodb';
import type { TelemetryQuery } from './query';

const TABLE = process.env.DDB_TABLE ?? NAMES.telemetryTable;
const STATE_TABLE = process.env.DDB_STATE_TABLE ?? NAMES.unitStateTable;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export { dataAccess };

export async function queryNewReadings(unitId: string, sinceTs: string | undefined): Promise<IngestedReading[]> {
  if (sinceTs === undefined) {
    const { Item } = await ddb.send(new GetCommand({ TableName: STATE_TABLE, Key: { unit_id: unitId } }));
    return Item ? [Item as IngestedReading] : [];
  }
  const { Items } = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'unit_id = :u AND ts BETWEEN :from AND :to',
    ExpressionAttributeValues: { ':u': unitId, ':from': `${sinceTs} `, ':to': '9999' },
    Limit: 100,
  }));
  return (Items ?? []) as IngestedReading[];
}

export async function latestReadingsForLive(unitIds: string[]): Promise<Map<string, IngestedReading>> {
  return batchGetAll((cmd: BatchGetCommand) => ddb.send(cmd), STATE_TABLE, unitIds);
}

export function telemetryQueryForLive(_unitId: string, _query: TelemetryQuery): Promise<IngestedReading[]> {
  throw new Error('use the DataAccess queryTelemetry method');
}

export async function closePool(): Promise<void> {
  // Kept as a no-op for the existing shutdown path; DynamoDB clients do not hold a pool.
}
