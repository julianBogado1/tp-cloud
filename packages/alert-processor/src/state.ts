import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { ExcursionState } from '@snowball/shared';
import { NAMES } from '@snowball/shared';

/**
 * Excursion state per unit: in-memory cache (hot path) backed by DynamoDB so
 * it survives process restarts. Stored as one item per unit with the fixed
 * sort key `_state` in the same telemetry table — it cannot collide with
 * readings because no ISO ts starts with an underscore.
 */

const STATE_SK = '_state';
const TABLE = process.env.DDB_TABLE ?? NAMES.telemetryTable;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const memory = new Map<string, ExcursionState>();

export async function getState(unitId: string): Promise<ExcursionState> {
  const cached = memory.get(unitId);
  if (cached) return cached;

  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { unit_id: unitId, ts: STATE_SK } }),
  );
  const state: ExcursionState = Item ? { phase: Item.phase, since: Item.since } : { phase: 'ok' };
  memory.set(unitId, state);
  return state;
}

export async function saveState(unitId: string, state: ExcursionState): Promise<void> {
  memory.set(unitId, state);
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { unit_id: unitId, ts: STATE_SK, phase: state.phase, since: state.since },
    }),
  );
}
