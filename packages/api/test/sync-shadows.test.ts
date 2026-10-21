import { expect, test } from 'vitest';
import { desiredDocument } from '../../../scripts/sync-shadows';

test('builds a desired document with all four fields from a config row', () => {
  const doc = desiredDocument({ unit_id: 'SB-001', setpoint_c: -18, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5 });
  expect(doc).toEqual({ state: { desired: { setpoint_c: -18, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5 } } });
  expect(doc.state.desired).not.toHaveProperty('unit_id');
});
