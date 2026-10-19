import { describe, expect, test } from 'vitest';
import type { IngestedReading } from '@snowball/shared';
import { evaluateSilence } from '../src/silence';

const TIMEOUT_MIN = 10;
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

/** A reading `minutesAgo` before NOW, so each test states its own silence. */
function reading(minutesAgo: number): IngestedReading {
  return {
    unit_id: 'SB-002',
    ts: new Date(NOW - minutesAgo * 60_000).toISOString(),
    temp_c: -18.4,
    humidity_pct: 60,
    lat: -34.6,
    lon: -58.4,
    battery: 90,
    signal: 4,
    expires_at: 0,
  };
}

describe('evaluateSilence — no-signal state machine', () => {
  test('stays ok while the last reading is inside the timeout', () => {
    const { state, alert, recovery } = evaluateSilence(
      'SB-002', { phase: 'ok' }, reading(3), TIMEOUT_MIN, NOW,
    );
    expect(state).toEqual({ phase: 'ok' });
    expect(alert).toBeUndefined();
    expect(recovery).toBeUndefined();
  });

  test('alerts on the sweep that crosses the timeout and records the silence start', () => {
    const last = reading(12);
    const { state, alert } = evaluateSilence('SB-002', { phase: 'ok' }, last, TIMEOUT_MIN, NOW);

    expect(state).toEqual({ phase: 'silent', since: last.ts });
    expect(alert).toMatchObject({
      unit_id: 'SB-002',
      severity: 'no-signal',
      since: last.ts,
      ts: '2026-10-19T12:00:00.000Z',
      duration_min: 12,
      temp_c: -18.4,
      lat: -34.6,
      lon: -58.4,
    });
    // The detail carries the last known position, as the proposal asks.
    expect(alert?.detail).toContain('no telemetry for 12 min');
    expect(alert?.detail).toContain('Last position: -34.6, -58.4');
  });

  test('the timeout boundary is inclusive, matching the thermal tolerance', () => {
    // `evaluate` alerts at >= tolerance_min, so reaching the timeout exactly
    // is enough here too; just under it is not.
    expect(evaluateSilence('SB-002', { phase: 'ok' }, reading(9.9), TIMEOUT_MIN, NOW).alert)
      .toBeUndefined();
    expect(evaluateSilence('SB-002', { phase: 'ok' }, reading(10), TIMEOUT_MIN, NOW).alert)
      .toBeDefined();
  });

  test('does not re-alert while the unit stays silent', () => {
    const last = reading(45);
    const { state, alert } = evaluateSilence(
      'SB-002', { phase: 'silent', since: last.ts }, last, TIMEOUT_MIN, NOW,
    );
    expect(state).toEqual({ phase: 'silent', since: last.ts });
    expect(alert).toBeUndefined();
  });

  test('recovers to ok and reports the silence length when the unit reports again', () => {
    const silenceStart = new Date(NOW - 50 * 60_000).toISOString();
    const fresh = reading(1);
    const { state, alert, recovery } = evaluateSilence(
      'SB-002', { phase: 'silent', since: silenceStart }, fresh, TIMEOUT_MIN, NOW,
    );

    expect(state).toEqual({ phase: 'ok' });
    expect(alert).toBeUndefined();
    expect(recovery).toMatchObject({
      unit_id: 'SB-002',
      since: silenceStart,
      ts: fresh.ts,
      silent_min: 49,
    });
    expect(recovery?.detail).toContain('reporting again after 49 min of silence');
  });

  test('a second silence after a recovery alerts again', () => {
    // The recovery reset the phase to ok, so the machine is armed once more.
    const { alert } = evaluateSilence('SB-002', { phase: 'ok' }, reading(30), TIMEOUT_MIN, NOW);
    expect(alert).toBeDefined();
  });

  test('a unit that never reported records the first sweep instead of alerting', () => {
    const { state, alert } = evaluateSilence('SB-009', { phase: 'ok' }, null, TIMEOUT_MIN, NOW);
    // Nothing is known yet, so the timeout runs from now, not from epoch.
    expect(state).toEqual({ phase: 'ok', observed_at: '2026-10-19T12:00:00.000Z' });
    expect(alert).toBeUndefined();
  });

  test('a unit that never reported alerts once the timeout runs from the first sweep', () => {
    const observedAt = new Date(NOW - 15 * 60_000).toISOString();
    const { state, alert } = evaluateSilence(
      'SB-009', { phase: 'ok', observed_at: observedAt }, null, TIMEOUT_MIN, NOW,
    );

    expect(state).toEqual({ phase: 'silent', since: observedAt, observed_at: observedAt });
    expect(alert).toMatchObject({
      unit_id: 'SB-009',
      severity: 'no-signal',
      since: observedAt,
      duration_min: 15,
      temp_c: null,
      lat: null,
      lon: null,
    });
    expect(alert?.detail).toContain('no telemetry ever received');
  });

  test('a unit that never reported keeps a stable since across sweeps', () => {
    // `since` must not drift with the clock, or the alert id would change and
    // the conditional insert would write a second row on every sweep.
    const observedAt = new Date(NOW - 15 * 60_000).toISOString();
    const first = evaluateSilence('SB-009', { phase: 'ok', observed_at: observedAt }, null, TIMEOUT_MIN, NOW);
    const later = evaluateSilence('SB-009', { phase: 'ok', observed_at: observedAt }, null, TIMEOUT_MIN, NOW + 300_000);
    expect(later.alert?.since).toBe(first.alert?.since);
  });

  test('a never-reported unit already alerted stays silent without re-alerting', () => {
    const observedAt = new Date(NOW - 60 * 60_000).toISOString();
    const { state, alert } = evaluateSilence(
      'SB-009', { phase: 'silent', since: observedAt, observed_at: observedAt }, null, TIMEOUT_MIN, NOW,
    );
    expect(state).toEqual({ phase: 'silent', since: observedAt, observed_at: observedAt });
    expect(alert).toBeUndefined();
  });

  test('honours a per-unit timeout shorter than the default', () => {
    const last = reading(4);
    expect(evaluateSilence('SB-002', { phase: 'ok' }, last, 10, NOW).alert).toBeUndefined();
    expect(evaluateSilence('SB-002', { phase: 'ok' }, last, 2, NOW).alert).toBeDefined();
  });

  test('recovery falls back to the reading ts when the stored state has no since', () => {
    // Defensive: a `_signal` item written by an older build may lack `since`.
    const fresh = reading(0);
    const { recovery } = evaluateSilence('SB-002', { phase: 'silent' }, fresh, TIMEOUT_MIN, NOW);
    expect(recovery).toMatchObject({ since: fresh.ts, silent_min: 0 });
  });
});
