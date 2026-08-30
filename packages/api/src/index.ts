import { createServer } from 'http';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { envAsNumber } from '@snowball/shared';
import { closePool, dataAccess, queryNewReadings } from './data';
import { createLiveFeed } from './live';
import { createRouter } from './routes';

/**
 * Snowball read API: REST + WebSocket for the static dashboard. Stateless —
 * everything served comes from DynamoDB/RDS; the live feed's lastSeen map is
 * a disposable cursor.
 *
 * Environment variables:
 *   PORT           (default 3000)
 *   LIVE_POLL_MS   (default 3000) — live-feed polling interval
 *   DDB_TABLE      (default snowball-telemetry)
 *   PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD for RDS
 *
 * WebSocket protocol (path /live):
 *   client sends { "subscribe": ["SB-001", "SB-002"] }  (replaces previous set)
 *   server pushes { "type": "reading", "data": IngestedReading }
 */

const PORT = envAsNumber('PORT', 3000);
const LIVE_POLL_MS = envAsNumber('LIVE_POLL_MS', 3000);

const app = express();

// The dashboard is served from an S3 origin, not from this ALB — allow it.
app.use((_req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/api', createRouter(dataAccess));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });
const feed = createLiveFeed(queryNewReadings);

wss.on('connection', (socket: WebSocket) => {
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
      feed.subscribe(socket, units);
      socket.send(JSON.stringify({ type: 'subscribed', units }));
    } else {
      socket.send(JSON.stringify({ type: 'error', error: 'expected { subscribe: string[] }' }));
    }
  });
  socket.on('close', () => feed.unsubscribe(socket));
  socket.on('error', () => feed.unsubscribe(socket));
});

let polling = false;
const timer = setInterval(() => {
  if (polling) return; // skip a beat rather than overlap slow ticks
  polling = true;
  feed
    .tick()
    .catch((err) => console.error('[live] tick failed:', err))
    .finally(() => {
      polling = false;
    });
}, LIVE_POLL_MS);

server.listen(PORT, () => {
  console.log(`API listening on :${PORT} (REST /api, WebSocket /live, poll ${LIVE_POLL_MS}ms)`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down…`);
  clearInterval(timer);
  wss.close();
  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
