import type { IngestedReading } from '@snowball/shared';
import type { AuthContext } from './auth/scope';

/**
 * Live feed for the dashboard WebSocket. Instead of consuming the ingest
 * queue (which belongs exclusively to the alert processor — SQS consumers
 * compete for messages), each API instance polls DynamoDB scoped to the
 * units its connected clients are watching: Query(unit_id, ts > lastSeen)
 * every LIVE_POLL_MS. A missed poll is harmless — the next one returns the
 * backlog — so nothing here needs to survive a restart.
 */

export interface LiveSocket {
  send(payload: string): void;
}

export type QueryNewReadings = (
  unitId: string,
  sinceTs: string | undefined,
) => Promise<IngestedReading[]>;

export function createLiveFeed(queryNewReadings: QueryNewReadings) {
  const subscriptions = new Map<LiveSocket, Set<string>>();
  const lastSeen = new Map<string, string>();

  /** Replaces the socket's set with the allowed subset and returns it. */
  function subscribe(socket: LiveSocket, unitIds: string[], allowed: ReadonlySet<string>): string[] {
    const accepted = unitIds.filter((u) => allowed.has(u));
    subscriptions.set(socket, new Set(accepted));
    return accepted;
  }

  function unsubscribe(socket: LiveSocket): void {
    subscriptions.delete(socket);
  }

  function watchedBy(unitId: string): number {
    let count = 0;
    for (const units of subscriptions.values()) if (units.has(unitId)) count++;
    return count;
  }

  function watchedUnits(): Set<string> {
    const units = new Set<string>();
    for (const set of subscriptions.values()) for (const unit of set) units.add(unit);
    return units;
  }

  function broadcast(unitId: string, payload: string): void {
    for (const [socket, units] of subscriptions) {
      if (!units.has(unitId)) continue;
      try {
        socket.send(payload);
      } catch {
        subscriptions.delete(socket);
      }
    }
  }

  async function tick(): Promise<void> {
    for (const unitId of watchedUnits()) {
      let readings: IngestedReading[];
      try {
        readings = await queryNewReadings(unitId, lastSeen.get(unitId));
      } catch (err) {
        console.error(`[live] query failed for ${unitId}:`, err);
        continue;
      }
      for (const reading of readings) {
        broadcast(unitId, JSON.stringify({ type: 'reading', data: reading }));
        const seen = lastSeen.get(unitId);
        if (!seen || reading.ts > seen) lastSeen.set(unitId, reading.ts);
      }
    }
  }

  return { subscribe, unsubscribe, watchedBy, tick };
}

export type LiveFeed = ReturnType<typeof createLiveFeed>;

/**
 * The subset of a `ws` WebSocket the connection handler needs. Kept minimal
 * so the fake socket in test/live.test.ts can implement it without pulling
 * in the real `ws` types.
 */
export interface LiveConnectionSocket extends LiveSocket {
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: { toString(): string }) => void): void;
  on(event: 'close' | 'error', listener: () => void): void;
}

export interface LiveConnectionDeps {
  /** Verifies the token from the query string; throws on any problem. */
  verify: (token: string) => AuthContext;
  /** Resolves the caller's allowed unit ids (already scope-checked). */
  listUnitIds: (auth: AuthContext) => Promise<string[]>;
  feed: Pick<LiveFeed, 'subscribe' | 'unsubscribe'>;
}

/**
 * WebSocket connection handler for the /live feed, extracted from index.ts
 * so the protocol (4401 on bad token, ready-after-attach, subscribe
 * intersection) is unit-testable against a fake socket instead of only
 * readable in the composition root. Behaviour is unchanged from the inline
 * version: same close codes, same message shapes, same ordering.
 */
export function createLiveConnectionHandler(deps: LiveConnectionDeps) {
  return function handleLiveConnection(socket: LiveConnectionSocket, req: { url?: string }): void {
    const token = new URL(req.url ?? '/', 'http://localhost').searchParams.get('token');
    let auth: AuthContext;
    try {
      auth = deps.verify(token ?? '');
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }

    deps
      .listUnitIds(auth)
      .then((ids) => {
        const allowed: ReadonlySet<string> = new Set(ids);
        socket.on('message', (raw) => {
          let msg: unknown;
          try {
            msg = JSON.parse(raw.toString());
          } catch {
            socket.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }));
            return;
          }
          const units = (msg as { subscribe?: unknown }).subscribe;
          if (Array.isArray(units) && units.every((u) => typeof u === 'string')) {
            const accepted = deps.feed.subscribe(socket, units, allowed);
            socket.send(JSON.stringify({ type: 'subscribed', units: accepted }));
          } else {
            socket.send(JSON.stringify({ type: 'error', error: 'expected { subscribe: string[] }' }));
          }
        });
        socket.send(JSON.stringify({ type: 'ready' }));
      })
      .catch((err) => {
        console.error('[live] could not resolve allowed units:', err);
        socket.close(1011, 'internal error');
      });

    socket.on('close', () => deps.feed.unsubscribe(socket));
    socket.on('error', () => deps.feed.unsubscribe(socket));
  };
}
