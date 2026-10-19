/**
 * Shared types between the simulator, the IoT Core rule and the backend.
 *
 * The MQTT payload is exactly `Telemetry`. The IoT Core rule
 *
 *   SELECT *, topic(2) AS unit_id, floor(timestamp() / 1000) + 2592000 AS expires_at
 *   FROM 'snowball/+/telemetry'
 *
 * adds `unit_id` from the topic and the server-side TTL, so what reaches
 * DynamoDB (both tables) and SQS is `IngestedReading`. The simulator also
 * includes `unit_id` in the payload so both match byte for byte.
 */

export interface Telemetry {
  unit_id: string;
  /** ISO-8601 UTC — DynamoDB sort key of the history table, sorts lexicographically */
  ts: string;
  temp_c: number;
  humidity_pct: number;
  lat: number;
  lon: number;
  /** percentage 0-100 */
  battery: number;
  /** signal quality 0-5 */
  signal: number;
}

/** What the rule writes: the device payload plus the TTL it computed. */
export interface IngestedReading extends Telemetry {
  /** epoch seconds for the DynamoDB TTL — ingestion instant + 30 days, set by the rule, never by the device */
  expires_at: number;
}

/** Row of the `device-config` DynamoDB table */
export interface ThresholdConfig {
  unit_id: string;
  temp_min_c: number;
  temp_max_c: number;
  /** minutes the deviation must be sustained before alerting */
  tolerance_min: number;
  setpoint_c: number;
  /** minutes without a reading before the unit counts as silent; the monitor falls back to NO_SIGNAL_TIMEOUT_MIN */
  signal_timeout_min?: number;
}

export type ExcursionPhase = 'ok' | 'deviated' | 'alerted';

export interface ExcursionState {
  phase: ExcursionPhase;
  /** ISO-8601: instant of the first out-of-range reading of the ongoing excursion */
  since?: string;
}

export type SignalPhase = 'ok' | 'silent';

/** Persisted as the `_signal` item of the telemetry table, next to `_state`. */
export interface SignalState {
  phase: SignalPhase;
  /** ISO-8601: instant the silence started — the last reading's ts */
  since?: string;
  /** ISO-8601: first sweep that saw the unit, set only when it never reported */
  observed_at?: string;
}

export type AlertSeverity = 'thermal-excursion' | 'low-battery' | 'no-signal';

export interface Alert {
  unit_id: string;
  severity: AlertSeverity;
  /** start of the deviation */
  since: string;
  /** instant the tolerance was exceeded and the alert was emitted */
  ts: string;
  duration_min: number;
  /** last known values; null only for a no-signal alert on a unit that never reported */
  temp_c: number | null;
  lat: number | null;
  lon: number | null;
  detail: string;
}

/**
 * A silent unit started reporting again. Published to the no-signal topic, but
 * never written to the alerts table: it is not an alert.
 */
export interface SignalRecovery {
  unit_id: string;
  /** instant the silence started */
  since: string;
  /** ts of the reading that ended the silence */
  ts: string;
  silent_min: number;
  detail: string;
}
