import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { signToken } from '../src/auth/jwt';
import { authenticate } from '../src/auth/middleware';
import { createRouter, notFound } from '../src/routes';
import { fakeData, secret, strip, telemetry, units } from './fixtures';

const adminToken = signToken({ id: 3, email: 'adm@x', role: 'admin', client_id: null }, secret);
const client1Token = signToken({ id: 1, email: 'op@x', role: 'operator', client_id: 1 }, secret);
const client2Token = signToken({ id: 9, email: 'op2@x', role: 'operator', client_id: 2 }, secret);
const supervisor1Token = signToken({ id: 2, email: 'sup@x', role: 'supervisor', client_id: 1 }, secret);

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/api', authenticate(secret));
  app.use('/api', createRouter(fakeData));
  app.use('/api', notFound());
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/api`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function get(path: string, token = adminToken) {
  return fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

describe('REST read routes', () => {
  test('every route is 401 without a token', async () => {
    expect((await fetch(`${base}/units`)).status).toBe(401);
    expect((await fetch(`${base}/alerts`)).status).toBe(401);
  });

  test('GET /units for admin returns every unit with config and latest reading', async () => {
    const res = await get('/units');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { ...strip(units[0]), last_reading: telemetry[0] },
      { ...strip(units[1]), last_reading: null },
    ]);
  });

  test('GET /units for an operator is limited to their client', async () => {
    const body = await (await get('/units', client2Token)).json();
    expect(body.map((u: { unit_id: string }) => u.unit_id)).toEqual(['SB-003']);
  });

  test('GET /units/:id/telemetry returns readings inside scope and 404 outside', async () => {
    expect(await (await get('/units/SB-001/telemetry?limit=10', client1Token)).json()).toEqual(telemetry);
    const foreign = await get('/units/SB-001/telemetry?limit=10', client2Token);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not found' });
  });

  test('GET /units/:id/telemetry with a bad param is a 400, not a crash', async () => {
    const res = await get('/units/SB-001/telemetry?limit=abc');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/limit/);
  });

  test('GET /alerts is scoped', async () => {
    expect((await (await get('/alerts')).json()).map((a: { id: number }) => a.id)).toEqual([1, 2]);
    expect((await (await get('/alerts', client1Token)).json()).map((a: { id: number }) => a.id)).toEqual([1]);
  });

  test('unknown routes are 404 JSON', async () => {
    expect((await get('/nope')).status).toBe(404);
  });

  test('GET /alerts?limit=-5 does not reach Postgres with a negative LIMIT', async () => {
    // fakeData.listAlerts ignores its limit argument, so this only proves the negative
    // value no longer 500s the route — it does not check what limit was actually passed.
    expect((await get('/alerts?limit=-5')).status).toBe(200);
  });
});

describe('POST /alerts/:id/ack', () => {
  const post = (path: string, token: string) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });

  test('operator is 403', async () => {
    expect((await post('/alerts/1/ack', client1Token)).status).toBe(403);
  });

  test('supervisor of another client gets 404', async () => {
    expect((await post('/alerts/2/ack', supervisor1Token)).status).toBe(404);
  });

  test('supervisor acknowledges their own alert, second time is 409', async () => {
    const res = await post('/alerts/1/ack', supervisor1Token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.acknowledged_by).toBe(2);
    expect(body.acknowledged_at).toBe('2026-08-30T10:00:00Z');
    const again = await post('/alerts/1/ack', supervisor1Token);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'already acknowledged' });
  });

  test('non-numeric id is 400', async () => {
    expect((await post('/alerts/abc/ack', adminToken)).status).toBe(400);
  });
});
