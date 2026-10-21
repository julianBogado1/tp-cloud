import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import type { IngestedReading, ThresholdConfig } from '@snowball/shared';
import { NAMES } from '@snowball/shared';
import type { Scope } from '../auth/scope';
import { batchGetAll } from '../batch-get';
import type { TelemetryQuery } from '../query';
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
} from '../data-access';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const table = (name: string, envName: string) => process.env[envName] ?? name;
const tables = {
  telemetry: table(NAMES.telemetryTable, 'DDB_TABLE'),
  state: table(NAMES.unitStateTable, 'DDB_STATE_TABLE'),
  users: table(NAMES.usersTable, 'DDB_USERS_TABLE'),
  clients: table(NAMES.clientsTable, 'DDB_CLIENTS_TABLE'),
  units: table(NAMES.unitsTable, 'DDB_UNITS_TABLE'),
  alerts: table(NAMES.alertsTable, 'DDB_ALERTS_TABLE'),
  config: table(NAMES.deviceConfigTable, 'DDB_DEVICE_CONFIG_TABLE'),
};

const asIso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);
const mapConfig = (item: Record<string, unknown>): ThresholdConfig => ({
  unit_id: String(item.unit_id),
  setpoint_c: Number(item.setpoint_c),
  temp_min_c: Number(item.temp_min_c),
  temp_max_c: Number(item.temp_max_c),
  tolerance_min: Number(item.tolerance_min),
});
const mapUser = (item: Record<string, unknown>): UserRecord => ({
  id: Number(item.id),
  email: String(item.email),
  role: item.role as UserRecord['role'],
  client_id: item.client_id == null ? null : Number(item.client_id),
  active: Boolean(item.active),
  password_hash: String(item.password_hash),
});
const publicUser = (item: Record<string, unknown>): UserRow => {
  const user = mapUser({ ...item, password_hash: item.password_hash ?? '' });
  const { password_hash: _passwordHash, ...result } = user;
  return result;
};
const mapAlert = (item: Record<string, unknown>): AlertRow => ({
  id: Number(item.id),
  unit_id: String(item.unit_id),
  severity: String(item.severity),
  since: asIso(item.since),
  emitted_at: asIso(item.emitted_at),
  duration_min: Number(item.duration_min),
  temp_c: item.temp_c == null ? null : Number(item.temp_c),
  detail: String(item.detail),
  acknowledged_by: item.acknowledged_by == null ? null : Number(item.acknowledged_by),
  acknowledged_at: item.acknowledged_at == null ? null : asIso(item.acknowledged_at),
});

async function queryAll(input: ConstructorParameters<typeof QueryCommand>[0]): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...((page.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return items;
}

async function listUnits(scope: Scope): Promise<UnitRow[]> {
  const items = scope.all
    ? (await ddb.send(new ScanCommand({ TableName: tables.units }))).Items ?? []
    : await queryAll({ TableName: tables.units, IndexName: 'client_id-index', KeyConditionExpression: 'client_id = :client', ExpressionAttributeValues: { ':client': scope.clientId } });
  const configs = await Promise.all(items.map((item) => ddb.send(new GetCommand({ TableName: tables.config, Key: { unit_id: item.unit_id } }))));
  return items.filter((item) => item.active !== false).map((item, index) => ({
    unit_id: String(item.unit_id), description: (item.description as string | null) ?? null, active: item.active !== false,
    setpoint_c: configs[index].Item?.setpoint_c == null ? null : Number(configs[index].Item.setpoint_c),
    temp_min_c: configs[index].Item?.temp_min_c == null ? null : Number(configs[index].Item.temp_min_c),
    temp_max_c: configs[index].Item?.temp_max_c == null ? null : Number(configs[index].Item.temp_max_c),
    tolerance_min: configs[index].Item?.tolerance_min == null ? null : Number(configs[index].Item.tolerance_min),
    signal_timeout_min: configs[index].Item?.signal_timeout_min == null ? null : Number(configs[index].Item.signal_timeout_min),
  })).sort((a, b) => a.unit_id.localeCompare(b.unit_id));
}
async function listUnitIds(scope: Scope): Promise<string[]> { return (await listUnits(scope)).map((unit) => unit.unit_id); }
async function unitInScope(unitId: string, scope: Scope): Promise<boolean> {
  const { Item } = await ddb.send(new GetCommand({ TableName: tables.units, Key: { unit_id: unitId } }));
  return Boolean(Item && Item.active !== false && (scope.all || Number(Item.client_id) === scope.clientId));
}
async function latestReading(unitId: string): Promise<IngestedReading | undefined> { return (await ddb.send(new GetCommand({ TableName: tables.state, Key: { unit_id: unitId } }))).Item as IngestedReading | undefined; }
function latestReadings(unitIds: string[]): Promise<Map<string, IngestedReading>> { return batchGetAll((cmd: BatchGetCommand) => ddb.send(cmd), tables.state, unitIds); }
async function queryTelemetry(unitId: string, query: TelemetryQuery): Promise<IngestedReading[]> {
  const { Items } = await ddb.send(new QueryCommand({ TableName: tables.telemetry, KeyConditionExpression: 'unit_id = :u AND ts BETWEEN :from AND :to', ExpressionAttributeValues: { ':u': unitId, ':from': query.from, ':to': query.to }, ScanIndexForward: false, Limit: query.limit }));
  return (Items ?? []) as IngestedReading[];
}
async function listAlerts(limit: number, scope: Scope): Promise<AlertRow[]> {
  const items = scope.all
    ? (await ddb.send(new ScanCommand({ TableName: tables.alerts, Limit: limit }))).Items ?? []
    : await queryAll({ TableName: tables.alerts, IndexName: 'client_id-emitted_at-index', KeyConditionExpression: 'client_id = :client', ExpressionAttributeValues: { ':client': scope.clientId }, ScanIndexForward: false });
  return items.map(mapAlert).sort((a, b) => b.emitted_at.localeCompare(a.emitted_at)).slice(0, limit);
}
async function acknowledgeAlert(alertId: number, userId: number, scope: Scope): Promise<AckResult> {
  const existing = (await ddb.send(new GetCommand({ TableName: tables.alerts, Key: { id: alertId } }))).Item;
  if (!existing || (!scope.all && Number(existing.client_id) !== scope.clientId)) return { status: 'not-found' };
  if (existing.acknowledged_at != null) return { status: 'already' };
  try {
    // `insertAlert` writes acknowledged_at as an explicit NULL, and in DynamoDB a
    // NULL-typed attribute EXISTS: attribute_not_exists() alone is false for every
    // row the alert processor creates, so every ack used to fail as 'already'.
    const updated = await ddb.send(new UpdateCommand({ TableName: tables.alerts, Key: { id: alertId }, UpdateExpression: 'SET acknowledged_by = :user, acknowledged_at = :at', ConditionExpression: 'attribute_not_exists(acknowledged_at) OR acknowledged_at = :unset', ExpressionAttributeValues: { ':user': userId, ':at': new Date().toISOString(), ':unset': null }, ReturnValues: 'ALL_NEW' }));
    return { status: 'ok', alert: mapAlert(updated.Attributes as Record<string, unknown>) };
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return { status: 'already' };
    throw error;
  }
}
async function findUserByEmail(email: string): Promise<UserRecord | undefined> {
  const items = await queryAll({ TableName: tables.users, IndexName: 'email-index', KeyConditionExpression: 'email_lower = :email', ExpressionAttributeValues: { ':email': email.toLowerCase() }, Limit: 1 });
  return items[0] ? mapUser(items[0]) : undefined;
}
async function getConfig(unitId: string): Promise<ThresholdConfig | undefined> { const item = (await ddb.send(new GetCommand({ TableName: tables.config, Key: { unit_id: unitId } }))).Item; return item ? mapConfig(item) : undefined; }
async function updateConfig(unitId: string, patch: ConfigPatch): Promise<ThresholdConfig> {
  const fields = Object.entries(patch); if (!fields.length) throw new Error('empty patch');
  const names: Record<string, string> = {}; const values: Record<string, unknown> = {}; const sets = fields.map(([field, value], index) => { const n = `#f${index}`; const v = `:v${index}`; names[n] = field; values[v] = value; return `${n} = ${v}`; });
  try { const result = await ddb.send(new UpdateCommand({ TableName: tables.config, Key: { unit_id: unitId }, UpdateExpression: `SET ${sets.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ReturnValues: 'ALL_NEW', ConditionExpression: 'attribute_exists(unit_id)' })); return mapConfig(result.Attributes as Record<string, unknown>); } catch (error) { if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw new Error(`device_config row missing for ${unitId}`); throw error; }
}
async function listUsers(): Promise<UserRow[]> { const result = await ddb.send(new ScanCommand({ TableName: tables.users })); return (result.Items ?? []).map((item) => publicUser(item as Record<string, unknown>)).sort((a, b) => a.id - b.id); }
async function findUserById(id: number): Promise<UserRow | undefined> { const item = (await ddb.send(new GetCommand({ TableName: tables.users, Key: { id } }))).Item; return item ? publicUser(item) : undefined; }
async function createUser(input: NewUser): Promise<UserRow> {
    if (await findUserByEmail(input.email)) throw new DuplicateEmailError(input.email);
  const id = Date.now(); const item = { id, ...input, active: true, email_lower: input.email.toLowerCase() };
  try { await ddb.send(new PutCommand({ TableName: tables.users, Item: item, ConditionExpression: 'attribute_not_exists(id)' })); return publicUser(item); } catch (error) { if ((error as { name?: string }).name === 'ConditionalCheckFailedException') throw new DuplicateEmailError(input.email); throw error; }
}
async function updateUser(id: number, patch: UserPatch): Promise<UserRow | undefined> {
  const fields = Object.entries(patch); if (!fields.length) throw new Error('empty patch');
  const names: Record<string, string> = {}; const values: Record<string, unknown> = {}; const sets = fields.map(([field, value], index) => { const n = `#f${index}`; const v = `:v${index}`; names[n] = field; values[v] = value; return `${n} = ${v}`; });
  try { const result = await ddb.send(new UpdateCommand({ TableName: tables.users, Key: { id }, UpdateExpression: `SET ${sets.join(', ')}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values, ConditionExpression: 'attribute_exists(id)', ReturnValues: 'ALL_NEW' })); return publicUser(result.Attributes as Record<string, unknown>); } catch (error) { if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return undefined; throw error; }
}
async function clientExists(id: number): Promise<boolean> { return Boolean((await ddb.send(new GetCommand({ TableName: tables.clients, Key: { id } }))).Item); }

export const dataAccess: DataAccess = { listUnits, listUnitIds, unitInScope, latestReading, latestReadings, queryTelemetry, listAlerts, findUserByEmail, acknowledgeAlert, getConfig, updateConfig, listUsers, findUserById, createUser, updateUser, clientExists };
