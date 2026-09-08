import { BatchGetCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { IngestedReading } from '@snowball/shared';

/**
 * Latest reading of many units from the current-state table in as few
 * round-trips as possible. DynamoDB caps BatchGetItem at 100 keys per call and
 * may hand some back as UnprocessedKeys under throttling: those are retried
 * once. Anything still unprocessed is left out of the map, and the caller
 * shows `last_reading: null` — the same as a unit that never reported.
 *
 * `send` is injected so this is unit-tested without AWS.
 */

const BATCH_LIMIT = 100;

export type BatchGetSend = (cmd: BatchGetCommand) => Promise<BatchGetCommandOutput>;

type Key = { unit_id: string };

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function batchGetAll(
  send: BatchGetSend,
  table: string,
  unitIds: readonly string[],
): Promise<Map<string, IngestedReading>> {
  const found = new Map<string, IngestedReading>();
  const unique = [...new Set(unitIds)];
  if (unique.length === 0) return found;

  async function fetchKeys(keys: Key[]): Promise<Key[]> {
    const out = await send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }));
    for (const item of out.Responses?.[table] ?? []) {
      const reading = item as IngestedReading;
      found.set(reading.unit_id, reading);
    }
    return (out.UnprocessedKeys?.[table]?.Keys ?? []) as Key[];
  }

  const unprocessed: Key[] = [];
  for (const ids of chunk(unique, BATCH_LIMIT)) {
    unprocessed.push(...(await fetchKeys(ids.map((unit_id) => ({ unit_id })))));
  }
  for (const keys of chunk(unprocessed, BATCH_LIMIT)) {
    await fetchKeys(keys);
  }
  return found;
}
