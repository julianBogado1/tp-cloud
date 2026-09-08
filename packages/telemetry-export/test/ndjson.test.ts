import { gunzipSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { fromNdjsonGz, toNdjsonGz } from '../src/ndjson';

const rows = [
  { unit_id: 'SB-001', ts: '2026-09-06T00:00:05.000Z', temp_c: -18.2 },
  { unit_id: 'SB-001', ts: '2026-09-06T00:00:10.000Z', temp_c: -18.1 },
  { unit_id: 'SB-001', ts: '2026-09-06T00:00:15.000Z', temp_c: -17.9 },
];

describe('toNdjsonGz / fromNdjsonGz', () => {
  test('round-trips the rows', () => {
    expect(fromNdjsonGz(toNdjsonGz(rows))).toEqual(rows);
  });

  test('output is gzip (magic bytes) holding one JSON document per line', () => {
    const buf = toNdjsonGz(rows);
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
    const text = gunzipSync(buf).toString('utf8');
    const lines = text.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
    expect(JSON.parse(lines[1])).toEqual(rows[1]);
  });

  test('empty input is an empty gzip stream that decodes to []', () => {
    const buf = toNdjsonGz([]);
    expect(gunzipSync(buf).toString('utf8')).toBe('');
    expect(fromNdjsonGz(buf)).toEqual([]);
  });
});
