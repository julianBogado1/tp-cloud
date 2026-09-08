import { describe, expect, test } from 'vitest';
import type { IngestedReading } from '@snowball/shared';
import { ExportError, forEachLimited, runExport, type ExportDeps } from '../src/export';
import { fromNdjsonGz } from '../src/ndjson';

const NOW = new Date('2026-09-07T00:15:00.000Z');

function reading(unitId: string, ts: string): IngestedReading {
  return { unit_id: unitId, ts, temp_c: -18, humidity_pct: 60, lat: -34.6, lon: -58.4, battery: 90, signal: 4, expires_at: 0 };
}

interface Fake {
  deps: ExportDeps;
  objects: Map<string, Buffer>;
  logs: string[];
  queries: Array<{ unitId: string; from: string; to: string }>;
}

function fake(data: Record<string, IngestedReading[]>, failing: string[] = []): Fake {
  const objects = new Map<string, Buffer>();
  const logs: string[] = [];
  const queries: Fake['queries'] = [];
  const deps: ExportDeps = {
    listUnits: async () => Object.keys(data),
    queryReadings: async (unitId, from, to) => {
      queries.push({ unitId, from, to });
      if (failing.includes(unitId)) throw new Error('ProvisionedThroughputExceededException');
      return (data[unitId] ?? []).filter((r) => r.ts >= from && r.ts <= to);
    },
    putObject: async (key, body) => objects.set(key, body),
    log: (message) => logs.push(message),
  };
  return { deps, objects, logs, queries };
}

describe('runExport — one gzip NDJSON object per unit per day', () => {
  test('writes each unit under telemetry/yyyy/mm/dd/<unit>.ndjson.gz with its readings', async () => {
    const f = fake({
      'SB-001': [reading('SB-001', '2026-09-06T10:00:00.000Z'), reading('SB-001', '2026-09-06T10:00:05.000Z')],
      'SB-002': [reading('SB-002', '2026-09-06T23:59:59.000Z')],
    });
    const result = await runExport(f.deps, NOW);
    expect([...f.objects.keys()].sort()).toEqual([
      'telemetry/2026/09/06/SB-001.ndjson.gz',
      'telemetry/2026/09/06/SB-002.ndjson.gz',
    ]);
    expect(fromNdjsonGz(f.objects.get('telemetry/2026/09/06/SB-001.ndjson.gz')!)).toEqual([
      reading('SB-001', '2026-09-06T10:00:00.000Z'),
      reading('SB-001', '2026-09-06T10:00:05.000Z'),
    ]);
    expect(result).toEqual({ day: '2026-09-06', units: 2, exported: 2, readings: 3, failed: [] });
  });

  test('queries [from, to] and drops a reading exactly at the next midnight', async () => {
    const f = fake({ 'SB-001': [
      reading('SB-001', '2026-09-05T23:59:59.999Z'),
      reading('SB-001', '2026-09-06T00:00:00.000Z'),
      reading('SB-001', '2026-09-07T00:00:00.000Z'),
    ] });
    const result = await runExport(f.deps, NOW);
    expect(f.queries).toEqual([{ unitId: 'SB-001', from: '2026-09-06T00:00:00.000Z', to: '2026-09-07T00:00:00.000Z' }]);
    expect(fromNdjsonGz(f.objects.get('telemetry/2026/09/06/SB-001.ndjson.gz')!)).toEqual([
      reading('SB-001', '2026-09-06T00:00:00.000Z'),
    ]);
    expect(result.readings).toBe(1);
  });

  test('a unit with no readings in the window writes nothing', async () => {
    const f = fake({ 'SB-001': [reading('SB-001', '2026-09-01T10:00:00.000Z')], 'SB-002': [] });
    const result = await runExport(f.deps, NOW);
    expect(f.objects.size).toBe(0);
    expect(result).toEqual({ day: '2026-09-06', units: 2, exported: 0, readings: 0, failed: [] });
  });

  test('an explicit date is forwarded and used for the key', async () => {
    const f = fake({ 'SB-001': [reading('SB-001', '2026-08-15T12:00:00.000Z')] });
    const result = await runExport(f.deps, NOW, '2026-08-15');
    expect(result.day).toBe('2026-08-15');
    expect([...f.objects.keys()]).toEqual(['telemetry/2026/08/15/SB-001.ndjson.gz']);
  });

  test('one failing unit does not stop others and throws ExportError at the end', async () => {
    const f = fake({
      'SB-001': [reading('SB-001', '2026-09-06T10:00:00.000Z')],
      'SB-002': [reading('SB-002', '2026-09-06T10:00:00.000Z')],
      'SB-003': [reading('SB-003', '2026-09-06T10:00:00.000Z')],
    }, ['SB-002']);
    await expect(runExport(f.deps, NOW)).rejects.toBeInstanceOf(ExportError);
    expect([...f.objects.keys()].sort()).toEqual([
      'telemetry/2026/09/06/SB-001.ndjson.gz',
      'telemetry/2026/09/06/SB-003.ndjson.gz',
    ]);
    const err = await runExport(f.deps, NOW).catch((error: ExportError) => error);
    expect(err.result).toEqual({ day: '2026-09-06', units: 3, exported: 2, readings: 2, failed: ['SB-002'] });
    expect(err.message).toMatch(/SB-002/);
    expect(f.logs.some((log) => log.includes('[SB-002] FAILED'))).toBe(true);
  });

  test('never has more than concurrency units in flight', async () => {
    const data: Record<string, IngestedReading[]> = {};
    for (let i = 0; i < 25; i++) data[`SB-${String(i).padStart(3, '0')}`] = [];
    const f = fake(data);
    let inFlight = 0;
    let maxInFlight = 0;
    const slowDeps: ExportDeps = {
      ...f.deps,
      queryReadings: async (unitId, from, to) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return f.deps.queryReadings(unitId, from, to);
      },
    };
    await runExport(slowDeps, NOW, undefined, 4);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1);
  });
});

describe('forEachLimited', () => {
  test('visits every item exactly once and handles an empty list', async () => {
    const seen: number[] = [];
    await forEachLimited([1, 2, 3, 4, 5], 2, async (n) => { seen.push(n); });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
    await expect(forEachLimited([], 3, async () => undefined)).resolves.toBeUndefined();
  });
});
