import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Pool } from 'pg';
import type { IngestedReading } from '@snowball/shared';
import { NAMES } from '@snowball/shared';
import type { TelemetryQuery } from './query';
import type { AlertRow, DataAccess, UnitRow } from './routes';

/**
 * Real data access: units/config/alerts from RDS (standard PG* variables),
 * telemetry from DynamoDB. The `9999` upper bound keeps the `_state` item
 * (the alert processor's per-unit excursion state, SK `_state`) out of every
 * result — `_` sorts after `9`.
 */

const TABLE = process.env.DDB_TABLE ?? NAMES.telemetryTable;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      max: 5,
      ssl: process.env.PGSSL === 'disable' ? undefined : { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function listUnits(): Promise<UnitRow[]> {
  const { rows } = await getPool().query(
    `SELECT u.unit_id, u.description, u.active,
            c.setpoint_c, c.temp_min_c, c.temp_max_c
       FROM units u LEFT JOIN device_config c USING (unit_id)
      WHERE u.active ORDER BY u.unit_id`,
  );
  return rows.map((r) => ({
    unit_id: r.unit_id,
    description: r.description,
    active: r.active,
    setpoint_c: r.setpoint_c === null ? null : Number(r.setpoint_c),
    temp_min_c: r.temp_min_c === null ? null : Number(r.temp_min_c),
    temp_max_c: r.temp_max_c === null ? null : Number(r.temp_max_c),
  }));
}

async function latestReading(unitId: string): Promise<IngestedReading | undefined> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'unit_id = :u AND ts BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':u': unitId, ':from': '0', ':to': '9999' },
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  return Items?.[0] as IngestedReading | undefined;
}

async function queryTelemetry(unitId: string, query: TelemetryQuery): Promise<IngestedReading[]> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'unit_id = :u AND ts BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':u': unitId, ':from': query.from, ':to': query.to },
      ScanIndexForward: false,
      Limit: query.limit,
    }),
  );
  return (Items ?? []) as IngestedReading[];
}

/** For the live feed: readings strictly after sinceTs (or just the latest one on first call). */
export async function queryNewReadings(
  unitId: string,
  sinceTs: string | undefined,
): Promise<IngestedReading[]> {
  if (sinceTs === undefined) {
    const latest = await latestReading(unitId);
    return latest ? [latest] : [];
  }
  // ' ' (0x20) is the smallest printable char: `sinceTs + ' '` is the tightest
  // lower bound that excludes sinceTs itself while admitting every later ts.
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'unit_id = :u AND ts BETWEEN :from AND :to',
      ExpressionAttributeValues: { ':u': unitId, ':from': `${sinceTs} `, ':to': '9999' },
      Limit: 100,
    }),
  );
  return (Items ?? []) as IngestedReading[];
}

async function listAlerts(limit: number): Promise<AlertRow[]> {
  const { rows } = await getPool().query(
    `SELECT id, unit_id, severity, since, emitted_at, duration_min, temp_c, detail, acknowledged_at
       FROM alerts ORDER BY emitted_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    unit_id: r.unit_id,
    severity: r.severity,
    since: r.since.toISOString(),
    emitted_at: r.emitted_at.toISOString(),
    duration_min: Number(r.duration_min),
    temp_c: r.temp_c === null ? null : Number(r.temp_c),
    detail: r.detail,
    acknowledged_at: r.acknowledged_at ? r.acknowledged_at.toISOString() : null,
  }));
}

export const dataAccess: DataAccess = { listUnits, latestReading, queryTelemetry, listAlerts };

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
