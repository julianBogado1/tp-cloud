import type { Alert, IngestedReading, SignalRecovery, SignalState } from '@snowball/shared';

export interface SilenceEvaluation {
  state: SignalState;
  /** set exactly once per silence, on the sweep that crosses the timeout */
  alert?: Alert;
  /** set exactly once per silence, on the sweep that sees the unit report again */
  recovery?: SignalRecovery;
}

/**
 * No-signal state machine, per unit.
 *
 *   ok ──silence ≥ timeout──▶ silent ──┐
 *   ▲                                  │
 *   └──────fresh reading───────────────┘
 *
 * Pure, but unlike `evaluate` the time comes from `nowMs` and not from a
 * reading: the condition here *is* the wall clock, since the absence of data
 * produces no event to take a timestamp from. Passing the clock in keeps the
 * decision testable without fake timers.
 *
 * `timeoutMin` and `unitId` arrive resolved so the env read and the
 * never-reported case (no reading to take the id from) stay with the caller.
 */
export function evaluateSilence(
  unitId: string,
  state: SignalState,
  lastReading: IngestedReading | null,
  timeoutMin: number,
  nowMs: number,
): SilenceEvaluation {
  if (lastReading === null) {
    return neverReported(unitId, state, timeoutMin, nowMs);
  }

  const silentMin = minutesSince(lastReading.ts, nowMs);

  if (silentMin < timeoutMin) {
    if (state.phase !== 'silent') {
      return { state: { phase: 'ok' } };
    }
    const since = state.since ?? lastReading.ts;
    const silentFor = minutesBetween(since, lastReading.ts);
    return {
      state: { phase: 'ok' },
      recovery: {
        unit_id: unitId,
        since,
        ts: lastReading.ts,
        silent_min: round1(silentFor),
        detail:
          `Unit ${unitId}: reporting again after ${Math.round(silentFor)} min of silence`,
      },
    };
  }

  if (state.phase === 'silent') {
    return { state };
  }

  return {
    state: { phase: 'silent', since: lastReading.ts },
    alert: {
      unit_id: unitId,
      severity: 'no-signal',
      since: lastReading.ts,
      ts: new Date(nowMs).toISOString(),
      duration_min: round1(silentMin),
      temp_c: lastReading.temp_c,
      lat: lastReading.lat,
      lon: lastReading.lon,
      detail:
        `Unit ${unitId}: no telemetry for ${Math.round(silentMin)} min ` +
        `(last reading ${lastReading.ts}). Last position: ${lastReading.lat}, ${lastReading.lon}`,
    },
  };
}

/**
 * Provisioned but never seen: the silence is counted from the first sweep that
 * observed the unit. `observed_at` carries forward so `since` stays stable,
 * which is what keeps the alert id deterministic and the insert idempotent.
 */
function neverReported(
  unitId: string,
  state: SignalState,
  timeoutMin: number,
  nowMs: number,
): SilenceEvaluation {
  if (state.phase === 'silent') {
    return { state };
  }

  const observedAt = state.observed_at ?? new Date(nowMs).toISOString();
  const silentMin = minutesSince(observedAt, nowMs);

  if (silentMin < timeoutMin) {
    return { state: { phase: 'ok', observed_at: observedAt } };
  }

  return {
    state: { phase: 'silent', since: observedAt, observed_at: observedAt },
    alert: {
      unit_id: unitId,
      severity: 'no-signal',
      since: observedAt,
      ts: new Date(nowMs).toISOString(),
      duration_min: round1(silentMin),
      temp_c: null,
      lat: null,
      lon: null,
      detail:
        `Unit ${unitId}: no telemetry ever received ` +
        `(${Math.round(silentMin)} min since first seen by the monitor)`,
    },
  };
}

function minutesSince(iso: string, nowMs: number): number {
  return (nowMs - Date.parse(iso)) / 60_000;
}

function minutesBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 60_000;
}

function round1(minutes: number): number {
  return Math.round(minutes * 10) / 10;
}
