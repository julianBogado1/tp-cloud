import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import type { Telemetry } from '@snowball/shared';
import { requireEnv } from '@snowball/shared';
import { evaluate } from './excursion';
import { parseReading } from './parse';
import { getState, saveState } from './state';
import { getThreshold, getUnit, insertAlert } from './thresholds';

/**
 * Per-reading processing shared by the Lambda handler (`handler.ts`) and the
 * local long-poll loop (`index.ts`). Must never import `index.ts`, which
 * starts the loop and requires SQS_QUEUE_URL at load time.
 *
 * Environment variables:
 *   SNS_THERMAL_EXCURSION_TOPIC_ARN  (required, read on first alert)
 *   DDB_TABLE, DDB_DEVICE_CONFIG_TABLE, DDB_UNITS_TABLE, DDB_ALERTS_TABLE
 *
 * Alert path order — every step is safe to repeat on an SQS retry:
 *   1. look up the unit (fails before any side effect: no email, no row);
 *   2. insert the alert with a deterministic id (a duplicate counts as done);
 *   3. publish to SNS;
 *   4. save the state as `alerted`.
 * If 3 or 4 fail, the state is still `deviated`, so the retry re-evaluates to
 * the same alert (same since → same id) and resumes. SNS is at-least-once: a
 * retry can resend the email, but an alert is never lost and its row is never
 * duplicated.
 */

const sns = new SNSClient({});

let topicArn: string | undefined;
function thermalTopicArn(): string {
  topicArn ??= requireEnv('SNS_THERMAL_EXCURSION_TOPIC_ARN');
  return topicArn;
}

export async function processReading(reading: Telemetry): Promise<void> {
  const config = await getThreshold(reading.unit_id);
  if (!config) {
    console.warn(`[${reading.unit_id}] no device_config in DynamoDB — reading discarded`);
    return;
  }

  const previousState = await getState(reading.unit_id);
  const { state, alert } = evaluate(previousState, reading, config);
  const changed = state.phase !== previousState.phase || state.since !== previousState.since;

  if (alert) {
    const unit = await getUnit(alert.unit_id);
    if (!unit) throw new Error(`unit missing for ${alert.unit_id}`);

    const inserted = await insertAlert(alert, unit);
    if (!inserted) console.warn(`[${alert.unit_id}] alert row already present (retry) — publishing again`);

    await sns.send(
      new PublishCommand({
        TopicArn: thermalTopicArn(),
        Subject: `Thermal excursion — ${alert.unit_id}`,
        Message:
          `${alert.detail}\n` +
          `Deviation start: ${alert.since}\n` +
          `Position: ${alert.lat}, ${alert.lon}`,
      }),
    );
    console.log(`[${alert.unit_id}] ALERT emitted: ${alert.detail}`);
  }

  if (changed) {
    await saveState(reading.unit_id, state);
    console.log(`[${reading.unit_id}] ${previousState.phase} -> ${state.phase} (${reading.temp_c}°C)`);
  }
}

/** Parses an SQS body and processes it. A malformed body throws. */
export async function processMessage(body: string): Promise<void> {
  await processReading(parseReading(body));
}
