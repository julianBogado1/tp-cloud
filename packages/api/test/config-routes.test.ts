import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { signToken } from '../src/auth/jwt';
import { authenticate } from '../src/auth/middleware';
import { createConfigRouter } from '../src/config-routes';
import { createRouter } from '../src/routes';
import type { ShadowClient } from '../src/shadow';
import { configs, fakeData, secret } from './fixtures';

const supervisor1 = signToken({ id: 2, email: 'sup@x', role: 'supervisor', client_id: 1 }, secret);
const operator1 = signToken({ id: 1, email: 'op@x', role: 'operator', client_id: 1 }, secret);

const shadow: ShadowClient & { updateDesired: ReturnType<typeof vi.fn> } = {
  get: async (thing) => (thing === 'SB-001' ? { desired: { setpoint_c: -20 }, reported: { setpoint_c: -18 } } : undefined),
  updateDesired: vi.fn(async () => undefined),
};

let server: Server;
let base: string;

function mount(app: express.Express, shadowClient: ShadowClient | undefined) {
  app.use(express.json());
  app.use('/api', authenticate(secret));
  app.use('/api', createRouter(fakeData));
  app.use('/api', createConfigRouter(fakeData, shadowClient));
}

beforeAll(async () => {
  const app = express();
  mount(app, shadow);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/api`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  // each test starts from the seed values; tests must not depend on each other
  configs[0] = { unit_id: 'SB-001', setpoint_c: -18, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5 };
  shadow.updateDesired.mockClear();
});

function put(path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /units/:id/config', () => {
  test('operator is 403, foreign unit is 404', async () => {
    expect((await put('/units/SB-001/config', operator1, { setpoint_c: -19 })).status).toBe(403);
    expect((await put('/units/SB-003/config', supervisor1, { setpoint_c: 4 })).status).toBe(404);
  });

  test('400 on empty body, non-numeric field, min >= max after merge, negative tolerance', async () => {
    expect((await put('/units/SB-001/config', supervisor1, {})).status).toBe(400);
    expect((await put('/units/SB-001/config', supervisor1, { setpoint_c: 'cold' })).status).toBe(400);
    expect((await put('/units/SB-001/config', supervisor1, { temp_min_c: -10 })).status).toBe(400); // max is -15
    expect((await put('/units/SB-001/config', supervisor1, { tolerance_min: -1 })).status).toBe(400);
  });

  test('400 when the merged setpoint_c falls outside [temp_min_c, temp_max_c]', async () => {
    // band is [-25, -15]; -30 is clearly outside it
    expect((await put('/units/SB-001/config', supervisor1, { setpoint_c: -30 })).status).toBe(400);
  });

  test('threshold-only edit updates RDS and never touches the shadow', async () => {
    const res = await put('/units/SB-001/config', supervisor1, { temp_max_c: -14 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ unit_id: 'SB-001', setpoint_c: -18, temp_min_c: -25, temp_max_c: -14, tolerance_min: 5 });
    expect(shadow.updateDesired).not.toHaveBeenCalled();
    expect(configs[0].temp_max_c).toBe(-14);
  });

  test('setpoint edit updates RDS and the shadow desired state', async () => {
    const res = await put('/units/SB-001/config', supervisor1, { setpoint_c: -20 });
    expect(res.status).toBe(200);
    expect(shadow.updateDesired).toHaveBeenCalledWith('SB-001', { setpoint_c: -20 });
    expect((await res.json()).warning).toBeUndefined();
  });

  test('shadow failure keeps the RDS write and returns 200 with a warning', async () => {
    shadow.updateDesired.mockRejectedValueOnce(new Error('iot down'));
    const res = await put('/units/SB-001/config', supervisor1, { setpoint_c: -21 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.setpoint_c).toBe(-21);
    expect(body.warning).toBe('shadow update failed');
    expect(configs[0].setpoint_c).toBe(-21); // RDS write survived the shadow failure
  });
});

describe('GET /units/:id/shadow', () => {
  const get = (path: string, token: string) => fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });

  test('returns desired and reported for a unit in scope', async () => {
    const res = await get('/units/SB-001/shadow', operator1);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ desired: { setpoint_c: -20 }, reported: { setpoint_c: -18 } });
  });

  test('404 outside scope or when there is no shadow', async () => {
    expect((await get('/units/SB-003/shadow', operator1)).status).toBe(404);
  });
});

describe('without IOT_ENDPOINT', () => {
  test('setpoint edit is 503 before touching RDS, threshold edit and shadow read degrade', async () => {
    const app = express();
    mount(app, undefined);
    const s = createServer(app);
    await new Promise<void>((resolve) => s.listen(0, resolve));
    const a = s.address();
    if (typeof a === 'string' || !a) throw new Error('no port');
    const b = `http://127.0.0.1:${a.port}/api`;
    try {
      const before = configs[0].setpoint_c;
      const res = await fetch(`${b}/units/SB-001/config`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${supervisor1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ setpoint_c: -22 }),
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'shadow not configured' });
      expect(configs[0].setpoint_c).toBe(before);
      const thresholdRes = await fetch(`${b}/units/SB-001/config`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${supervisor1}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ temp_max_c: -14 }),
      });
      expect(thresholdRes.status).toBe(200); // threshold-only edits still work without a shadow client
      const shadowRes = await fetch(`${b}/units/SB-001/shadow`, { headers: { Authorization: `Bearer ${supervisor1}` } });
      expect(shadowRes.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });
});
