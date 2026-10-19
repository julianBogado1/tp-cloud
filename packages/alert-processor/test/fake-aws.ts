/**
 * In-memory stand-in for the DynamoDB tables and the SNS topic the alert
 * processor touches, wired in by the test files with
 *   vi.mock('@aws-sdk/lib-dynamodb', async () => (await import('./fake-aws')).libDynamodb)
 * Every call is appended to `fake.log` as "<Command> <table|topic>" so tests
 * can assert the side-effect order.
 */

type Item = Record<string, unknown>;

class Command {
  constructor(public input: Item) {}
}
class GetCommand extends Command {}
class PutCommand extends Command {}
class ScanCommand extends Command {}
class BatchGetCommand extends Command {}
class PublishCommand extends Command {}

const failures: { match: string; err: Error }[] = [];

export const fake = {
  log: [] as string[],
  tables: new Map<string, Map<string, Item>>(),
  published: [] as Item[],
  /**
   * Caps every Scan page when the caller passes no Limit, so a test can force
   * the sweep through several pages without the production code knowing.
   */
  scanPageSize: undefined as number | undefined,
  /** Makes the next call whose log entry starts with `match` reject with `err`. */
  failNext(match: string, err: Error): void {
    failures.push({ match, err });
  },
  put(table: string, item: Item): void {
    const t = fake.tables.get(table) ?? new Map<string, Item>();
    t.set(keyOf(table, item), item);
    fake.tables.set(table, t);
  },
  rows(table: string): Item[] {
    return [...(fake.tables.get(table)?.values() ?? [])];
  },
  reset(): void {
    fake.log.length = 0;
    fake.published.length = 0;
    fake.tables.clear();
    fake.scanPageSize = undefined;
    failures.length = 0;
  },
};

// Key attributes per table, as in terraform/modules/data.
function keyOf(table: string, item: Item): string {
  if (table === 'snowball-alerts') return String(item.id);
  if (table === 'snowball-telemetry') return `${String(item.unit_id)}|${String(item.ts)}`;
  return String(item.unit_id);
}

/** The key attributes alone, which is what a LastEvaluatedKey carries. */
function primaryKeyOf(table: string, item: Item): Item {
  if (table === 'snowball-alerts') return { id: item.id };
  if (table === 'snowball-telemetry') return { unit_id: item.unit_id, ts: item.ts };
  return { unit_id: item.unit_id };
}

function check(entry: string): void {
  fake.log.push(entry);
  const i = failures.findIndex((f) => entry.startsWith(f.match));
  if (i >= 0) throw failures.splice(i, 1)[0].err;
}

async function ddbSend(cmd: Command): Promise<Item> {
  if (cmd instanceof BatchGetCommand) {
    const requested = cmd.input.RequestItems as Record<string, { Keys: Item[] }>;
    const Responses: Record<string, Item[]> = {};
    for (const [table, { Keys }] of Object.entries(requested)) {
      check(`BatchGet ${table}`);
      const rows = fake.tables.get(table);
      // A real BatchGetItem omits missing keys from the response instead of
      // returning holes, which is what the caller's Map lookup relies on.
      Responses[table] = Keys.map((key) => rows?.get(keyOf(table, key))).filter(
        (item): item is Item => item !== undefined,
      );
    }
    return { Responses };
  }

  const table = String(cmd.input.TableName);
  if (cmd instanceof GetCommand) {
    check(`Get ${table}`);
    return { Item: fake.tables.get(table)?.get(keyOf(table, cmd.input.Key as Item)) };
  }
  if (cmd instanceof PutCommand) {
    check(`Put ${table}`);
    const item = cmd.input.Item as Item;
    const exists = fake.tables.get(table)?.has(keyOf(table, item));
    if (exists && cmd.input.ConditionExpression === 'attribute_not_exists(id)') {
      const err = new Error('The conditional request failed');
      err.name = 'ConditionalCheckFailedException';
      throw err;
    }
    fake.put(table, item);
    return {};
  }
  if (cmd instanceof ScanCommand) {
    check(`Scan ${table}`);
    // Sorted order so pagination is reproducible. A real Scan gives no order
    // guarantee, only that LastEvaluatedKey resumes where the page stopped.
    const rows = fake.tables.get(table);
    const keys = [...(rows?.keys() ?? [])].sort();
    const startKey = cmd.input.ExclusiveStartKey as Item | undefined;
    const from = startKey === undefined ? 0 : keys.indexOf(keyOf(table, startKey)) + 1;
    const size = Number(cmd.input.Limit ?? fake.scanPageSize ?? keys.length);
    const page = keys.slice(from, from + size);
    const Items = page.map((key) => rows?.get(key) as Item);
    const more = from + page.length < keys.length;
    return {
      Items,
      ...(more && Items.length > 0
        ? { LastEvaluatedKey: primaryKeyOf(table, Items[Items.length - 1]) }
        : {}),
    };
  }
  throw new Error(`unexpected command ${cmd.constructor.name}`);
}

async function snsSend(cmd: Command): Promise<Item> {
  check(`Publish ${String(cmd.input.TopicArn)}`);
  fake.published.push(cmd.input);
  return { MessageId: String(fake.published.length) };
}

export const clientDynamodb = { DynamoDBClient: class {} };
export const libDynamodb = {
  DynamoDBDocumentClient: { from: () => ({ send: ddbSend }) },
  GetCommand,
  PutCommand,
  ScanCommand,
  BatchGetCommand,
};
export const clientSns = {
  SNSClient: class { send = snsSend; },
  PublishCommand,
};

export const TOPIC = 'arn:aws:sns:us-east-1:000000000000:snowball-thermal-excursion';
export const NO_SIGNAL_TOPIC = 'arn:aws:sns:us-east-1:000000000000:snowball-no-signal';

/** Seeds a unit with a [-25, -15] °C range, a 5 min tolerance and a 10 min signal timeout. */
export function seedUnit(unitId: string, clientId = 7): void {
  fake.put('snowball-units', { unit_id: unitId, client_id: clientId });
  fake.put('snowball-device-config', {
    unit_id: unitId, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5, setpoint_c: -18,
    signal_timeout_min: 10,
  });
}

export function reading(unitId: string, tempC: number, ts: string): Item {
  return { unit_id: unitId, ts, temp_c: tempC, humidity_pct: 60, lat: -34.6, lon: -58.4, battery: 90, signal: 4 };
}

/** Seeds the latest reading in `snowball-unit-state`, the row the sweep reads. */
export function seedState(unitId: string, ts: string, tempC = -18): void {
  fake.put('snowball-unit-state', { ...reading(unitId, tempC, ts), expires_at: 0 });
}
