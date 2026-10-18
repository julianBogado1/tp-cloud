import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.THRESHOLDS_CACHE_MS = '0';
});
vi.mock('@aws-sdk/client-dynamodb', async () => (await import('./fake-aws')).clientDynamodb);
vi.mock('@aws-sdk/lib-dynamodb', async () => (await import('./fake-aws')).libDynamodb);
vi.mock('@aws-sdk/client-sns', async () => (await import('./fake-aws')).clientSns);

import { handler } from '../src/handler';
import { fake, reading, seedUnit, TOPIC } from './fake-aws';

function record(messageId: string, body: unknown): SQSRecord {
  return { messageId, body: typeof body === 'string' ? body : JSON.stringify(body) } as SQSRecord;
}
const event = (...records: SQSRecord[]): SQSEvent => ({ Records: records });
const failedIds = (r: { batchItemFailures: { itemIdentifier: string }[] }) =>
  r.batchItemFailures.map((f) => f.itemIdentifier).sort();
const stateOf = (unitId: string) => fake.tables.get('snowball-telemetry')?.get(`${unitId}|_state`);

describe('handler — SQS event source mapping', () => {
  beforeEach(() => {
    process.env.SNS_THERMAL_EXCURSION_TOPIC_ARN = TOPIC;
    fake.reset();
    seedUnit('SB-001');
    seedUnit('SB-002');
  });

  test('a clean batch reports no failures and emits the alert', async () => {
    const res = await handler(event(
      record('m1', reading('SB-001', -10, '2026-08-30T12:00:00Z')),
      record('m2', reading('SB-001', -10, '2026-08-30T12:06:00Z')),
    ));
    expect(res.batchItemFailures).toEqual([]);
    expect(fake.rows('snowball-alerts')).toHaveLength(1);
    expect(fake.published).toHaveLength(1);
    expect(stateOf('SB-001')).toMatchObject({ phase: 'alerted', since: '2026-08-30T12:00:00Z' });
  });

  test('each unit is processed in ts order even when the batch arrives shuffled', async () => {
    const res = await handler(event(
      record('m2', reading('SB-001', -10, '2026-08-30T12:06:00Z')),
      record('m1', reading('SB-001', -10, '2026-08-30T12:00:00Z')),
    ));
    expect(res.batchItemFailures).toEqual([]);
    expect(fake.published).toHaveLength(1);
    expect(stateOf('SB-001')).toMatchObject({ phase: 'alerted', since: '2026-08-30T12:00:00Z' });
  });

  test('a failure fails that record and the later records of the same unit only', async () => {
    // SB-001: m1 deviates, m2 should alert but SNS fails, m3 must not run.
    fake.failNext(`Publish ${TOPIC}`, new Error('SNS throttled'));
    const res = await handler(event(
      record('m1', reading('SB-001', -10, '2026-08-30T12:00:00Z')),
      record('m3', reading('SB-001', -18, '2026-08-30T12:10:00Z')),
      record('m2', reading('SB-001', -10, '2026-08-30T12:06:00Z')),
      record('o1', reading('SB-002', -10, '2026-08-30T12:00:00Z')),
    ));

    expect(failedIds(res)).toEqual(['m2', 'm3']);
    // m3 (back in range) was not applied: the retry still sees the excursion.
    expect(stateOf('SB-001')).toMatchObject({ phase: 'deviated', since: '2026-08-30T12:00:00Z' });
    // The other unit is unaffected.
    expect(stateOf('SB-002')).toMatchObject({ phase: 'deviated' });
  });

  test('a reading for an unknown unit (no device_config) is dropped, not failed', async () => {
    const res = await handler(event(
      record('u1', reading('SB-404', -10, '2026-08-30T12:00:00Z')),
      record('m1', reading('SB-001', -10, '2026-08-30T12:00:00Z')),
    ));
    expect(res.batchItemFailures).toEqual([]);
    expect(stateOf('SB-404')).toBeUndefined();
    expect(stateOf('SB-001')).toMatchObject({ phase: 'deviated' });
  });

  test('a malformed body is reported as a failure (→ DLQ) without blocking other records', async () => {
    const res = await handler(event(
      record('bad', 'not-json{'),
      record('m1', reading('SB-001', -10, '2026-08-30T12:00:00Z')),
    ));
    expect(failedIds(res)).toEqual(['bad']);
    expect(stateOf('SB-001')).toMatchObject({ phase: 'deviated' });
  });

  test('does not require SQS_QUEUE_URL', async () => {
    delete process.env.SQS_QUEUE_URL;
    const res = await handler(event(record('m1', reading('SB-001', -18, '2026-08-30T12:00:00Z'))));
    expect(res.batchItemFailures).toEqual([]);
  });
});
