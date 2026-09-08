import { describe, expect, test } from 'vitest';
import { BatchGetCommand, type BatchGetCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { IngestedReading } from '@snowball/shared';
import { batchGetAll, chunk } from '../src/batch-get';

const TABLE = 'snowball-unit-state';

function reading(unitId: string): IngestedReading {
  return { unit_id: unitId, ts: '2026-09-06T10:00:00.000Z', temp_c: -18, humidity_pct: 60, lat: -34.6, lon: -58.4, battery: 90, signal: 4, expires_at: 0 };
}

function keysOf(cmd: BatchGetCommand): string[] {
  return (cmd.input.RequestItems![TABLE].Keys as { unit_id: string }[]).map((key) => key.unit_id);
}

function fakeSend(known: string[], unprocessedOnce: string[] = []) {
  const calls: BatchGetCommand[] = [];
  const pending = new Set(unprocessedOnce);
  const send = async (cmd: BatchGetCommand): Promise<BatchGetCommandOutput> => {
    calls.push(cmd);
    const asked = keysOf(cmd);
    const unprocessed = asked.filter((id) => pending.has(id));
    for (const id of unprocessed) pending.delete(id);
    const answered = asked.filter((id) => !unprocessed.includes(id) && known.includes(id));
    return {
      $metadata: {},
      Responses: { [TABLE]: answered.map(reading) },
      UnprocessedKeys: unprocessed.length ? { [TABLE]: { Keys: unprocessed.map((unit_id) => ({ unit_id })) } } : {},
    };
  };
  return { send, calls };
}

describe('chunk', () => {
  test('splits into fixed-size pieces with a shorter tail', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });
});

describe('batchGetAll — latest readings from the state table', () => {
  test('250 ids become 3 BatchGet calls of 100/100/50 and one map entry per found unit', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `SB-${String(i).padStart(3, '0')}`);
    const { send, calls } = fakeSend(ids.slice(0, 200));
    const found = await batchGetAll(send, TABLE, ids);
    expect(calls.map((call) => keysOf(call).length)).toEqual([100, 100, 50]);
    expect(found.size).toBe(200);
    expect(found.get('SB-000')).toEqual(reading('SB-000'));
    expect(found.has('SB-249')).toBe(false);
  });

  test('UnprocessedKeys are retried once and merged', async () => {
    const { send, calls } = fakeSend(['SB-001', 'SB-002', 'SB-003'], ['SB-002']);
    const found = await batchGetAll(send, TABLE, ['SB-001', 'SB-002', 'SB-003']);
    expect(calls).toHaveLength(2);
    expect(keysOf(calls[1])).toEqual(['SB-002']);
    expect([...found.keys()].sort()).toEqual(['SB-001', 'SB-002', 'SB-003']);
  });

  test('keys still unprocessed after the retry are simply absent', async () => {
    const { send, calls } = fakeSend(['SB-001'], ['SB-001']);
    let n = 0;
    const stubborn = async (cmd: BatchGetCommand): Promise<BatchGetCommandOutput> => {
      n += 1;
      if (n === 2) return { $metadata: {}, Responses: { [TABLE]: [] }, UnprocessedKeys: { [TABLE]: { Keys: [{ unit_id: 'SB-001' }] } } };
      return send(cmd);
    };
    const found = await batchGetAll(stubborn, TABLE, ['SB-001']);
    expect(n).toBe(2);
    expect(found.size).toBe(0);
    expect(calls).toHaveLength(1);
  });

  test('empty input makes no call; duplicate ids are asked once', async () => {
    const { send, calls } = fakeSend(['SB-001']);
    expect((await batchGetAll(send, TABLE, [])).size).toBe(0);
    expect(calls).toHaveLength(0);
    await batchGetAll(send, TABLE, ['SB-001', 'SB-001']);
    expect(keysOf(calls[0])).toEqual(['SB-001']);
  });
});
