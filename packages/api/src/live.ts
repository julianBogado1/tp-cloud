import type { IngestedReading } from '@snowball/shared';

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

  function subscribe(socket: LiveSocket, unitIds: string[]): void {
    subscriptions.set(socket, new Set(unitIds));
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
