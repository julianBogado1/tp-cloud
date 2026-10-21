import { expect, test } from 'vitest';
import { DEVICE_CONFIG_FIELDS, pickDeviceConfig } from '../src/types';

test('pickDeviceConfig keeps only finite numeric config fields', () => {
  expect(pickDeviceConfig({ setpoint_c: -18, temp_min_c: 'x', foo: 1, tolerance_min: NaN, temp_max_c: -15 }))
    .toEqual({ setpoint_c: -18, temp_max_c: -15 });
});

test('DEVICE_CONFIG_FIELDS lists the four fields in order', () => {
  expect(DEVICE_CONFIG_FIELDS).toEqual(['setpoint_c', 'temp_min_c', 'temp_max_c', 'tolerance_min']);
});
