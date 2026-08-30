import { describe, expect, test } from 'vitest';
import type { ExcursionState, IngestedReading, ThresholdConfig } from '@snowball/shared';
import { evaluate } from '../src/excursion';

const config: ThresholdConfig = {
  unit_id: 'SB-001',
  temp_min_c: -25,
  temp_max_c: -15,
  tolerance_min: 5,
  setpoint_c: -18,
};

function reading(tempC: number, ts: string): IngestedReading {
  return {
    unit_id: 'SB-001',
    ts,
    temp_c: tempC,
    humidity_pct: 60,
    lat: -34.6,
    lon: -58.4,
    battery: 90,
    signal: 4,
    expires_at: 0,
  };
}

const OK: ExcursionState = { phase: 'ok' };

describe('evaluate — thermal excursion state machine', () => {
  test('an in-range reading in ok state stays ok and does not alert', () => {
    const r = evaluate(OK, reading(-18, '2026-08-30T12:00:00Z'), config);
    expect(r.state).toEqual({ phase: 'ok' });
    expect(r.alert).toBeUndefined();
  });

  test('a temperature equal to the maximum is still in range', () => {
    const r = evaluate(OK, reading(-15, '2026-08-30T12:00:00Z'), config);
    expect(r.state.phase).toBe('ok');
  });

  test('the first out-of-range reading moves to deviated and records since', () => {
    const r = evaluate(OK, reading(-12, '2026-08-30T12:00:00Z'), config);
    expect(r.state).toEqual({ phase: 'deviated', since: '2026-08-30T12:00:00Z' });
    expect(r.alert).toBeUndefined();
  });

  test('a temperature below the minimum is also a deviation', () => {
    const r = evaluate(OK, reading(-30, '2026-08-30T12:00:00Z'), config);
    expect(r.state.phase).toBe('deviated');
  });

  test('deviated before the tolerance does not alert', () => {
    const deviated: ExcursionState = { phase: 'deviated', since: '2026-08-30T12:00:00Z' };
    const r = evaluate(deviated, reading(-12, '2026-08-30T12:04:59Z'), config);
    expect(r.state).toEqual(deviated);
    expect(r.alert).toBeUndefined();
  });

  test('a transient spike that returns to range before the tolerance does not alert', () => {
    const deviated: ExcursionState = { phase: 'deviated', since: '2026-08-30T12:00:00Z' };
    const r = evaluate(deviated, reading(-18, '2026-08-30T12:02:00Z'), config);
    expect(r.state).toEqual({ phase: 'ok' });
    expect(r.alert).toBeUndefined();
  });

  test('exactly at the tolerance it moves to alerted and emits the alert', () => {
    const deviated: ExcursionState = { phase: 'deviated', since: '2026-08-30T12:00:00Z' };
    const r = evaluate(deviated, reading(-11.5, '2026-08-30T12:05:00Z'), config);
    expect(r.state).toEqual({ phase: 'alerted', since: '2026-08-30T12:00:00Z' });
    expect(r.alert).toMatchObject({
      unit_id: 'SB-001',
      severity: 'thermal-excursion',
      since: '2026-08-30T12:00:00Z',
      ts: '2026-08-30T12:05:00Z',
      duration_min: 5,
      temp_c: -11.5,
      lat: -34.6,
      lon: -58.4,
    });
  });

  test('alerted and still out of range does not alert again', () => {
    const alerted: ExcursionState = { phase: 'alerted', since: '2026-08-30T12:00:00Z' };
    const r = evaluate(alerted, reading(-11, '2026-08-30T12:20:00Z'), config);
    expect(r.state).toEqual(alerted);
    expect(r.alert).toBeUndefined();
  });

  test('alerted that returns to range recovers to ok', () => {
    const alerted: ExcursionState = { phase: 'alerted', since: '2026-08-30T12:00:00Z' };
    const r = evaluate(alerted, reading(-18, '2026-08-30T12:30:00Z'), config);
    expect(r.state).toEqual({ phase: 'ok' });
    expect(r.alert).toBeUndefined();
  });

  test('a new excursion after recovering alerts again', () => {
    let state: ExcursionState = { phase: 'ok' };
    state = evaluate(state, reading(-10, '2026-08-30T13:00:00Z'), config).state;
    const r = evaluate(state, reading(-10, '2026-08-30T13:06:00Z'), config);
    expect(r.alert).toBeDefined();
  });
});
