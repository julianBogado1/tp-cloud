import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { Pool } from 'pg';
import type { IngestedReading, ThresholdConfig } from '@snowball/shared';
import { NAMES } from '@snowball/shared';
import type { Scope } from './auth/scope';
import { unitScopeSql } from './auth/scope';
import {
  DuplicateEmailError,
  type AckResult,
  type AlertRow,
  type ConfigPatch,
  type DataAccess,
  type NewUser,
  type UnitRow,
  type UserPatch,
  type UserRecord,
  type UserRow,
} from './data-access';
import type { TelemetryQuery } from './query';

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

async function listUnits(scope: Scope): Promise<UnitRow[]> {
  const { sql, params } = unitScopeSql(scope, 1);
  const { rows } = await getPool().query(
    `SELECT u.unit_id, u.description, u.active,
            c.setpoint_c, c.temp_min_c, c.temp_max_c
       FROM units u LEFT JOIN device_config c USING (unit_id)
      WHERE u.active${sql} ORDER BY u.unit_id`,
    params,
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

async function listUnitIds(scope: Scope): Promise<string[]> {
  const { sql, params } = unitScopeSql(scope, 1);
  const { rows } = await getPool().query(
    `SELECT u.unit_id FROM units u WHERE u.active${sql} ORDER BY u.unit_id`,
    params,
  );
  return rows.map((r) => r.unit_id as string);
}

async function unitInScope(unitId: string, scope: Scope): Promise<boolean> {
  const { sql, params } = unitScopeSql(scope, 2);
  const { rowCount } = await getPool().query(
    `SELECT 1 FROM units u WHERE u.unit_id = $1${sql}`,
    [unitId, ...params],
  );
  return (rowCount ?? 0) > 0;
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

function mapAlert(r: Record<string, unknown>): AlertRow {
  return {
    id: Number(r.id),
    unit_id: r.unit_id as string,
    severity: r.severity as string,
    since: (r.since as Date).toISOString(),
    emitted_at: (r.emitted_at as Date).toISOString(),
    duration_min: Number(r.duration_min),
    temp_c: r.temp_c === null ? null : Number(r.temp_c),
    detail: r.detail as string,
    acknowledged_by: r.acknowledged_by === null ? null : Number(r.acknowledged_by),
    acknowledged_at: r.acknowledged_at ? (r.acknowledged_at as Date).toISOString() : null,
  };
}

const ALERT_COLUMNS = `a.id, a.unit_id, a.severity, a.since, a.emitted_at, a.duration_min,
                       a.temp_c, a.detail, a.acknowledged_by, a.acknowledged_at`;

async function listAlerts(limit: number, scope: Scope): Promise<AlertRow[]> {
  const { sql, params } = unitScopeSql(scope, 2);
  const { rows } = await getPool().query(
    `SELECT ${ALERT_COLUMNS}
       FROM alerts a JOIN units u USING (unit_id)
      WHERE true${sql}
      ORDER BY a.emitted_at DESC LIMIT $1`,
    [limit, ...params],
  );
  return rows.map(mapAlert);
}

async function acknowledgeAlert(alertId: number, userId: number, scope: Scope): Promise<AckResult> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { sql, params } = unitScopeSql(scope, 2);
    const found = await client.query(
      `SELECT a.acknowledged_at FROM alerts a JOIN units u USING (unit_id)
        WHERE a.id = $1${sql} FOR UPDATE OF a`,
      [alertId, ...params],
    );
    if (found.rowCount === 0) {
      await client.query('ROLLBACK');
      return { status: 'not-found' };
    }
    if (found.rows[0].acknowledged_at !== null) {
      await client.query('ROLLBACK');
      return { status: 'already' };
    }
    const updated = await client.query(
      `UPDATE alerts a SET acknowledged_by = $2, acknowledged_at = now()
        WHERE a.id = $1
        RETURNING ${ALERT_COLUMNS}`,
      [alertId, userId],
    );
    await client.query('COMMIT');
    return { status: 'ok', alert: mapAlert(updated.rows[0]) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

function mapUser(r: Record<string, unknown>): UserRecord {
  return {
    id: Number(r.id),
    email: r.email as string,
    role: r.role as UserRecord['role'],
    client_id: r.client_id === null ? null : Number(r.client_id),
    active: Boolean(r.active),
    password_hash: r.password_hash as string,
  };
}

async function findUserByEmail(email: string): Promise<UserRecord | undefined> {
  const { rows } = await getPool().query(
    `SELECT id, email, role, client_id, active, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ? mapUser(rows[0]) : undefined;
}

function mapConfig(r: Record<string, unknown>): ThresholdConfig {
  return {
    unit_id: r.unit_id as string,
    setpoint_c: Number(r.setpoint_c),
    temp_min_c: Number(r.temp_min_c),
    temp_max_c: Number(r.temp_max_c),
    tolerance_min: Number(r.tolerance_min),
  };
}

async function getConfig(unitId: string): Promise<ThresholdConfig | undefined> {
  const { rows } = await getPool().query(
    `SELECT unit_id, setpoint_c, temp_min_c, temp_max_c, tolerance_min FROM device_config WHERE unit_id = $1`,
    [unitId],
  );
  return rows[0] ? mapConfig(rows[0]) : undefined;
}

// Local whitelist: `field` is interpolated directly into the SQL below, so
// this guard is what makes that safe at the point of danger — not just the
// ConfigPatch type, which is erased at runtime.
const CONFIG_COLUMNS = new Set(['setpoint_c', 'temp_min_c', 'temp_max_c', 'tolerance_min']);

async function updateConfig(unitId: string, patch: ConfigPatch): Promise<ThresholdConfig> {
  const sets: string[] = [];
  const params: unknown[] = [unitId];
  for (const [field, value] of Object.entries(patch)) {
    if (!CONFIG_COLUMNS.has(field)) throw new Error(`unexpected config field ${field}`);
    params.push(value);
    sets.push(`${field} = $${params.length}`);
  }
  if (sets.length === 0) throw new Error('empty patch');
  const { rows } = await getPool().query(
    `UPDATE device_config SET ${sets.join(', ')}, updated_at = now()
      WHERE unit_id = $1
      RETURNING unit_id, setpoint_c, temp_min_c, temp_max_c, tolerance_min`,
    params,
  );
  if (!rows[0]) throw new Error(`device_config row missing for ${unitId}`);
  return mapConfig(rows[0]);
}

const USER_COLUMNS = 'id, email, role, client_id, active';

function mapUserRow(r: Record<string, unknown>): UserRow {
  const { password_hash: _h, ...row } = mapUser({ ...r, password_hash: '' });
  return row;
}

async function listUsers(): Promise<UserRow[]> {
  const { rows } = await getPool().query(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`);
  return rows.map(mapUserRow);
}

async function findUserById(id: number): Promise<UserRow | undefined> {
  const { rows } = await getPool().query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return rows[0] ? mapUserRow(rows[0]) : undefined;
}

async function createUser(input: NewUser): Promise<UserRow> {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO users (email, password_hash, role, client_id) VALUES ($1, $2, $3, $4)
       RETURNING ${USER_COLUMNS}`,
      [input.email, input.password_hash, input.role, input.client_id],
    );
    return mapUserRow(rows[0]);
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new DuplicateEmailError(input.email);
    throw err;
  }
}

// Local whitelist: `field` is interpolated directly into the SQL below, so
// this guard is what makes that safe at the point of danger — not just the
// UserPatch type, which is erased at runtime.
const USER_PATCH_COLUMNS = new Set(['active', 'role', 'client_id']);

async function updateUser(id: number, patch: UserPatch): Promise<UserRow | undefined> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [field, value] of Object.entries(patch)) {
    if (!USER_PATCH_COLUMNS.has(field)) throw new Error(`unexpected user field ${field}`);
    params.push(value);
    sets.push(`${field} = $${params.length}`);
  }
  if (sets.length === 0) throw new Error('empty patch');
  const { rows } = await getPool().query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING ${USER_COLUMNS}`,
    params,
  );
  return rows[0] ? mapUserRow(rows[0]) : undefined;
}

async function clientExists(id: number): Promise<boolean> {
  const { rowCount } = await getPool().query(`SELECT 1 FROM clients WHERE id = $1`, [id]);
  return (rowCount ?? 0) > 0;
}

export const dataAccess: DataAccess = {
  listUnits,
  listUnitIds,
  unitInScope,
  latestReading,
  queryTelemetry,
  listAlerts,
  findUserByEmail,
  acknowledgeAlert,
  getConfig,
  updateConfig,
  listUsers,
  findUserById,
  createUser,
  updateUser,
  clientExists,
};

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
