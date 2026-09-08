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

/** Row of the `device_config` table in RDS */
export interface ThresholdConfig {
  unit_id: string;
  temp_min_c: number;
  temp_max_c: number;
  /** minutes the deviation must be sustained before alerting */
  tolerance_min: number;
  setpoint_c: number;
}

export type ExcursionPhase = 'ok' | 'deviated' | 'alerted';

export interface ExcursionState {
  phase: ExcursionPhase;
  /** ISO-8601: instant of the first out-of-range reading of the ongoing excursion */
  since?: string;
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
  temp_c: number;
  lat: number;
  lon: number;
  detail: string;
}
