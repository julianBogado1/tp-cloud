import { describe, expect, test } from 'vitest';
import { applyDesired, isOutOfRange, reportedDoc, shadowTopics } from '../src/device-config';
import { createUnit } from '../src/telemetry';

describe('device config from the shadow', () => {
  test('applies every config field present in the delta', () => {
    const delta = { setpoint_c: -20, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5 };
    const { unit, applied } = applyDesired(createUnit('SB-001', -18), delta);
    expect(unit).toMatchObject(delta);
    expect(applied).toEqual(delta);
  });

  test('ignores unknown and non-numeric delta fields', () => {
    const u = createUnit('SB-001', -18);
    const { unit, applied } = applyDesired(u, { setpoint_c: 'x', foo: 1 });
    expect(applied).toEqual({});
    expect(unit).toEqual(u);
  });

  test('ignores a missing or non-object state', () => {
    const u = createUnit('SB-001', -18);
    expect(applyDesired(u, undefined)).toEqual({ unit: u, applied: {} });
    expect(applyDesired(u, 'garbage')).toEqual({ unit: u, applied: {} });
  });

  test('applied only lists fields whose value changed', () => {
    const { applied } = applyDesired(createUnit('SB-001', -18), { setpoint_c: -18, temp_max_c: -15 });
    expect(applied).toEqual({ temp_max_c: -15 });
  });

  test('reportedDoc omits undefined thresholds', () => {
    expect(reportedDoc(createUnit('SB-001', -18))).toEqual({ state: { reported: { setpoint_c: -18 } } });
  });

  test('isOutOfRange is false without bounds and true outside them', () => {
    expect(isOutOfRange(createUnit('SB-001', -18), 100)).toBe(false);
    const { unit } = applyDesired(createUnit('SB-001', -18), { temp_min_c: -25, temp_max_c: -15 });
    expect(isOutOfRange(unit, -14)).toBe(true);
    expect(isOutOfRange(unit, -20)).toBe(false);
  });

  test('shadowTopics builds the classic shadow topics', () => {
    expect(shadowTopics('SB-001').getAccepted).toBe('$aws/things/SB-001/shadow/get/accepted');
    expect(shadowTopics('SB-001').delta).toBe('$aws/things/SB-001/shadow/update/delta');
  });
});
