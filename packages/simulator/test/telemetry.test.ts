import { describe, expect, test } from 'vitest';
import { createUnit, generateReading, type UnitState } from '../src/telemetry';

const fixedRng = () => 0.5;

function iterate(unit: UnitState, times: number, now: Date): UnitState {
  let u = unit;
  for (let i = 0; i < times; i++) {
    u = generateReading(u, now, fixedRng).unit;
  }
  return u;
}

describe('generateReading — telemetry of a simulated unit', () => {
  const now = new Date('2026-08-30T12:00:00.000Z');

  test('the reading carries unit_id and the given clock ts, and no expires_at', () => {
    const { reading } = generateReading(createUnit('SB-001', -18), now, fixedRng);
    expect(reading.unit_id).toBe('SB-001');
    expect(reading.ts).toBe('2026-08-30T12:00:00.000Z');
    expect(reading).not.toHaveProperty('expires_at');
  });

  test('without an excursion the temperature stays near the setpoint', () => {
    const u = iterate(createUnit('SB-001', -18), 50, now);
    const { reading } = generateReading(u, now, fixedRng);
    expect(reading.temp_c).toBeGreaterThan(-20);
    expect(reading.temp_c).toBeLessThan(-16);
  });

  test('with an active excursion the temperature ends up above the maximum threshold', () => {
    let u = createUnit('SB-001', -18);
    u = { ...u, inExcursion: true };
    u = iterate(u, 50, now);
    const { reading } = generateReading(u, now, fixedRng);
    expect(reading.temp_c).toBeGreaterThan(-15);
  });

  test('after the excursion ends the temperature returns towards the setpoint', () => {
    let u = createUnit('SB-001', -18);
    u = iterate({ ...u, inExcursion: true }, 50, now);
    u = iterate({ ...u, inExcursion: false }, 100, now);
    const { reading } = generateReading(u, now, fixedRng);
    expect(reading.temp_c).toBeLessThan(-16);
  });

  test('each known unit starts at its own position, close but distinguishable', () => {
    const origins = ['SB-001', 'SB-002', 'SB-003'].map((id) => createUnit(id, -18));
    const keys = origins.map((u) => `${u.lat},${u.lon}`);
    expect(new Set(keys).size).toBe(3);
    for (const a of origins) {
      for (const b of origins) {
        if (a.unit_id === b.unit_id) continue;
        const apart = Math.max(Math.abs(a.lat - b.lat), Math.abs(a.lon - b.lon));
        // Well above the +-0.001 drift of one step, well inside one metro area.
        expect(apart).toBeGreaterThan(0.01);
        expect(apart).toBeLessThan(0.5);
      }
    }
  });

  test('an unknown unit id falls back to a valid default position', () => {
    const unit = createUnit('SB-999', -18);
    expect(Number.isFinite(unit.lat)).toBe(true);
    expect(Number.isFinite(unit.lon)).toBe(true);
    expect(Math.abs(unit.lat)).toBeLessThanOrEqual(90);
    expect(Math.abs(unit.lon)).toBeLessThanOrEqual(180);
  });

  test('the battery decreases with each reading and never goes below zero', () => {
    const initial = createUnit('SB-001', -18);
    const after10 = iterate(initial, 10, now);
    expect(after10.battery).toBeLessThan(initial.battery);
    const drained = iterate(initial, 100000, now);
    expect(drained.battery).toBeGreaterThanOrEqual(0);
  });
});
