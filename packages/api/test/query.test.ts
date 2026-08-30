import { describe, expect, test } from 'vitest';
import { parseTelemetryQuery } from '../src/query';

describe('parseTelemetryQuery — /units/:id/telemetry query params', () => {
  test('defaults exclude the _state item and cap the page size', () => {
    const q = parseTelemetryQuery({});
    expect(q.from).toBe('0');
    expect(q.to).toBe('9999');
    expect(q.limit).toBe(500);
  });

  test('accepts ISO bounds and a custom limit', () => {
    const q = parseTelemetryQuery({ from: '2026-08-30T00:00:00Z', to: '2026-08-30T23:59:59Z', limit: '50' });
    expect(q).toEqual({ from: '2026-08-30T00:00:00Z', to: '2026-08-30T23:59:59Z', limit: 50 });
  });

  test('rejects a non-numeric or out-of-range limit', () => {
    expect(() => parseTelemetryQuery({ limit: 'abc' })).toThrow(/limit/);
    expect(() => parseTelemetryQuery({ limit: '0' })).toThrow(/limit/);
    expect(() => parseTelemetryQuery({ limit: '5001' })).toThrow(/limit/);
  });

  test('rejects bounds that could reach the _state item', () => {
    expect(() => parseTelemetryQuery({ to: '_zzz' })).toThrow(/to/);
    expect(() => parseTelemetryQuery({ from: 'x' })).toThrow(/from/);
  });
});
