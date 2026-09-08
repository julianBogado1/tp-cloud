import type { Telemetry } from '@snowball/shared';

const NUMERIC_FIELDS = ['temp_c', 'humidity_pct', 'lat', 'lon', 'battery', 'signal'] as const;

/**
 * Validates the SQS message body. A malformed message throws: the loop leaves
 * it undeleted and, after maxReceiveCount retries, SQS moves it to the DLQ.
 *
 * `expires_at` is added by the IoT rule and is irrelevant here, so it is only
 * checked when present: a device payload without it still parses.
 */
export function parseReading(body: string): Telemetry {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error(`message body is not JSON: ${body.slice(0, 120)}`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.unit_id !== 'string' || obj.unit_id.length === 0) {
    throw new Error('reading without unit_id');
  }
  if (typeof obj.ts !== 'string' || Number.isNaN(Date.parse(obj.ts))) {
    throw new Error(`reading with invalid ts: ${String(obj.ts)}`);
  }
  for (const field of NUMERIC_FIELDS) {
    if (typeof obj[field] !== 'number' || Number.isNaN(obj[field])) {
      throw new Error(`reading with invalid ${field}: ${String(obj[field])}`);
    }
  }
  if (obj.expires_at !== undefined && (typeof obj.expires_at !== 'number' || Number.isNaN(obj.expires_at))) {
    throw new Error(`reading with invalid expires_at: ${String(obj.expires_at)}`);
  }
  return obj as unknown as Telemetry;
}
