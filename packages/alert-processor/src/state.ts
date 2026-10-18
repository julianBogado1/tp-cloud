import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { ExcursionState } from '@snowball/shared';
import { NAMES } from '@snowball/shared';

/**
 * Excursion state per unit, persisted in DynamoDB as one item per unit with
 * the fixed sort key `_state` in the same telemetry table — it cannot collide
 * with readings because no ISO ts starts with an underscore.
 *
 * No in-memory cache: a warm Lambda container (or a second consumer) must not
 * act on stale state written by another invocation, so every read goes to
 * DynamoDB. At this volume the extra GetItem per message is negligible.
 */

const STATE_SK = '_state';
const TABLE = process.env.DDB_TABLE ?? NAMES.telemetryTable;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function getState(unitId: string): Promise<ExcursionState> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { unit_id: unitId, ts: STATE_SK } }),
  );
  return Item ? { phase: Item.phase, since: Item.since } : { phase: 'ok' };
}

export async function saveState(unitId: string, state: ExcursionState): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { unit_id: unitId, ts: STATE_SK, phase: state.phase, since: state.since },
    }),
  );
}
