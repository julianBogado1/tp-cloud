import type { Alert, ExcursionState, IngestedReading, ThresholdConfig } from '@snowball/shared';

export interface EvaluationResult {
  state: ExcursionState;
  alert?: Alert;
}

/**
 * Thermal-excursion state machine, per unit.
 *
 *   ok ──out of range──▶ deviated ──sustained ≥ tolerance──▶ alerted
 *   ▲                        │                                   │
 *   └──────back in range─────┴───────────back in range───────────┘
 *
 * Pure: time comes from `reading.ts`, never from the process clock, so a
 * backed-up queue evaluates the same as a live one and the function stays
 * testable. Emits the alert exactly once per excursion, when the tolerance
 * is exceeded.
 */
export function evaluate(
  state: ExcursionState,
  reading: IngestedReading,
  config: ThresholdConfig,
): EvaluationResult {
  const inRange = reading.temp_c >= config.temp_min_c && reading.temp_c <= config.temp_max_c;

  if (inRange) {
    return { state: { phase: 'ok' } };
  }

  if (state.phase === 'ok') {
    return { state: { phase: 'deviated', since: reading.ts } };
  }

  if (state.phase === 'alerted') {
    return { state };
  }

  const since = state.since ?? reading.ts;
  const minutesDeviated = (Date.parse(reading.ts) - Date.parse(since)) / 60_000;
  if (minutesDeviated < config.tolerance_min) {
    return { state };
  }

  const alert: Alert = {
    unit_id: reading.unit_id,
    severity: 'thermal-excursion',
    since,
    ts: reading.ts,
    duration_min: Math.round(minutesDeviated * 10) / 10,
    temp_c: reading.temp_c,
    lat: reading.lat,
    lon: reading.lon,
    detail:
      `Unit ${reading.unit_id}: ${reading.temp_c}°C out of range ` +
      `[${config.temp_min_c}, ${config.temp_max_c}] sustained for ${Math.round(minutesDeviated)} min`,
  };
  return { state: { phase: 'alerted', since }, alert };
}
