import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.THRESHOLDS_CACHE_MS = '0';
});
vi.mock('@aws-sdk/client-dynamodb', async () => (await import('./fake-aws')).clientDynamodb);
vi.mock('@aws-sdk/lib-dynamodb', async () => (await import('./fake-aws')).libDynamodb);
vi.mock('@aws-sdk/client-sns', async () => (await import('./fake-aws')).clientSns);

import { alertId } from '../src/alert-id';
import { handler } from '../src/no-signal-handler';
import { getSignalState, saveSignalState } from '../src/signal-state';
import { fake, NO_SIGNAL_TOPIC, seedState, seedUnit } from './fake-aws';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
/** ISO instant `minutesAgo` before the (mocked) sweep clock. */
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const signalOf = (unitId: string) => fake.tables.get('snowball-telemetry')?.get(`${unitId}|_signal`);
/** The reads every sweep does before it looks at a single unit. */
const SWEEP_READS = ['Scan snowball-units', 'BatchGet snowball-unit-state', 'BatchGet snowball-telemetry'];

describe('handler — no-signal sweep', () => {
  beforeEach(() => {
    process.env.SNS_NO_SIGNAL_TOPIC_ARN = NO_SIGNAL_TOPIC;
    process.env.NO_SIGNAL_TIMEOUT_MIN = '10';
    // The clock is the input here, so it is pinned instead of faked per call.
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    fake.reset();
  });

  test('a unit reporting inside its timeout is left untouched', async () => {
    seedUnit('SB-001');
    seedState('SB-001', iso(3));

    await handler();

    expect(fake.log).toEqual([...SWEEP_READS, 'Get snowball-device-config']);
    expect(fake.published).toEqual([]);
    expect(signalOf('SB-001')).toBeUndefined();
  });

  test('crossing the timeout inserts the alert, publishes and then saves the state', async () => {
    seedUnit('SB-002');
    seedState('SB-002', iso(12));

    await handler();

    expect(fake.log).toEqual([
      ...SWEEP_READS,
      'Get snowball-device-config',
      'Get snowball-units',
      'Put snowball-alerts',
      `Publish ${NO_SIGNAL_TOPIC}`,
      'Put snowball-telemetry',
    ]);
    expect(fake.rows('snowball-alerts')).toEqual([
      expect.objectContaining({
        // Seeded, so a thermal alert sharing this `since` cannot swallow it.
        id: alertId('SB-002', iso(12), 'no-signal'),
        unit_id: 'SB-002',
        client_id: 7,
        severity: 'no-signal',
        since: iso(12),
        emitted_at: '2026-10-19T12:00:00.000Z',
        duration_min: 12,
        temp_c: -18,
        acknowledged_at: null,
      }),
    ]);
    expect(fake.published[0]).toMatchObject({
      TopicArn: NO_SIGNAL_TOPIC,
      Subject: 'No signal — SB-002',
    });
    expect(signalOf('SB-002')).toMatchObject({ phase: 'silent', since: iso(12) });
  });

  test('a unit already silent is not alerted again', async () => {
    seedUnit('SB-002');
    seedState('SB-002', iso(45));
    fake.put('snowball-telemetry', { unit_id: 'SB-002', ts: '_signal', phase: 'silent', since: iso(45) });

    await handler();

    expect(fake.log).toEqual([...SWEEP_READS, 'Get snowball-device-config']);
    expect(fake.rows('snowball-alerts')).toEqual([]);
    expect(fake.published).toEqual([]);
  });

  test('a unit reporting again publishes a recovery without writing an alert row', async () => {
    seedUnit('SB-002');
    seedState('SB-002', iso(1));
    fake.put('snowball-telemetry', { unit_id: 'SB-002', ts: '_signal', phase: 'silent', since: iso(50) });

    await handler();

    expect(fake.log).toEqual([
      ...SWEEP_READS,
      'Get snowball-device-config',
      `Publish ${NO_SIGNAL_TOPIC}`,
      'Put snowball-telemetry',
    ]);
    expect(fake.rows('snowball-alerts')).toEqual([]);
    expect(fake.published[0]).toMatchObject({ Subject: 'Signal recovered — SB-002' });
    expect(String(fake.published[0].Message)).toContain('reporting again after 49 min of silence');
    expect(signalOf('SB-002')).toEqual({ unit_id: 'SB-002', ts: '_signal', phase: 'ok' });
  });

  test('a deactivated unit is skipped even though it has been silent for an hour', async () => {
    seedUnit('SB-001');
    seedState('SB-001', iso(3));
    seedUnit('SB-003');
    fake.put('snowball-units', { unit_id: 'SB-003', client_id: 7, active: false });
    seedState('SB-003', iso(60));

    await handler();

    // One device-config read: only SB-001 made it past the active filter.
    expect(fake.log).toEqual([...SWEEP_READS, 'Get snowball-device-config']);
    expect(fake.published).toEqual([]);
    expect(signalOf('SB-003')).toBeUndefined();
  });

  test('a unit with no device-config row alerts on the environment fallback', async () => {
    // The thermal path discards these readings; silence does not need a range,
    // and an unconfigured unit is worth hearing about.
    process.env.NO_SIGNAL_TIMEOUT_MIN = '3';
    fake.put('snowball-units', { unit_id: 'SB-404', client_id: 9 });
    seedState('SB-404', iso(5));

    await handler();

    expect(fake.rows('snowball-alerts')).toEqual([
      expect.objectContaining({ unit_id: 'SB-404', severity: 'no-signal', client_id: 9 }),
    ]);
    expect(fake.published).toHaveLength(1);
  });

  test('a unit that never reported is recorded first and alerted on a later sweep', async () => {
    seedUnit('SB-009');

    await handler();

    // Nothing is known yet, so the timeout starts from this sweep.
    expect(fake.rows('snowball-alerts')).toEqual([]);
    expect(signalOf('SB-009')).toMatchObject({ phase: 'ok', observed_at: '2026-10-19T12:00:00.000Z' });

    vi.spyOn(Date, 'now').mockReturnValue(NOW + 15 * 60_000);
    await handler();

    expect(fake.rows('snowball-alerts')).toEqual([
      expect.objectContaining({
        unit_id: 'SB-009',
        since: '2026-10-19T12:00:00.000Z',
        temp_c: null,
        lat: null,
        lon: null,
      }),
    ]);
    expect(String(fake.published[0].Message)).toContain('no telemetry ever received');
    expect(signalOf('SB-009')).toMatchObject({ phase: 'silent', since: '2026-10-19T12:00:00.000Z' });
  });

  test('the sweep follows the scan pagination instead of stopping at the first page', async () => {
    for (const unitId of ['SB-001', 'SB-002', 'SB-003']) {
      seedUnit(unitId);
      seedState(unitId, iso(30));
    }
    fake.scanPageSize = 1;

    await handler();

    expect(fake.log.slice(0, 4)).toEqual([
      'Scan snowball-units',
      'Scan snowball-units',
      'Scan snowball-units',
      'BatchGet snowball-unit-state',
    ]);
    expect(fake.rows('snowball-alerts')).toHaveLength(3);
    expect(fake.published).toHaveLength(3);
  });

  test('a failed publish leaves the state ok; the next sweep reuses the row and publishes', async () => {
    seedUnit('SB-002');
    seedState('SB-002', iso(12));
    fake.failNext('Publish', new Error('SNS throttled'));

    // The sweep swallows the per-unit failure: there is no batch protocol to
    // report it into, and the next minute retries.
    await handler();
    expect(fake.rows('snowball-alerts')).toHaveLength(1);
    expect(fake.published).toEqual([]);
    expect(signalOf('SB-002')).toBeUndefined();

    await handler();
    // The conditional put hits the existing row (insertAlert returns false),
    // so the email goes out once and the row is never duplicated.
    expect(fake.rows('snowball-alerts')).toHaveLength(1);
    expect(fake.published).toHaveLength(1);
    expect(signalOf('SB-002')).toMatchObject({ phase: 'silent' });
  });

  test('one unit failing does not stop the units after it', async () => {
    seedUnit('SB-001');
    seedState('SB-001', iso(20));
    seedUnit('SB-002');
    seedState('SB-002', iso(20));
    // SB-001 is swept first (scan order), and its unit lookup blows up.
    fake.failNext('Get snowball-units', new Error('DynamoDB unavailable'));

    await handler();

    expect(fake.rows('snowball-alerts')).toEqual([
      expect.objectContaining({ unit_id: 'SB-002' }),
    ]);
    expect(fake.published).toHaveLength(1);
    expect(signalOf('SB-001')).toBeUndefined();
    expect(signalOf('SB-002')).toMatchObject({ phase: 'silent' });
  });
});

describe('signal state — the _signal item', () => {
  beforeEach(() => {
    fake.reset();
  });

  test('an ok state writes no empty attributes (DynamoDB rejects undefined)', async () => {
    await saveSignalState('SB-001', { phase: 'ok' });
    expect(Object.keys(signalOf('SB-001') as object)).toEqual(['unit_id', 'ts', 'phase']);
    expect(await getSignalState('SB-001')).toEqual({ phase: 'ok' });
  });

  test('a silence round-trips with both timestamps, and an unknown unit reads as ok', async () => {
    const state = { phase: 'silent' as const, since: iso(30), observed_at: iso(90) };
    await saveSignalState('SB-009', state);
    expect(await getSignalState('SB-009')).toEqual(state);
    expect(await getSignalState('SB-404')).toEqual({ phase: 'ok' });
  });
});
