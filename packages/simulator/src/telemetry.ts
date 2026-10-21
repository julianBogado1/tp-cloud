import type { Telemetry } from '@snowball/shared';

/** how much the target temperature rises during an excursion (open door / cooling failure) */
const EXCURSION_DELTA_C = 10;

export interface UnitState {
  unit_id: string;
  setpoint_c: number;
  temp_c: number;
  battery: number;
  lat: number;
  lon: number;
  inExcursion: boolean;
  /** thresholds received through the shadow; undefined until the first get/delta */
  temp_min_c?: number;
  temp_max_c?: number;
  tolerance_min?: number;
}

/**
 * Starting position per unit. They are trucks of the same cold chain in the
 * same metropolitan area, so they stay a few kilometres apart: far enough to
 * be told apart on the dashboard map at zoom 12-14, close enough that the
 * initial fitBounds still frames the whole fleet in one view. The default is
 * the Obelisco, for any unit id the simulator is asked for beyond these.
 */
const DEFAULT_ORIGIN: readonly [number, number] = [-34.6037, -58.3816];
const UNIT_ORIGIN: Readonly<Record<string, readonly [number, number]>> = {
  'SB-001': [-34.6037, -58.3816], // Obelisco, Buenos Aires
  'SB-002': [-34.5633, -58.4586], // Núñez
  'SB-003': [-34.6546, -58.3283], // Avellaneda
};

export function createUnit(unitId: string, setpointC: number): UnitState {
  const [lat, lon] = UNIT_ORIGIN[unitId] ?? DEFAULT_ORIGIN;
  return {
    unit_id: unitId,
    setpoint_c: setpointC,
    temp_c: setpointC,
    battery: 100,
    lat,
    lon,
    inExcursion: false,
  };
}

/**
 * One simulation step. Pure: clock and randomness are injected.
 * The temperature converges exponentially towards its target (the setpoint,
 * or setpoint + DELTA during an excursion) with small noise around it.
 */
export function generateReading(
  unit: UnitState,
  now: Date,
  rng: () => number,
): { reading: Telemetry; unit: UnitState } {
  const target = unit.inExcursion ? unit.setpoint_c + EXCURSION_DELTA_C : unit.setpoint_c;
  const temp = unit.temp_c + (target - unit.temp_c) * 0.25 + (rng() - 0.5) * 0.6;
  const battery = Math.max(0, unit.battery - 0.02);
  const lat = unit.lat + (rng() - 0.5) * 0.002;
  const lon = unit.lon + (rng() - 0.5) * 0.002;

  const next: UnitState = { ...unit, temp_c: temp, battery, lat, lon };
  const reading: Telemetry = {
    unit_id: unit.unit_id,
    ts: now.toISOString(),
    temp_c: Math.round(temp * 100) / 100,
    humidity_pct: Math.round((55 + rng() * 15) * 10) / 10,
    lat: Math.round(lat * 1e6) / 1e6,
    lon: Math.round(lon * 1e6) / 1e6,
    battery: Math.round(battery * 10) / 10,
    signal: 2 + Math.floor(rng() * 4),
  };
  return { reading, unit: next };
}
