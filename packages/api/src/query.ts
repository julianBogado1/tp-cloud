/**
 * Query-string parsing for GET /api/units/:id/telemetry.
 *
 * The DynamoDB sort key holds ISO-8601 timestamps plus the fixed `_state`
 * item the alert processor keeps per unit. `_` (0x5F) sorts after `9`
 * (0x39), so bounds restricted to [0-9] prefixes can never return it:
 * the defaults 0..9999 cover every ISO ts and nothing else.
 */

export interface TelemetryQuery {
  from: string;
  to: string;
  limit: number;
}

const MAX_LIMIT = 5000;
const ISO_PREFIX = /^[0-9][0-9T:.Z+-]*$/;

export function parseTelemetryQuery(params: {
  from?: string;
  to?: string;
  limit?: string;
}): TelemetryQuery {
  const from = params.from ?? '0';
  const to = params.to ?? '9999';
  if (!ISO_PREFIX.test(from)) throw new Error(`"from" must be an ISO-8601 prefix, got "${params.from}"`);
  if (!ISO_PREFIX.test(to)) throw new Error(`"to" must be an ISO-8601 prefix, got "${params.to}"`);

  let limit = 500;
  if (params.limit !== undefined) {
    limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(`"limit" must be an integer between 1 and ${MAX_LIMIT}, got "${params.limit}"`);
    }
  }
  return { from, to, limit };
}
