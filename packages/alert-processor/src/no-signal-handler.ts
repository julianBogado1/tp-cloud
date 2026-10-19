import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { IngestedReading, SignalState } from '@snowball/shared';
import { envAsNumber, NAMES, requireEnv } from '@snowball/shared';
import { batchGetItems, batchGetSignalStates, saveSignalState } from './signal-state';
import { evaluateSilence } from './silence';
import { getThreshold, getUnit, insertAlert } from './thresholds';

/**
 * Lambda entry point of `snowball-no-signal-monitor`, behind an EventBridge
 * Scheduler rule (`rate(1 minute)`, input `{}`). Every other component of the
 * pipeline is driven by an incoming reading, and the absence of data produces
 * no event, so this sweep is the only thing that can notice a unit that went
 * quiet. Like `process.ts`, it must never import `index.ts`.
 *
 * The alert path keeps the order of `process.ts:18-26` for the same reasons.
 * There is no SQS redelivery here, but the next sweep is a de facto retry: on
 * a failed publish or save the state is still `ok`, so the next minute reaches
 * the same alert with the same `since`, and therefore the same id, and the
 * conditional insert keeps it from writing a second row.
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const sns = new SNSClient({});

const unitsTable = process.env.DDB_UNITS_TABLE ?? NAMES.unitsTable;
const stateTable = process.env.DDB_STATE_TABLE ?? NAMES.unitStateTable;

let topicArn: string | undefined;
function noSignalTopicArn(): string {
  topicArn ??= requireEnv('SNS_NO_SIGNAL_TOPIC_ARN');
  return topicArn;
}

export async function handler(): Promise<void> {
  const nowMs = Date.now();
  const unitIds = await activeUnitIds();
  if (unitIds.length === 0) {
    console.log('no-signal sweep: no active units');
    return;
  }

  const lastReadings = await latestReadings(unitIds);
  const signalStates = await batchGetSignalStates(unitIds);

  const failed: string[] = [];
  for (const unitId of unitIds) {
    try {
      await sweepUnit(
        unitId,
        signalStates.get(unitId) ?? { phase: 'ok' },
        lastReadings.get(unitId) ?? null,
        nowMs,
      );
    } catch (err) {
      console.error(`[${unitId}] no-signal check failed, left for the next sweep:`, err);
      failed.push(unitId);
    }
  }

  if (failed.length > 0) {
    console.error(
      `no-signal sweep: ${failed.length} of ${unitIds.length} unit(s) failed: ${failed.join(', ')}`,
    );
  }
}

async function sweepUnit(
  unitId: string,
  previousState: SignalState,
  lastReading: IngestedReading | null,
  nowMs: number,
): Promise<void> {
  const config = await getThreshold(unitId);
  // Unlike `processReading`, a unit with no device-config row is not discarded:
  // silence needs only a timeout, and a provisioned unit nobody configured is
  // exactly what the operator wants to hear about.
  const timeoutMin = config?.signal_timeout_min ?? envAsNumber('NO_SIGNAL_TIMEOUT_MIN', 10);

  const { state, alert, recovery } = evaluateSilence(
    unitId,
    previousState,
    lastReading,
    timeoutMin,
    nowMs,
  );
  const changed =
    state.phase !== previousState.phase ||
    state.since !== previousState.since ||
    state.observed_at !== previousState.observed_at;

  if (alert) {
    const unit = await getUnit(unitId);
    if (!unit) throw new Error(`unit missing for ${unitId}`);

    // The seed keeps this id apart from a thermal alert sharing the same
    // `since` — see alert-id.ts.
    const inserted = await insertAlert(alert, unit, 'no-signal');
    if (!inserted) console.warn(`[${unitId}] alert row already present (retry) — publishing again`);

    await sns.send(
      new PublishCommand({
        TopicArn: noSignalTopicArn(),
        Subject: `No signal — ${unitId}`,
        Message:
          `${alert.detail}\n` +
          `Silence start: ${alert.since}\n` +
          `Detected at: ${alert.ts}`,
      }),
    );
    console.log(`[${unitId}] ALERT emitted: ${alert.detail}`);
    await saveSignalState(unitId, state);
    return;
  }

  if (recovery) {
    // Same topic, but no row in the alerts table: the operator already has the
    // row for the silence itself, and a recovery is not an alert.
    await sns.send(
      new PublishCommand({
        TopicArn: noSignalTopicArn(),
        Subject: `Signal recovered — ${unitId}`,
        Message:
          `${recovery.detail}\n` +
          `Silence start: ${recovery.since}\n` +
          `First reading back: ${recovery.ts}`,
      }),
    );
    console.log(`[${unitId}] RECOVERED: ${recovery.detail}`);
    await saveSignalState(unitId, state);
    return;
  }

  if (changed) {
    await saveSignalState(unitId, state);
    console.log(`[${unitId}] ${previousState.phase} -> ${state.phase}`);
  }
}

/**
 * Read from `snowball-units` and not from the state table: a unit that never
 * reported has no state row at all, and that is the most serious case this
 * feature exists to catch. `active !== false` matches `listUnits`, so the
 * sweep and the dashboard agree on which units count.
 *
 * Paginated because a Scan stops at 1 MB: ignoring LastEvaluatedKey would
 * silently drop the tail of the fleet as it grows.
 */
async function activeUnitIds(): Promise<string[]> {
  const ids: string[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({ TableName: unitsTable, ExclusiveStartKey: startKey }),
    );
    for (const item of page.Items ?? []) {
      if (item.active !== false) ids.push(String(item.unit_id));
    }
    startKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (startKey);
  return ids;
}

/** Last reading per unit from `snowball-unit-state`; absent = never reported. */
async function latestReadings(unitIds: readonly string[]): Promise<Map<string, IngestedReading>> {
  const items = await batchGetItems(stateTable, unitIds.map((unit_id) => ({ unit_id })));
  return new Map(items.map((item) => [String(item.unit_id), item as unknown as IngestedReading]));
}
