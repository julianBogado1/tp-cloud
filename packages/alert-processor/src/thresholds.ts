import { Pool } from 'pg';
import type { ThresholdConfig } from '@snowball/shared';
import { envAsNumber } from '@snowball/shared';

/**
 * Per-unit thresholds from the `device_config` table in RDS, with an
 * in-memory cache: at ~1 reading per second per unit a SELECT per message
 * makes no sense, and 60s of staleness on a threshold is acceptable.
 *
 * The connection uses the standard pg variables: PGHOST, PGPORT, PGDATABASE,
 * PGUSER, PGPASSWORD.
 */

const CACHE_TTL_MS = envAsNumber('THRESHOLDS_CACHE_MS', 60_000);

interface CacheEntry {
  config: ThresholdConfig | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      max: 3,
      ssl: process.env.PGSSL === 'disable' ? undefined : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function getThreshold(unitId: string): Promise<ThresholdConfig | null> {
  const now = Date.now();
  const cached = cache.get(unitId);
  if (cached && cached.expiresAt > now) return cached.config;

  const { rows } = await getPool().query(
    `SELECT unit_id, temp_min_c, temp_max_c, tolerance_min, setpoint_c
       FROM device_config WHERE unit_id = $1`,
    [unitId],
  );
  const config: ThresholdConfig | null = rows[0]
    ? {
        unit_id: rows[0].unit_id,
        temp_min_c: Number(rows[0].temp_min_c),
        temp_max_c: Number(rows[0].temp_max_c),
        tolerance_min: Number(rows[0].tolerance_min),
        setpoint_c: Number(rows[0].setpoint_c),
      }
    : null;
  cache.set(unitId, { config, expiresAt: now + CACHE_TTL_MS });
  return config;
}

export async function insertAlert(alert: {
  unit_id: string;
  severity: string;
  since: string;
  ts: string;
  duration_min: number;
  temp_c: number;
  detail: string;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO alerts (unit_id, severity, since, emitted_at, duration_min, temp_c, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [alert.unit_id, alert.severity, alert.since, alert.ts, alert.duration_min, alert.temp_c, alert.detail],
  );
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
