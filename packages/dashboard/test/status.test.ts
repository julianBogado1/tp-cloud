import { describe, expect, test } from 'vitest';
import { deriveWsUrl, formatAgo, readingStatus } from '../src/status';

const unit = { temp_min_c: -25, temp_max_c: -15 };

describe('readingStatus', () => {
  test('no reading yet is "stale"', () => {
    expect(readingStatus(null, unit, Date.now())).toBe('stale');
  });

  test('in-range recent reading is "ok"', () => {
    const now = Date.parse('2026-08-30T10:00:10Z');
    expect(readingStatus({ ts: '2026-08-30T10:00:00Z', temp_c: -18 }, unit, now)).toBe('ok');
  });

  test('out-of-range reading is "excursion"', () => {
    const now = Date.parse('2026-08-30T10:00:10Z');
    expect(readingStatus({ ts: '2026-08-30T10:00:00Z', temp_c: -10 }, unit, now)).toBe('excursion');
    expect(readingStatus({ ts: '2026-08-30T10:00:00Z', temp_c: -30 }, unit, now)).toBe('excursion');
  });

  test('a reading older than 2 minutes is "stale" even if in range', () => {
    const now = Date.parse('2026-08-30T10:03:00Z');
    expect(readingStatus({ ts: '2026-08-30T10:00:00Z', temp_c: -18 }, unit, now)).toBe('stale');
  });

  test('missing thresholds: recent reading is "ok" (nothing to compare against)', () => {
    const now = Date.parse('2026-08-30T10:00:10Z');
    expect(readingStatus({ ts: '2026-08-30T10:00:00Z', temp_c: 5 }, { temp_min_c: null, temp_max_c: null }, now)).toBe('ok');
  });

  test('the unit signal_timeout_min widens the window: 5 minutes old is still "ok"', () => {
    const patient = { ...unit, signal_timeout_min: 10 };
    const now = Date.parse('2026-08-30T10:05:00Z');
    expect(readingStatus({ ts: '2026-08-30T10:00:00Z', temp_c: -18 }, patient, now)).toBe('ok');
    expect(readingStatus({ ts: '2026-08-30T10:00:00Z', temp_c: -18 }, unit, now)).toBe('stale');
  });

  test('the unit signal_timeout_min narrows the window: 40 seconds old is already "stale"', () => {
    const impatient = { ...unit, signal_timeout_min: 0.5 };
    const now = Date.parse('2026-08-30T10:00:40Z');
    expect(readingStatus({ ts: '2026-08-30T10:00:00Z', temp_c: -18 }, impatient, now)).toBe('stale');
  });

  test('its own timeout wins over the thermal range: out of range but silent is "stale"', () => {
    const impatient = { ...unit, signal_timeout_min: 1 };
    const now = Date.parse('2026-08-30T10:02:00Z');
    expect(readingStatus({ ts: '2026-08-30T10:00:00Z', temp_c: -10 }, impatient, now)).toBe('stale');
  });

  test('exactly at the unit timeout is not yet "stale", one millisecond later it is', () => {
    const patient = { ...unit, signal_timeout_min: 10 };
    const ts = '2026-08-30T10:00:00Z';
    const deadline = Date.parse(ts) + 10 * 60_000;
    expect(readingStatus({ ts, temp_c: -18 }, patient, deadline)).toBe('ok');
    expect(readingStatus({ ts, temp_c: -18 }, patient, deadline + 1)).toBe('stale');
  });

  test('a null or non-positive signal_timeout_min falls back to the 2 minute default', () => {
    const ts = '2026-08-30T10:00:00Z';
    const inRange = { ts, temp_c: -18 };
    const justInside = Date.parse(ts) + 2 * 60_000;
    for (const timeout of [null, undefined, 0]) {
      const thresholds = { ...unit, signal_timeout_min: timeout };
      expect(readingStatus(inRange, thresholds, justInside)).toBe('ok');
      expect(readingStatus(inRange, thresholds, justInside + 1)).toBe('stale');
    }
  });
});

describe('formatAgo', () => {
  const now = Date.parse('2026-08-30T10:00:00Z');
  test('seconds, minutes, hours', () => {
    expect(formatAgo('2026-08-30T09:59:55Z', now)).toBe('5s');
    expect(formatAgo('2026-08-30T09:57:00Z', now)).toBe('3m');
    expect(formatAgo('2026-08-30T07:00:00Z', now)).toBe('3h');
  });
});

describe('deriveWsUrl', () => {
  test('http becomes ws, https becomes wss, path is /live', () => {
    expect(deriveWsUrl('http://localhost:3000')).toBe('ws://localhost:3000/live');
    expect(deriveWsUrl('https://alb-123.us-east-1.elb.amazonaws.com')).toBe('wss://alb-123.us-east-1.elb.amazonaws.com/live');
    expect(deriveWsUrl('https://host/base/')).toBe('wss://host/base/live');
  });
});
