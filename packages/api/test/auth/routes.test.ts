import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { hashPassword } from '../../src/auth/password';
import { createAuthRouter } from '../../src/auth/routes';
import { verifyToken } from '../../src/auth/jwt';
import type { UserRecord } from '../../src/data-access';

const secret = 's'.repeat(32);
let users: UserRecord[];
let server: Server;
let base: string;

beforeAll(async () => {
  users = [
    { id: 2, email: 'sup@x', role: 'supervisor', client_id: 1, active: true, password_hash: await hashPassword('sup-pass') },
    { id: 5, email: 'off@x', role: 'operator', client_id: 1, active: false, password_hash: await hashPassword('off-pass') },
  ];
  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter({ findUserByEmail: async (e) => users.find((u) => u.email === e) }, secret));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/auth`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function login(body: unknown) {
  return fetch(`${base}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

describe('POST /auth/login', () => {
  test('returns a token and the user on valid credentials', async () => {
    const res = await login({ email: 'sup@x', password: 'sup-pass' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user).toEqual({ id: 2, email: 'sup@x', role: 'supervisor', client_id: 1 });
    expect(verifyToken(body.token, secret)).toEqual({ userId: 2, email: 'sup@x', role: 'supervisor', clientId: 1 });
  });

  test('same 401 for unknown email, wrong password and inactive user', async () => {
    for (const body of [
      { email: 'nobody@x', password: 'whatever' },
      { email: 'sup@x', password: 'nope' },
      { email: 'off@x', password: 'off-pass' },
    ]) {
      const res = await login(body);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'invalid credentials' });
    }
  });

  test('400 on a malformed body', async () => {
    expect((await login({ email: 'sup@x' })).status).toBe(400);
    expect((await login({ email: 1, password: 2 })).status).toBe(400);
  });
});

describe('GET /auth/me', () => {
  test('returns the context for a valid token, 401 otherwise', async () => {
    const { token } = await (await login({ email: 'sup@x', password: 'sup-pass' })).json();
    const res = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await res.json()).toEqual({ userId: 2, email: 'sup@x', role: 'supervisor', clientId: 1 });
    expect((await fetch(`${base}/me`)).status).toBe(401);
  });
});
