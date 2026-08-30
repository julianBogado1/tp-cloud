import { describe, expect, test } from 'vitest';
import { parseReading } from '../src/parse';

const valid = {
  unit_id: 'SB-001',
  ts: '2026-08-30T12:00:00Z',
  temp_c: -17.5,
  humidity_pct: 61,
  lat: -34.6,
  lon: -58.4,
  battery: 88,
  signal: 4,
  expires_at: 1759999999,
};

describe('parseReading — SQS message body deposited by the IoT rule', () => {
  test('accepts a valid reading', () => {
    expect(parseReading(JSON.stringify(valid))).toEqual(valid);
  });

  test('rejects a body that is not JSON', () => {
    expect(() => parseReading('not-json{')).toThrow(/JSON/);
  });

  test('rejects a reading without unit_id', () => {
    const { unit_id, ...rest } = valid;
    expect(() => parseReading(JSON.stringify(rest))).toThrow(/unit_id/);
  });

  test('rejects a non-numeric temperature', () => {
    expect(() => parseReading(JSON.stringify({ ...valid, temp_c: 'cold' }))).toThrow(/temp_c/);
  });

  test('rejects a ts that is not a parseable ISO date', () => {
    expect(() => parseReading(JSON.stringify({ ...valid, ts: 'yesterday' }))).toThrow(/ts/);
  });
});
