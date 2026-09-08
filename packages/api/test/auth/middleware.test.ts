import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { signToken } from '../../src/auth/jwt';
import { authenticate, getAuth, loginRateLimit, requireRole } from '../../src/auth/middleware';

const secret = 's'.repeat(32);
const operator = { id: 1, email: 'op@x', role: 'operator' as const, client_id: 1 };
const supervisor = { id: 2, email: 'sup@x', role: 'supervisor' as const, client_id: 1 };
const admin = { id: 3, email: 'adm@x', role: 'admin' as const, client_id: null };

let server: Server;
let base: string;
let clock = 0;

beforeAll(async () => {
  const app = express();
  app.get('/open', (_req, res) => res.json({ ok: true }));
  app.get('/any', authenticate(secret), (_req, res) => res.json(getAuth(res)));
  app.get('/sup', authenticate(secret), requireRole('supervisor'), (_req, res) => res.json({ ok: true }));
  app.get('/adm', authenticate(secret), requireRole('admin'), (_req, res) => res.json({ ok: true }));
  app.post('/login', loginRateLimit({ max: 2, windowMs: 60_000, now: () => clock }), (_req, res) => res.json({ ok: true }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function get(path: string, token?: string) {
  return fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

describe('authenticate', () => {
  test('401 without a token, with a malformed header, with garbage, with an expired token', async () => {
    expect((await get('/any')).status).toBe(401);
    expect((await fetch(`${base}/any`, { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
    expect((await get('/any', 'garbage')).status).toBe(401);
    const expired = signToken(operator, secret, Math.floor(Date.now() / 1000) - 9 * 3600);
    const res = await get('/any', expired);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('a valid token yields the AuthContext', async () => {
    const res = await get('/any', signToken(operator, secret));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 1, email: 'op@x', role: 'operator', clientId: 1 });
  });
});

describe('requireRole', () => {
  test('403 below the minimum, 200 at or above', async () => {
    expect((await get('/sup', signToken(operator, secret))).status).toBe(403);
    expect((await get('/sup', signToken(supervisor, secret))).status).toBe(200);
    expect((await get('/sup', signToken(admin, secret))).status).toBe(200);
    expect((await get('/adm', signToken(supervisor, secret))).status).toBe(403);
    expect((await get('/adm', signToken(admin, secret))).status).toBe(200);
    const res = await get('/adm', signToken(operator, secret));
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });
});

describe('loginRateLimit', () => {
  test('allows max attempts per window per IP, then 429, then resets', async () => {
    clock = 0;
    expect((await fetch(`${base}/login`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${base}/login`, { method: 'POST' })).status).toBe(200);
    const blocked = await fetch(`${base}/login`, { method: 'POST' });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: 'too many attempts, retry later' });
    clock = 61_000;
    expect((await fetch(`${base}/login`, { method: 'POST' })).status).toBe(200);
  });
});
