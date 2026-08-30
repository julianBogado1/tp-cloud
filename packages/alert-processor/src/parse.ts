import type { IngestedReading } from '@snowball/shared';

const NUMERIC_FIELDS = ['temp_c', 'humidity_pct', 'lat', 'lon', 'battery', 'signal', 'expires_at'] as const;

/**
 * Validates the SQS message body. A malformed message throws: the loop leaves
 * it undeleted and, after maxReceiveCount retries, SQS moves it to the DLQ.
 */
export function parseReading(body: string): IngestedReading {
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
  return obj as unknown as IngestedReading;
}
