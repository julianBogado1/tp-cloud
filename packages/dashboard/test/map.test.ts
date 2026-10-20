import { describe, expect, test } from 'vitest';
import type { IngestedReading } from '@snowball/shared';
import type { UnitWithReading } from '../src/api';
import { boundsOf, latestReading, mapPoints, markerClass, type MapPoint } from '../src/map';

const NOW = Date.parse('2026-08-30T10:00:10Z');
const FRESH_TS = '2026-08-30T10:00:00Z';
const OLD_TS = '2026-08-30T09:00:00Z';

function makeReading(ts: string, overrides: Partial<IngestedReading> = {}): IngestedReading {
  return {
    unit_id: 'SB-001',
    ts,
    temp_c: -18,
    humidity_pct: 60,
    lat: -34.6037,
    lon: -58.3816,
    battery: 90,
    signal: 4,
    expires_at: 0,
    ...overrides,
  };
}

function makeUnit(unitId: string, overrides: Partial<UnitWithReading> = {}): UnitWithReading {
  return {
    unit_id: unitId,
    description: null,
    active: true,
    setpoint_c: -18,
    temp_min_c: -25,
    temp_max_c: -15,
    signal_timeout_min: null,
    last_reading: makeReading(FRESH_TS, { unit_id: unitId }),
    ...overrides,
  };
}

function point(unitId: string, lat: number, lon: number): MapPoint {
  return { unit_id: unitId, lat, lon, status: 'ok' };
}

describe('latestReading', () => {
  test('with history, the last history point wins over last_reading', () => {
    const unit = makeUnit('SB-001', { last_reading: makeReading(OLD_TS, { temp_c: -1 }) });
    const history = [makeReading(FRESH_TS, { temp_c: -19 }), makeReading(FRESH_TS, { temp_c: -20 })];
    expect(latestReading(unit, history)).toBe(history[1]);
  });

  test('empty history falls back to last_reading', () => {
    const unit = makeUnit('SB-001');
    expect(latestReading(unit, [])).toBe(unit.last_reading);
  });

  test('empty history and no last_reading is null', () => {
    expect(latestReading(makeUnit('SB-001', { last_reading: null }), [])).toBeNull();
  });

  test('does not mutate the history array', () => {
    const history = [makeReading(FRESH_TS), makeReading(FRESH_TS)];
    const copy = [...history];
    latestReading(makeUnit('SB-001'), history);
    expect(history).toEqual(copy);
    expect(history).toHaveLength(2);
  });
});

describe('mapPoints', () => {
  test('three positioned units keep the order of units', () => {
    const units = [
      makeUnit('SB-003', { last_reading: makeReading(FRESH_TS, { lat: -34.1, lon: -58.1 }) }),
      makeUnit('SB-001', { last_reading: makeReading(FRESH_TS, { lat: -34.2, lon: -58.2 }) }),
      makeUnit('SB-002', { last_reading: makeReading(FRESH_TS, { lat: -34.3, lon: -58.3 }) }),
    ];
    const { points, unpositioned } = mapPoints(units, {}, NOW);
    expect(points.map((p) => p.unit_id)).toEqual(['SB-003', 'SB-001', 'SB-002']);
    expect(unpositioned).toEqual([]);
  });

  test('invalid or out-of-range coordinates go to unpositioned, never to points', () => {
    const broken: Array<Partial<IngestedReading>> = [
      { lat: undefined as unknown as number },
      { lat: null as unknown as number },
      { lon: undefined as unknown as number },
      { lat: NaN },
      { lon: NaN },
      { lat: Infinity },
      { lon: -Infinity },
      { lat: 91 },
      { lon: -181 },
    ];
    for (const overrides of broken) {
      const unit = makeUnit('SB-001', { last_reading: makeReading(FRESH_TS, overrides) });
      const { points, unpositioned } = mapPoints([unit], {}, NOW);
      expect(points).toEqual([]);
      expect(unpositioned).toEqual(['SB-001']);
    }
  });

  test('exact coordinate limits are still valid positions', () => {
    const unit = makeUnit('SB-001', { last_reading: makeReading(FRESH_TS, { lat: 90, lon: -180 }) });
    const { points, unpositioned } = mapPoints([unit], {}, NOW);
    expect(points).toEqual([{ unit_id: 'SB-001', lat: 90, lon: -180, status: 'ok' }]);
    expect(unpositioned).toEqual([]);
  });

  test('a unit without any reading is unpositioned', () => {
    const { points, unpositioned } = mapPoints([makeUnit('SB-001', { last_reading: null })], {}, NOW);
    expect(points).toEqual([]);
    expect(unpositioned).toEqual(['SB-001']);
  });

  test('the status comes from readingStatus: ok, excursion and stale', () => {
    const ok = makeUnit('SB-001', { last_reading: makeReading(FRESH_TS, { temp_c: -18 }) });
    const excursion = makeUnit('SB-002', { last_reading: makeReading(FRESH_TS, { temp_c: -10 }) });
    const stale = makeUnit('SB-003', { last_reading: makeReading(OLD_TS, { temp_c: -18 }) });
    const { points } = mapPoints([ok, excursion, stale], {}, NOW);
    expect(points.map((p) => p.status)).toEqual(['ok', 'excursion', 'stale']);
  });

  test('a fresh history point rescues a unit whose last_reading is old', () => {
    const unit = makeUnit('SB-001', { last_reading: makeReading(OLD_TS, { temp_c: -18 }) });
    const { points } = mapPoints([unit], { 'SB-001': [makeReading(FRESH_TS, { temp_c: -18 })] }, NOW);
    expect(points).toHaveLength(1);
    expect(points[0].status).toBe('ok');
  });

  test('the unit signal_timeout_min moves the stale boundary', () => {
    const reading = makeReading('2026-08-30T10:00:00Z', { temp_c: -18 });
    const deadline = Date.parse(reading.ts) + 10 * 60_000;
    const patient = makeUnit('SB-001', { signal_timeout_min: 10, last_reading: reading });
    expect(mapPoints([patient], {}, deadline).points[0].status).toBe('ok');
    expect(mapPoints([patient], {}, deadline + 1).points[0].status).toBe('stale');
    const impatient = makeUnit('SB-001', { signal_timeout_min: 0.5, last_reading: reading });
    expect(mapPoints([impatient], {}, Date.parse(reading.ts) + 40_000).points[0].status).toBe('stale');
  });

  test('no units at all gives two empty lists', () => {
    expect(mapPoints([], {}, NOW)).toEqual({ points: [], unpositioned: [] });
  });

  test('unpositioned keeps the unit ids in the order of units', () => {
    const units = [
      makeUnit('SB-003', { last_reading: null }),
      makeUnit('SB-001', { last_reading: makeReading(FRESH_TS) }),
      makeUnit('SB-002', { last_reading: makeReading(FRESH_TS, { lat: NaN }) }),
    ];
    const { points, unpositioned } = mapPoints(units, {}, NOW);
    expect(unpositioned).toEqual(['SB-003', 'SB-002']);
    expect(points.map((p) => p.unit_id)).toEqual(['SB-001']);
  });
});

describe('boundsOf', () => {
  test('no points gives null', () => {
    expect(boundsOf([])).toBeNull();
  });

  test('a single point gives degenerate bounds', () => {
    const bounds = boundsOf([point('SB-001', -34.6037, -58.3816)]);
    expect(bounds).toEqual({ south: -34.6037, west: -58.3816, north: -34.6037, east: -58.3816 });
    expect(bounds!.south).toBe(bounds!.north);
    expect(bounds!.west).toBe(bounds!.east);
  });

  test('several points with negative lat/lon give the right min and max', () => {
    const bounds = boundsOf([
      point('SB-001', -34.6037, -58.3816),
      point('SB-002', -34.5800, -58.4500),
      point('SB-003', -34.6500, -58.3500),
    ]);
    expect(bounds).toEqual({ south: -34.65, west: -58.45, north: -34.58, east: -58.35 });
  });

  test('coordinates crossing zero keep west below east', () => {
    const bounds = boundsOf([point('SB-001', -34, -58), point('SB-002', 12, 2)]);
    expect(bounds).toEqual({ south: -34, west: -58, north: 12, east: 2 });
  });
});

describe('markerClass', () => {
  // Exact string comparison on purpose: this is the contract with styles.css,
  // so renaming a class there without renaming it here fails the test.
  test('ok, unselected', () => {
    expect(markerClass('ok', false)).toBe('unit-marker unit-marker-ok');
  });

  test('one class per status', () => {
    expect(markerClass('excursion', false)).toBe('unit-marker unit-marker-excursion');
    expect(markerClass('stale', false)).toBe('unit-marker unit-marker-stale');
  });

  test('selection adds a class without dropping the status one', () => {
    expect(markerClass('ok', true)).toBe('unit-marker unit-marker-ok unit-marker-selected');
    expect(markerClass('excursion', true)).toBe('unit-marker unit-marker-excursion unit-marker-selected');
    expect(markerClass('stale', true)).toBe('unit-marker unit-marker-stale unit-marker-selected');
  });
});
