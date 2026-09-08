import { describe, expect, test, vi } from 'vitest';
import type { IngestedReading } from '@snowball/shared';
import type { AuthContext } from '../src/auth/scope';
import { createLiveConnectionHandler, createLiveFeed, type LiveConnectionSocket, type LiveSocket } from '../src/live';

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

const ALL: ReadonlySet<string> = new Set(['SB-001', 'SB-002', 'SB-003']);

/** Fake WebSocket for createLiveConnectionHandler: records sends/closes and lets tests fire events. */
function connSocket() {
  const sent: string[] = [];
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const fake = {
    sent,
    closed: undefined as { code: number; reason?: string } | undefined,
    send(payload: string) {
      sent.push(payload);
    },
    close(code?: number, reason?: string) {
      fake.closed = { code: code ?? 0, reason };
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(listener);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners[event] ?? []) listener(...args);
    },
  };
  return fake as unknown as LiveConnectionSocket & {
    sent: string[];
    closed?: { code: number; reason?: string };
    emit: (event: 'message' | 'close' | 'error', ...args: unknown[]) => void;
  };
}

/** Flushes the microtask queue plus one macrotask turn — enough for a resolved/rejected mock promise's .then/.catch to run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const AUTH: AuthContext = { userId: 1, email: 'operator@example.com', role: 'operator', clientId: 7 };

describe('createLiveFeed — scoped DynamoDB polling for the WebSocket feed', () => {
  test('a tick queries only watched units and pushes readings to subscribers', async () => {
    const query = vi.fn(async (unitId: string) => [reading(unitId, '2026-08-30T10:00:00Z')]);
    const feed = createLiveFeed(query);
    const a = socket();
    feed.subscribe(a, ['SB-001'], ALL);

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
    feed.subscribe(socket(), ['SB-001'], ALL);

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
    feed.subscribe(a, ['SB-001'], ALL);
    feed.subscribe(b, ['SB-001', 'SB-002'], ALL);
    feed.subscribe(c, ['SB-003'], ALL);

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
    feed.subscribe(a, ['SB-001'], ALL);
    feed.unsubscribe(a);

    await feed.tick();

    expect(query).not.toHaveBeenCalled();
  });

  test('re-subscribing replaces the previous unit set for that socket', async () => {
    const query = vi.fn(async (unitId: string) => [reading(unitId, '2026-08-30T10:00:00Z')]);
    const feed = createLiveFeed(query);
    const a = socket();
    feed.subscribe(a, ['SB-001'], ALL);
    feed.subscribe(a, ['SB-002'], ALL);

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
    feed.subscribe(broken, ['SB-001'], ALL);
    feed.subscribe(healthy, ['SB-001'], ALL);

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
    feed.subscribe(a, ['SB-001', 'SB-002'], ALL);

    await expect(feed.tick()).resolves.toBeUndefined();
    expect(a.sent).toHaveLength(1);
    expect(JSON.parse(a.sent[0]).data.unit_id).toBe('SB-002');
  });

  test('subscribe keeps only allowed units and reports the accepted subset', async () => {
    const query = vi.fn(async (unitId: string) => [reading(unitId, '2026-08-30T10:00:00Z')]);
    const feed = createLiveFeed(query);
    const a = socket();
    const accepted = feed.subscribe(a, ['SB-001', 'SB-003', 'SB-999'], new Set(['SB-001']));
    expect(accepted).toEqual(['SB-001']);
    await feed.tick();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith('SB-001', undefined);
  });
});

describe('createLiveConnectionHandler — WS auth and scoping', () => {
  test('a missing token closes the socket with 4401', async () => {
    const verify = vi.fn((): AuthContext => {
      throw new Error('no token');
    });
    const listUnitIds = vi.fn(async () => []);
    const feed = createLiveFeed(async () => []);
    const handler = createLiveConnectionHandler({ verify, listUnitIds, feed });
    const s = connSocket();

    handler(s, { url: '/live' });
    await flush();

    expect(verify).toHaveBeenCalledWith('');
    expect(s.closed).toEqual({ code: 4401, reason: 'unauthorized' });
    expect(listUnitIds).not.toHaveBeenCalled();
  });

  test('an invalid token closes the socket with 4401', async () => {
    const verify = vi.fn((): AuthContext => {
      throw new Error('bad signature');
    });
    const listUnitIds = vi.fn(async () => []);
    const feed = createLiveFeed(async () => []);
    const handler = createLiveConnectionHandler({ verify, listUnitIds, feed });
    const s = connSocket();

    handler(s, { url: '/live?token=garbage' });
    await flush();

    expect(verify).toHaveBeenCalledWith('garbage');
    expect(s.closed).toEqual({ code: 4401, reason: 'unauthorized' });
  });

  test('a valid token sends ready, then a subscribe is intersected against the allowed set', async () => {
    const verify = vi.fn((): AuthContext => AUTH);
    const listUnitIds = vi.fn(async () => ['SB-001', 'SB-002']);
    const feed = createLiveFeed(async () => []);
    const handler = createLiveConnectionHandler({ verify, listUnitIds, feed });
    const s = connSocket();

    handler(s, { url: '/live?token=good' });
    await flush();

    expect(listUnitIds).toHaveBeenCalledWith(AUTH);
    expect(s.sent).toEqual([JSON.stringify({ type: 'ready' })]);
    expect(s.closed).toBeUndefined();

    s.emit('message', { toString: () => JSON.stringify({ subscribe: ['SB-001', 'SB-003'] }) });

    expect(s.sent[1]).toEqual(JSON.stringify({ type: 'subscribed', units: ['SB-001'] }));
  });

  test('a listUnitIds rejection closes the socket with 1011', async () => {
    const verify = vi.fn((): AuthContext => AUTH);
    const listUnitIds = vi.fn(async () => {
      throw new Error('rds down');
    });
    const feed = createLiveFeed(async () => []);
    const handler = createLiveConnectionHandler({ verify, listUnitIds, feed });
    const s = connSocket();

    handler(s, { url: '/live?token=good' });
    await flush();

    expect(s.closed).toEqual({ code: 1011, reason: 'internal error' });
    expect(s.sent).toHaveLength(0);
  });
});
