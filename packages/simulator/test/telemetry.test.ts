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

  test('the battery decreases with each reading and never goes below zero', () => {
    const initial = createUnit('SB-001', -18);
    const after10 = iterate(initial, 10, now);
    expect(after10.battery).toBeLessThan(initial.battery);
    const drained = iterate(initial, 100000, now);
    expect(drained.battery).toBeGreaterThanOrEqual(0);
  });
});
