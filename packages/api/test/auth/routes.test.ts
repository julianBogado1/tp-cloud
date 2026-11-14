import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { createAuthRouter } from '../../src/auth/routes';
import { resolveAuth, signToken } from '../fixtures';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/auth', createAuthRouter(resolveAuth));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/auth`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('GET /auth/me', () => {
  test('returns the context for a valid token, 401 otherwise', async () => {
    const token = signToken({ id: 2, email: 'sup@x', role: 'supervisor', client_id: 1 });
    const res = await fetch(`${base}/me`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await res.json()).toEqual({ userId: 2, email: 'sup@x', role: 'supervisor', clientId: 1 });
    expect((await fetch(`${base}/me`)).status).toBe(401);
    expect((await fetch(`${base}/me`, { headers: { Authorization: 'Bearer garbage' } })).status).toBe(401);
  });

  test('POST /auth/login is gone: login happens in the Cognito Hosted UI', async () => {
    const res = await fetch(`${base}/login`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
