import { DEVICE_CONFIG_FIELDS, pickDeviceConfig, type DeviceConfig } from '@snowball/shared';
import type { UnitState } from './telemetry';

/**
 * Remote configuration on the device side. Pure (no MQTT, no clock): index.ts
 * feeds it the Device Shadow messages and publishes what it returns.
 */

export interface ApplyResult {
  unit: UnitState;
  /** fields whose value actually changed; {} when the delta was a no-op or garbage */
  applied: Partial<DeviceConfig>;
}

/** Applies a delta `state` or a get/accepted `state.desired` to the unit. */
export function applyDesired(unit: UnitState, state: unknown): ApplyResult {
  if (typeof state !== 'object' || state === null) return { unit, applied: {} };
  const incoming = pickDeviceConfig(state as Record<string, unknown>);
  const applied: Partial<DeviceConfig> = {};
  for (const field of DEVICE_CONFIG_FIELDS) {
    const value = incoming[field];
    if (value !== undefined && value !== unit[field]) applied[field] = value;
  }
  if (Object.keys(applied).length === 0) return { unit, applied };
  return { unit: { ...unit, ...applied }, applied };
}

/** Message to publish on $aws/things/<unit>/shadow/update. */
export interface ReportedDocument {
  state: { reported: Partial<DeviceConfig> };
}

export function reportedDoc(unit: UnitState): ReportedDocument {
  return { state: { reported: pickDeviceConfig({ ...unit }) } };
}

/** Local alarm rule: false while either bound is unknown. */
export function isOutOfRange(unit: UnitState, tempC: number): boolean {
  if (unit.temp_min_c === undefined || unit.temp_max_c === undefined) return false;
  return tempC < unit.temp_min_c || tempC > unit.temp_max_c;
}

/** Classic (unnamed) shadow topics of a unit. */
export function shadowTopics(unitId: string) {
  const base = `$aws/things/${unitId}/shadow`;
  return {
    update: `${base}/update`,
    delta: `${base}/update/delta`,
    get: `${base}/get`,
    getAccepted: `${base}/get/accepted`,
    getRejected: `${base}/get/rejected`,
  };
}
