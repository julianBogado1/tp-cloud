import { describe, expect, test, vi } from 'vitest';
import type { IngestedReading } from '@snowball/shared';
import { createLiveFeed, type LiveSocket } from '../src/live';

function reading(unitId: string, ts: string, tempC = -18): IngestedReading {
  return {
    unit_id: unitId,
    ts,
    temp_c: tempC,
    humidity_pct: 60,
    lat: -34.6,
    lon: -58.4,
    battery: 90,
    signal: 4,
    expires_at: 0,
  };
}

function socket(): LiveSocket & { sent: string[] } {
  const sent: string[] = [];
  return { sent, send: (payload: string) => sent.push(payload) };
}

describe('createLiveFeed — scoped DynamoDB polling for the WebSocket feed', () => {
  test('a tick queries only watched units and pushes readings to subscribers', async () => {
    const query = vi.fn(async (unitId: string) => [reading(unitId, '2026-08-30T10:00:00Z')]);
    const feed = createLiveFeed(query);
    const a = socket();
    feed.subscribe(a, ['SB-001']);

    await feed.tick();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SB-001', undefined);
    expect(a.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0])).toEqual({ type: 'reading', data: reading('SB-001', '2026-08-30T10:00:00Z') });
  });

  test('the next tick queries from the last ts seen', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([reading('SB-001', '2026-08-30T10:00:00Z'), reading('SB-001', '2026-08-30T10:00:05Z')])
      .mockResolvedValueOnce([]);
    const feed = createLiveFeed(query);
    feed.subscribe(socket(), ['SB-001']);

    await feed.tick();
    await feed.tick();

    expect(query).toHaveBeenLastCalledWith('SB-001', '2026-08-30T10:00:05Z');
  });

  test('a reading reaches every socket subscribed to that unit and no other', async () => {
    const query = vi.fn(async (unitId: string) => [reading(unitId, '2026-08-30T10:00:00Z')]);
    const feed = createLiveFeed(query);
    const a = socket();
    const b = socket();
    const c = socket();
    feed.subscribe(a, ['SB-001']);
    feed.subscribe(b, ['SB-001', 'SB-002']);
    feed.subscribe(c, ['SB-003']);

    await feed.tick();

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(2);
    expect(c.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0]).data.unit_id).toBe('SB-001');
    expect(JSON.parse(c.sent[0]).data.unit_id).toBe('SB-003');
  });

  test('a unit nobody watches is not queried', async () => {
    const query = vi.fn(async () => []);
    const feed = createLiveFeed(query);
    const a = socket();
    feed.subscribe(a, ['SB-001']);
    feed.unsubscribe(a);

    await feed.tick();

    expect(query).not.toHaveBeenCalled();
  });

  test('re-subscribing replaces the previous unit set for that socket', async () => {
    const query = vi.fn(async (unitId: string) => [reading(unitId, '2026-08-30T10:00:00Z')]);
    const feed = createLiveFeed(query);
    const a = socket();
    feed.subscribe(a, ['SB-001']);
    feed.subscribe(a, ['SB-002']);

    await feed.tick();

    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.parse(a.sent[0]).data.unit_id).toBe('SB-002');
  });

  test('a socket whose send throws is dropped without breaking the tick', async () => {
    const query = vi.fn(async (unitId: string, sinceTs: string | undefined) =>
      sinceTs ? [] : [reading(unitId, '2026-08-30T10:00:00Z')],
    );
    const feed = createLiveFeed(query);
    const broken: LiveSocket = {
      send: () => {
        throw new Error('closed');
      },
    };
    const healthy = socket();
    feed.subscribe(broken, ['SB-001']);
    feed.subscribe(healthy, ['SB-001']);

    await feed.tick();
    await feed.tick();

    expect(healthy.sent).toHaveLength(1);
    expect(feed.watchedBy('SB-001')).toBe(1);
  });

  test('a failing query for one unit does not stop the others', async () => {
    const query = vi.fn(async (unitId: string) => {
      if (unitId === 'SB-001') throw new Error('dynamo down');
      return [reading(unitId, '2026-08-30T10:00:00Z')];
    });
    const feed = createLiveFeed(query);
    const a = socket();
    feed.subscribe(a, ['SB-001', 'SB-002']);

    await expect(feed.tick()).resolves.toBeUndefined();
    expect(a.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0]).data.unit_id).toBe('SB-002');
  });
});
