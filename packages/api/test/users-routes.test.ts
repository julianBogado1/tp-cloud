import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { signToken } from '../src/auth/jwt';
import { authenticate } from '../src/auth/middleware';
import { verifyPassword } from '../src/auth/password';
import { createRouter } from '../src/routes';
import { createUsersRouter } from '../src/users-routes';
import { fakeData, secret, userRecords } from './fixtures';

const admin = signToken({ id: 3, email: 'adm@x', role: 'admin', client_id: null }, secret);
const supervisor = signToken({ id: 2, email: 'sup@x', role: 'supervisor', client_id: 1 }, secret);

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', authenticate(secret));
  app.use('/api', createRouter(fakeData));
  app.use('/api', createUsersRouter(fakeData));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/api/users`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function call(method: string, path: string, token: string, body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('users routes', () => {
  test('supervisor is 403 on every route', async () => {
    expect((await call('GET', '', supervisor)).status).toBe(403);
    expect((await call('POST', '', supervisor, {})).status).toBe(403);
    expect((await call('PATCH', '/1', supervisor, {})).status).toBe(403);
  });

  test('GET lists users without hashes', async () => {
    const res = await call('GET', '', admin);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0]).toEqual({ id: 1, email: 'op@x', role: 'operator', client_id: 1, active: true });
    expect(JSON.stringify(body)).not.toContain('password');
  });

  test('POST validates: short password, bad role, missing client for operator, client for admin, unknown client', async () => {
    const bad = [
      { email: 'a@x', password: 'short', role: 'operator', client_id: 1 },
      { email: 'a@x', password: 'longenough', role: 'root', client_id: 1 },
      { email: 'a@x', password: 'longenough', role: 'operator', client_id: null },
      { email: 'a@x', password: 'longenough', role: 'admin', client_id: 1 },
      { email: 'a@x', password: 'longenough', role: 'operator', client_id: 99 },
      { email: 'not-an-email', password: 'longenough', role: 'operator', client_id: 1 },
    ];
    for (const body of bad) expect((await call('POST', '', admin, body)).status).toBe(400);
  });

  test('POST creates a user with a bcrypt hash and lowercases the email; duplicate is 409', async () => {
    const res = await call('POST', '', admin, { email: 'New@X', password: 'longenough', role: 'supervisor', client_id: 2 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ id: body.id, email: 'new@x', role: 'supervisor', client_id: 2, active: true });
    const stored = userRecords.find((u) => u.id === body.id)!;
    expect(await verifyPassword('longenough', stored.password_hash)).toBe(true);
    expect((await call('POST', '', admin, { email: 'new@x', password: 'longenough', role: 'supervisor', client_id: 2 })).status).toBe(409);
  });

  test('PATCH updates active/role/client, keeps the invariant, 404 unknown', async () => {
    expect((await call('PATCH', '/1', admin, { active: false })).status).toBe(200);
    expect(userRecords.find((u) => u.id === 1)!.active).toBe(false);
    expect((await call('PATCH', '/1', admin, { role: 'admin' })).status).toBe(400); // still has client 1
    expect((await call('PATCH', '/1', admin, { role: 'admin', client_id: null })).status).toBe(200);
    expect((await call('PATCH', '/999', admin, { active: true })).status).toBe(404);
    expect((await call('PATCH', '/abc', admin, { active: true })).status).toBe(400);
  });

  test('admin cannot deactivate or demote themselves', async () => {
    expect((await call('PATCH', '/3', admin, { active: false })).status).toBe(400);
    expect((await call('PATCH', '/3', admin, { role: 'supervisor', client_id: 1 })).status).toBe(400);
  });
});
