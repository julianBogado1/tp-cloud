import { describe, expect, test } from 'vitest';
import { exportWindow, objectKey } from '../src/window';

describe('exportWindow — which UTC day to export', () => {
  test('without a date it is the previous UTC day (cron fires at 00:15Z)', () => {
    const w = exportWindow(new Date('2026-09-07T00:15:00.000Z'));
    expect(w.from).toBe('2026-09-06T00:00:00.000Z');
    expect(w.to).toBe('2026-09-07T00:00:00.000Z');
    expect(w.day).toEqual({ yyyy: '2026', mm: '09', dd: '06' });
  });

  test('late in the day it is still the previous UTC day', () => {
    expect(exportWindow(new Date('2026-09-07T23:59:00.000Z')).from).toBe('2026-09-06T00:00:00.000Z');
  });

  test('crosses month and year boundaries', () => {
    expect(exportWindow(new Date('2026-03-01T00:15:00.000Z')).from).toBe('2026-02-28T00:00:00.000Z');
    expect(exportWindow(new Date('2027-01-01T00:15:00.000Z')).from).toBe('2026-12-31T00:00:00.000Z');
  });

  test('an explicit date exports exactly that day, whatever now is', () => {
    const w = exportWindow(new Date('2026-09-07T00:15:00.000Z'), '2026-08-15');
    expect(w.from).toBe('2026-08-15T00:00:00.000Z');
    expect(w.to).toBe('2026-08-16T00:00:00.000Z');
    expect(w.day).toEqual({ yyyy: '2026', mm: '08', dd: '15' });
  });

  test('rejects malformed and impossible dates', () => {
    const now = new Date('2026-09-07T00:15:00.000Z');
    expect(() => exportWindow(now, '2026/08/15')).toThrow(/YYYY-MM-DD/);
    expect(() => exportWindow(now, '15-08-2026')).toThrow(/YYYY-MM-DD/);
    expect(() => exportWindow(now, '2026-02-30')).toThrow(/calendar/);
  });
});

describe('objectKey', () => {
  test('is <prefix>yyyy/mm/dd/<unit>.ndjson.gz', () => {
    const w = exportWindow(new Date('2026-09-07T00:15:00.000Z'));
    expect(objectKey('telemetry/', w, 'SB-001')).toBe('telemetry/2026/09/06/SB-001.ndjson.gz');
  });
});
