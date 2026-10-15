import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { ThresholdConfig } from '@snowball/shared';
import { envAsNumber, NAMES } from '@snowball/shared';

const CACHE_TTL_MS = envAsNumber('THRESHOLDS_CACHE_MS', 60_000);
const configTable = process.env.DDB_DEVICE_CONFIG_TABLE ?? NAMES.deviceConfigTable;
const unitsTable = process.env.DDB_UNITS_TABLE ?? NAMES.unitsTable;
const alertsTable = process.env.DDB_ALERTS_TABLE ?? NAMES.alertsTable;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface CacheEntry { config: ThresholdConfig | null; expiresAt: number }
const cache = new Map<string, CacheEntry>();

export async function getThreshold(unitId: string): Promise<ThresholdConfig | null> {
  const now = Date.now();
  const cached = cache.get(unitId);
  if (cached && cached.expiresAt > now) return cached.config;
  const { Item } = await ddb.send(new GetCommand({ TableName: configTable, Key: { unit_id: unitId } }));
  const config = Item ? {
    unit_id: String(Item.unit_id),
    temp_min_c: Number(Item.temp_min_c),
    temp_max_c: Number(Item.temp_max_c),
    tolerance_min: Number(Item.tolerance_min),
    setpoint_c: Number(Item.setpoint_c),
  } : null;
  cache.set(unitId, { config, expiresAt: now + CACHE_TTL_MS });
  return config;
}

export async function insertAlert(alert: {
  unit_id: string; severity: string; since: string; ts: string; duration_min: number; temp_c: number; detail: string;
}): Promise<void> {
  const unit = (await ddb.send(new GetCommand({ TableName: unitsTable, Key: { unit_id: alert.unit_id } }))).Item;
  if (!unit) throw new Error(`unit missing for ${alert.unit_id}`);
  await ddb.send(new PutCommand({
    TableName: alertsTable,
    Item: { id: Date.now(), ...alert, client_id: unit.client_id, emitted_at: alert.ts, acknowledged_by: null, acknowledged_at: null },
    ConditionExpression: 'attribute_not_exists(id)',
  }));
}

export async function closePool(): Promise<void> {}
