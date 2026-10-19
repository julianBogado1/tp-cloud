import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SignalPhase, SignalState } from '@snowball/shared';
import { NAMES } from '@snowball/shared';

/**
 * No-signal state per unit: one item in the telemetry table under the fixed
 * sort key `_signal`, the same trick `state.ts` uses for `_state` and safe for
 * the same reason. No in-memory cache either, also for the reason given there:
 * the previous minute's sweep must not be read from a warm container.
 */

const SIGNAL_SK = '_signal';
const TABLE = process.env.DDB_TABLE ?? NAMES.telemetryTable;
/** DynamoDB caps BatchGetItem at 100 keys per call. */
const BATCH_LIMIT = 100;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export async function getSignalState(unitId: string): Promise<SignalState> {
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { unit_id: unitId, ts: SIGNAL_SK } }),
  );
  return Item ? toSignalState(Item) : { phase: 'ok' };
}

/**
 * Absent fields are omitted, not written as `undefined`: the document client
 * rejects undefined values, and an `ok` state carries neither field.
 */
export async function saveSignalState(unitId: string, state: SignalState): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        unit_id: unitId,
        ts: SIGNAL_SK,
        phase: state.phase,
        ...(state.since === undefined ? {} : { since: state.since }),
        ...(state.observed_at === undefined ? {} : { observed_at: state.observed_at }),
      },
    }),
  );
}

/** The `_signal` items of many units; a unit with no item defaults to `ok`. */
export async function batchGetSignalStates(
  unitIds: readonly string[],
): Promise<Map<string, SignalState>> {
  const keys = [...new Set(unitIds)].map((unit_id) => ({ unit_id, ts: SIGNAL_SK }));
  const states = new Map<string, SignalState>();
  for (const item of await batchGetItems(TABLE, keys)) {
    states.set(String(item.unit_id), toSignalState(item));
  }
  return states;
}

/**
 * Chunked multi-get, retrying UnprocessedKeys once. Keys still unprocessed are
 * left out and the sweep reads them as "never reported", so throttling can
 * delay a detection but never corrupt one.
 *
 * Replicates `batchGetAll` in packages/api/src/batch-get.ts instead of
 * importing it: @snowball/api is not a dependency here and bundles an HTTP
 * server this Lambda has no use for.
 */
export async function batchGetItems(
  table: string,
  keys: readonly Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  if (keys.length === 0) return [];
  const found: Record<string, unknown>[] = [];

  async function fetchKeys(batch: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const out = await ddb.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: batch } } }));
    found.push(...((out.Responses?.[table] ?? []) as Record<string, unknown>[]));
    return (out.UnprocessedKeys?.[table]?.Keys ?? []) as Record<string, unknown>[];
  }

  const unprocessed: Record<string, unknown>[] = [];
  for (const batch of chunk(keys, BATCH_LIMIT)) {
    unprocessed.push(...(await fetchKeys(batch)));
  }
  for (const batch of chunk(unprocessed, BATCH_LIMIT)) {
    await fetchKeys(batch);
  }
  return found;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function toSignalState(item: Record<string, unknown>): SignalState {
  return {
    phase: item.phase as SignalPhase,
    ...(item.since === undefined ? {} : { since: String(item.since) }),
    ...(item.observed_at === undefined ? {} : { observed_at: String(item.observed_at) }),
  };
}
