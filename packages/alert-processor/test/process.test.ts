import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.THRESHOLDS_CACHE_MS = '0';
});
vi.mock('@aws-sdk/client-dynamodb', async () => (await import('./fake-aws')).clientDynamodb);
vi.mock('@aws-sdk/lib-dynamodb', async () => (await import('./fake-aws')).libDynamodb);
vi.mock('@aws-sdk/client-sns', async () => (await import('./fake-aws')).clientSns);

import { alertId } from '../src/alert-id';
import { processMessage } from '../src/process';
import { fake, reading, seedUnit, TOPIC } from './fake-aws';

const msg = (unitId: string, tempC: number, ts: string) => JSON.stringify(reading(unitId, tempC, ts));
const STATE = { unit_id: 'SB-001', ts: '_state' };

describe('alertId — deterministic numeric id', () => {
  test('is stable for the same unit and since, and differs otherwise', () => {
    const a = alertId('SB-001', '2026-08-30T12:00:00Z');
    expect(alertId('SB-001', '2026-08-30T12:00:00Z')).toBe(a);
    expect(alertId('SB-002', '2026-08-30T12:00:00Z')).not.toBe(a);
    expect(alertId('SB-001', '2026-08-30T12:00:01Z')).not.toBe(a);
  });

  test('is a positive safe integer (alerts.id is a DynamoDB Number)', () => {
    for (let i = 0; i < 1000; i++) {
      const id = alertId(`SB-${i}`, new Date(i * 60_000).toISOString());
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThanOrEqual(1);
    }
  });

  test('has a pinned value so a refactor cannot silently change it', () => {
    expect(alertId('SB-001', '2026-08-30T12:00:00Z')).toMatchInlineSnapshot(`431167449473579`);
  });
});

describe('processMessage', () => {
  beforeEach(() => {
    process.env.SNS_THERMAL_EXCURSION_TOPIC_ARN = TOPIC;
    fake.reset();
    seedUnit('SB-001');
  });

  test('a unit without device_config is discarded without side effects', async () => {
    await processMessage(msg('SB-404', -10, '2026-08-30T12:00:00Z'));
    expect(fake.log).toEqual(['Get snowball-device-config']);
  });

  test('a malformed body throws (left for retry/DLQ)', async () => {
    await expect(processMessage('not-json{')).rejects.toThrow(/JSON/);
    expect(fake.log).toEqual([]);
  });

  test('a phase change without alert only saves the state', async () => {
    await processMessage(msg('SB-001', -10, '2026-08-30T12:00:00Z'));
    expect(fake.log).toEqual(['Get snowball-device-config', 'Get snowball-telemetry', 'Put snowball-telemetry']);
    expect(fake.tables.get('snowball-telemetry')?.get('SB-001|_state')).toMatchObject({ phase: 'deviated', since: '2026-08-30T12:00:00Z' });
  });

  test('alert path order: unit lookup → alert insert → SNS publish → state save', async () => {
    fake.put('snowball-telemetry', { ...STATE, phase: 'deviated', since: '2026-08-30T12:00:00Z' });
    await processMessage(msg('SB-001', -11, '2026-08-30T12:06:00Z'));

    expect(fake.log).toEqual([
      'Get snowball-device-config',
      'Get snowball-telemetry',
      'Get snowball-units',
      'Put snowball-alerts',
      `Publish ${TOPIC}`,
      'Put snowball-telemetry',
    ]);
    expect(fake.rows('snowball-alerts')).toEqual([
      expect.objectContaining({
        id: alertId('SB-001', '2026-08-30T12:00:00Z'),
        unit_id: 'SB-001',
        client_id: 7,
        since: '2026-08-30T12:00:00Z',
        emitted_at: '2026-08-30T12:06:00Z',
        acknowledged_at: null,
      }),
    ]);
    expect(fake.published[0]).toMatchObject({ TopicArn: TOPIC, Subject: 'Thermal excursion — SB-001' });
    expect(fake.tables.get('snowball-telemetry')?.get('SB-001|_state')).toMatchObject({ phase: 'alerted' });
  });

  test('a missing unit fails before any side effect (no row, no email, state untouched)', async () => {
    seedUnit('SB-002');
    fake.tables.get('snowball-units')?.delete('SB-002');
    fake.put('snowball-telemetry', { unit_id: 'SB-002', ts: '_state', phase: 'deviated', since: '2026-08-30T12:00:00Z' });

    await expect(processMessage(msg('SB-002', -11, '2026-08-30T12:06:00Z'))).rejects.toThrow(/unit missing/);
    expect(fake.rows('snowball-alerts')).toEqual([]);
    expect(fake.published).toEqual([]);
    expect(fake.tables.get('snowball-telemetry')?.get('SB-002|_state')).toMatchObject({ phase: 'deviated' });
  });

  test('a failed publish leaves the state deviated; the retry reuses the row and publishes', async () => {
    fake.put('snowball-telemetry', { ...STATE, phase: 'deviated', since: '2026-08-30T12:00:00Z' });
    fake.failNext('Publish', new Error('SNS throttled'));

    await expect(processMessage(msg('SB-001', -11, '2026-08-30T12:06:00Z'))).rejects.toThrow(/throttled/);
    expect(fake.rows('snowball-alerts')).toHaveLength(1);
    expect(fake.tables.get('snowball-telemetry')?.get('SB-001|_state')).toMatchObject({ phase: 'deviated' });

    // Retry: the conditional put hits the existing row (ConditionalCheckFailed
    // counts as done), the email goes out and the state advances.
    await processMessage(msg('SB-001', -11, '2026-08-30T12:06:00Z'));
    expect(fake.rows('snowball-alerts')).toHaveLength(1);
    expect(fake.published).toHaveLength(1);
    expect(fake.tables.get('snowball-telemetry')?.get('SB-001|_state')).toMatchObject({ phase: 'alerted' });
  });

  test('a failed state save after publish re-publishes on retry (at-least-once) without duplicating the row', async () => {
    fake.put('snowball-telemetry', { ...STATE, phase: 'deviated', since: '2026-08-30T12:00:00Z' });
    fake.failNext('Put snowball-telemetry', new Error('DynamoDB unavailable'));

    await expect(processMessage(msg('SB-001', -11, '2026-08-30T12:06:00Z'))).rejects.toThrow(/unavailable/);
    await processMessage(msg('SB-001', -11, '2026-08-30T12:06:00Z'));

    expect(fake.rows('snowball-alerts')).toHaveLength(1);
    expect(fake.published).toHaveLength(2);
    expect(fake.tables.get('snowball-telemetry')?.get('SB-001|_state')).toMatchObject({ phase: 'alerted' });
  });

  test('other insert errors are not swallowed and nothing is published', async () => {
    fake.put('snowball-telemetry', { ...STATE, phase: 'deviated', since: '2026-08-30T12:00:00Z' });
    fake.failNext('Put snowball-alerts', new Error('ProvisionedThroughputExceeded'));

    await expect(processMessage(msg('SB-001', -11, '2026-08-30T12:06:00Z'))).rejects.toThrow(/Throughput/);
    expect(fake.published).toEqual([]);
  });

  test('state is read from DynamoDB on every message (no in-memory cache)', async () => {
    await processMessage(msg('SB-001', -10, '2026-08-30T12:00:00Z'));
    // Another consumer moved the unit back to ok behind our back.
    fake.put('snowball-telemetry', { ...STATE, phase: 'ok' });
    await processMessage(msg('SB-001', -10, '2026-08-30T12:06:00Z'));
    expect(fake.published).toEqual([]);
    expect(fake.tables.get('snowball-telemetry')?.get('SB-001|_state')).toMatchObject({ since: '2026-08-30T12:06:00Z' });
  });
});
