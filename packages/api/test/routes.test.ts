import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'http';
import express from 'express';
import { createRouter, type DataAccess } from '../src/routes';

const units = [
  { unit_id: 'SB-001', description: 'Reefer BA-MDQ', active: true, setpoint_c: -18, temp_min_c: -25, temp_max_c: -15 },
];
const alerts = [
  { id: 1, unit_id: 'SB-001', severity: 'thermal-excursion', since: '2026-08-30T09:00:00Z', emitted_at: '2026-08-30T09:06:00Z', duration_min: 6, temp_c: -12.5, detail: 'sustained -12.5°C', acknowledged_at: null },
];
const telemetry = [
  { unit_id: 'SB-001', ts: '2026-08-30T10:00:00Z', temp_c: -18, humidity_pct: 60, lat: -34.6, lon: -58.4, battery: 90, signal: 4, expires_at: 0 },
];

const data: DataAccess = {
  listUnits: async () => units,
  latestReading: async (unitId) => (unitId === 'SB-001' ? telemetry[0] : undefined),
  queryTelemetry: async (unitId, q) => (unitId === 'SB-001' && q.limit > 0 ? telemetry : []),
  listAlerts: async () => alerts,
};

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use('/api', createRouter(data));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (typeof address === 'string' || !address) throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/api`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('REST routes', () => {
  test('GET /units returns each unit with its config and latest reading', async () => {
    const res = await fetch(`${base}/units`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([{ ...units[0], last_reading: telemetry[0] }]);
  });

  test('GET /units/:id/telemetry returns readings', async () => {
    const res = await fetch(`${base}/units/SB-001/telemetry?limit=10`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(telemetry);
  });

  test('GET /units/:id/telemetry with a bad param is a 400, not a crash', async () => {
    const res = await fetch(`${base}/units/SB-001/telemetry?limit=abc`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/limit/);
  });

  test('GET /alerts returns the recent alerts', async () => {
    const res = await fetch(`${base}/alerts`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(alerts);
  });

  test('unknown routes are 404 JSON', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });
});
