import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { IoTDataPlaneClient, UpdateThingShadowCommand } from '@aws-sdk/client-iot-data-plane';
import { DEVICE_CONFIG_FIELDS, NAMES, pickDeviceConfig, type DeviceConfig } from '@snowball/shared';

/**
 * Backfills every unit's Device Shadow `desired` from the device-config table.
 * Units deployed before thresholds travelled through the shadow only have
 * `setpoint_c` there; after this runs, desired holds all four fields. Shadows
 * are runtime state, not infrastructure, so this runs after `terraform apply`
 * instead of being a Terraform resource. Idempotent.
 *
 * Usage:
 *   npx tsx scripts/sync-shadows.ts --endpoint "$(terraform -chdir=terraform output -raw iot_endpoint)" \
 *     [--table snowball-device-config] [--dry-run]
 */

export interface DesiredDocument {
  state: { desired: Partial<DeviceConfig> };
}

/** DynamoDB device-config row → shadow update payload (drops unit_id and unknown attributes). */
export function desiredDocument(row: Record<string, unknown>): DesiredDocument {
  // same defensive normalization as the API repository: numbers may arrive as numeric strings
  const normalized: Record<string, unknown> = {};
  for (const field of DEVICE_CONFIG_FIELDS) {
    const value = row[field];
    normalized[field] = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  }
  return { state: { desired: pickDeviceConfig(normalized) } };
}

export interface SyncOptions {
  /** iot:Data-ATS endpoint, without https:// */
  endpoint: string;
  table: string;
  dryRun: boolean;
}

export interface SyncResult {
  unitId: string;
  desired: Partial<DeviceConfig>;
  ok: boolean;
  error?: string;
}

/** Scans the table and pushes each row's desired document. Never throws per unit; collects results. */
export async function syncShadows(options: SyncOptions): Promise<SyncResult[]> {
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const iot = new IoTDataPlaneClient({ endpoint: `https://${options.endpoint}` });
  const rows: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(new ScanCommand({ TableName: options.table, ExclusiveStartKey }));
    rows.push(...((page.Items ?? []) as Record<string, unknown>[]));
    ExclusiveStartKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);

  const results: SyncResult[] = [];
  for (const row of rows) {
    const unitId = String(row.unit_id);
    const doc = desiredDocument(row);
    if (options.dryRun) {
      results.push({ unitId, desired: doc.state.desired, ok: true });
      continue;
    }
    try {
      await iot.send(new UpdateThingShadowCommand({ thingName: unitId, payload: Buffer.from(JSON.stringify(doc)) }));
      results.push({ unitId, desired: doc.state.desired, ok: true });
    } catch (err) {
      results.push({ unitId, desired: doc.state.desired, ok: false, error: (err as Error).message });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      endpoint: { type: 'string' },
      table: { type: 'string', default: NAMES.deviceConfigTable },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const endpoint = values.endpoint ?? process.env.IOT_ENDPOINT;
  if (!endpoint) {
    console.error('Missing --endpoint or IOT_ENDPOINT (terraform -chdir=terraform output -raw iot_endpoint)');
    process.exit(1);
  }
  const dryRun = values['dry-run']!;
  const results = await syncShadows({ endpoint, table: values.table!, dryRun });
  for (const r of results) {
    console.log(`${r.unitId} → ${JSON.stringify(r.desired)}${dryRun ? ' (dry-run)' : ''}${r.ok ? '' : ` FAILED: ${r.error}`}`);
  }
  console.log(`${results.filter((r) => r.ok).length}/${results.length} shadow(s) synced`);
  if (results.some((r) => !r.ok)) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
