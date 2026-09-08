import { createServer } from 'http';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import { WebSocketServer } from 'ws';
import { envAsNumber } from '@snowball/shared';
import { loadJwtSecret, verifyToken } from './auth/jwt';
import { authenticate } from './auth/middleware';
import { createAuthRouter } from './auth/routes';
import { scopeOf } from './auth/scope';
import { createConfigRouter } from './config-routes';
import { closePool, dataAccess, queryNewReadings } from './data';
import { createLiveConnectionHandler, createLiveFeed } from './live';
import { createRouter, notFound } from './routes';
import { createIotShadowClient } from './shadow';
import { createUsersRouter } from './users-routes';

/**
 * Snowball API: REST + WebSocket for the static dashboard. Stateless —
 * everything served comes from DynamoDB/RDS; the live feed's lastSeen map is
 * a disposable cursor and the login rate limiter is per instance.
 *
 * Environment variables: see .env.example.
 *
 * WebSocket protocol (path /live?token=<jwt>):
 *   token invalid            → server closes with 4401
 *   client sends { "subscribe": ["SB-001", "SB-002"] }  (replaces previous set,
 *                                                       filtered to the caller's units)
 *   server replies { "type": "subscribed", "units": [...] }
 *   server pushes  { "type": "reading", "data": IngestedReading }
 */

const PORT = envAsNumber('PORT', 3000);
const LIVE_POLL_MS = envAsNumber('LIVE_POLL_MS', 3000);
const JWT_SECRET = loadJwtSecret();
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';
const IOT_ENDPOINT = process.env.IOT_ENDPOINT;

const shadow = IOT_ENDPOINT ? createIotShadowClient(IOT_ENDPOINT) : undefined;
if (!shadow) console.warn('IOT_ENDPOINT not set: shadow routes will answer 503');

const app = express();
app.use(
  cors({
    origin: CORS_ORIGIN,
    methods: ['GET', 'POST', 'PUT', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }),
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});
app.use('/auth', createAuthRouter(dataAccess, JWT_SECRET));
// One authenticate() for every /api router; the routers themselves only do role/scope checks.
app.use('/api', authenticate(JWT_SECRET));
app.use('/api', createRouter(dataAccess));
app.use('/api', createConfigRouter(dataAccess, shadow));
app.use('/api', createUsersRouter(dataAccess));
app.use('/api', notFound());

// Catch-all for anything outside /api (e.g. GET /), so the whole API answers
// { error: string } instead of Express's default HTML 404 page. The /api-scoped
// notFound() above already covers unmatched API routes; this covers the rest.
app.use((_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Terminal error handler: catches anything that reached here unhandled —
// notably express.json()'s SyntaxError on a malformed request body — and
// answers the plan's { error: string } shape instead of Express's default
// HTML-plus-stack-trace page. Must be mounted last, with 4 params so Express
// recognises it as an error handler.
const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const status = typeof err?.status === 'number' ? err.status : 500;
  if (status >= 500) {
    // Only 5xx gets the full error logged: a 4xx body-parse SyntaxError's
    // message embeds a snippet of the raw request body (e.g. a malformed
    // POST /auth/login could leak a password fragment into the logs).
    console.error('[api] unhandled request error:', err);
  } else {
    console.error(`[api] request error ${status} on ${req.method} ${req.path}`);
  }
  res.status(status).json({ error: status === 400 ? 'invalid request body' : 'internal error' });
};
app.use(errorHandler);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/live' });
const feed = createLiveFeed(queryNewReadings);

const handleLiveConnection = createLiveConnectionHandler({
  verify: (token) => verifyToken(token, JWT_SECRET),
  listUnitIds: (auth) => dataAccess.listUnitIds(scopeOf(auth)),
  feed,
});

wss.on('connection', handleLiveConnection);

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
  console.log(`API listening on :${PORT} (REST /api, auth /auth, WebSocket /live, poll ${LIVE_POLL_MS}ms)`);
});

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down…`);
  clearInterval(timer);
  // wss.close() does not close already-connected clients — Node's server.close()
  // waits for every open connection (an upgraded WebSocket included), so with a
  // dashboard attached the close callback below would never fire. Close the
  // clients first, and keep a hard deadline in case anything still hangs.
  for (const client of wss.clients) client.close(1001, 'shutting down');
  wss.close();
  server.close(() => {
    void closePool().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
