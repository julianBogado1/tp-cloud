import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { authenticate } from '../src/auth/middleware';
import { createRouter } from '../src/routes';
import { createUsersRouter } from '../src/users-routes';
import { fakeData, fakeDirectory, resolveAuth, signToken, userRecords } from './fixtures';

const admin = signToken({ id: 3, email: 'adm@x', role: 'admin', client_id: null });
const supervisor = signToken({ id: 2, email: 'sup@x', role: 'supervisor', client_id: 1 });

const directory = fakeDirectory();
let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', authenticate(resolveAuth));
  app.use('/api', createRouter(fakeData));
  app.use('/api', createUsersRouter(fakeData, directory));
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

  test('GET lists users without passwords', async () => {
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

  test('POST creates the Cognito account and the row, lowercasing the email; duplicate is 409', async () => {
    const res = await call('POST', '', admin, { email: 'New@X', password: 'longenough', role: 'supervisor', client_id: 2 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ id: body.id, email: 'new@x', role: 'supervisor', client_id: 2, active: true });
    expect(directory.accounts.get('new@x')).toEqual({ password: 'longenough', enabled: true });
    expect(JSON.stringify(userRecords)).not.toContain('longenough');
    expect((await call('POST', '', admin, { email: 'new@x', password: 'longenough', role: 'supervisor', client_id: 2 })).status).toBe(409);
  });

  test('POST rejected by the directory leaves no row behind', async () => {
    const rejecting = { ...fakeDirectory(), create: async () => { const { DirectoryError } = await import('../src/auth/user-directory'); throw new DirectoryError('invalid-password', 'too weak'); } };
    const app = express();
    app.use(express.json());
    app.use('/api', authenticate(resolveAuth));
    app.use('/api', createUsersRouter(fakeData, rejecting));
    const s = createServer(app);
    await new Promise<void>((resolve) => s.listen(0, resolve));
    const port = (s.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/users`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'weak@x', password: 'longenough', role: 'operator', client_id: 1 }),
    });
    await new Promise<void>((resolve) => s.close(() => resolve()));
    expect(res.status).toBe(400);
    expect(userRecords.some((u) => u.email === 'weak@x')).toBe(false);
  });

  test('PATCH updates active/role/client, keeps the invariant, 404 unknown', async () => {
    directory.accounts.set('op@x', { password: 'x', enabled: true });
    expect((await call('PATCH', '/1', admin, { active: false })).status).toBe(200);
    expect(userRecords.find((u) => u.id === 1)!.active).toBe(false);
    expect(directory.accounts.get('op@x')!.enabled).toBe(false);
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
