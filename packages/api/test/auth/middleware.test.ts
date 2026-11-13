import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { authenticate, getAuth, requireRole } from '../../src/auth/middleware';
import { resolveAuth, signToken } from '../fixtures';

const operator = { id: 1, email: 'op@x', role: 'operator' as const, client_id: 1 };
const supervisor = { id: 2, email: 'sup@x', role: 'supervisor' as const, client_id: 1 };
const admin = { id: 3, email: 'adm@x', role: 'admin' as const, client_id: null };

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.get('/open', (_req, res) => res.json({ ok: true }));
  app.get('/any', authenticate(resolveAuth), (_req, res) => res.json(getAuth(res)));
  app.get('/sup', authenticate(resolveAuth), requireRole('supervisor'), (_req, res) => res.json({ ok: true }));
  app.get('/adm', authenticate(resolveAuth), requireRole('admin'), (_req, res) => res.json({ ok: true }));
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
  test('401 without a token, with a malformed header, and when the resolver rejects', async () => {
    expect((await get('/any')).status).toBe(401);
    expect((await fetch(`${base}/any`, { headers: { Authorization: 'Basic abc' } })).status).toBe(401);
    const res = await get('/any', 'garbage');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  test('a valid token yields the AuthContext', async () => {
    const res = await get('/any', signToken(operator));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 1, email: 'op@x', role: 'operator', clientId: 1 });
  });
});

describe('requireRole', () => {
  test('403 below the minimum, 200 at or above', async () => {
    expect((await get('/sup', signToken(operator))).status).toBe(403);
    expect((await get('/sup', signToken(supervisor))).status).toBe(200);
    expect((await get('/sup', signToken(admin))).status).toBe(200);
    expect((await get('/adm', signToken(supervisor))).status).toBe(403);
    expect((await get('/adm', signToken(admin))).status).toBe(200);
    const res = await get('/adm', signToken(operator));
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });
});
