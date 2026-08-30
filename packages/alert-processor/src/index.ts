import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { requireEnv } from '@snowball/shared';
import { evaluate } from './excursion';
import { parseReading } from './parse';
import { getState, saveState } from './state';
import { closePool, getThreshold, insertAlert } from './thresholds';

/**
 * Alert processor: consumes the queue fed by the IoT Core rule, evaluates
 * each reading against the RDS thresholds and notifies through SNS.
 *
 * Environment variables:
 *   SQS_QUEUE_URL                    (required)
 *   SNS_THERMAL_EXCURSION_TOPIC_ARN  (required)
 *   DDB_TABLE                        (default snowball-telemetry)
 *   PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD for RDS
 *
 * A failing message is not deleted: SQS retries it and, past maxReceiveCount,
 * moves it to the DLQ. A message for a unit without device_config is deleted
 * with a warning: retrying will not fix it.
 */

const sqs = new SQSClient({});
const sns = new SNSClient({});

const QUEUE_URL = requireEnv('SQS_QUEUE_URL');
const THERMAL_EXCURSION_TOPIC_ARN = requireEnv('SNS_THERMAL_EXCURSION_TOPIC_ARN');

let running = true;

async function processMessage(message: Message): Promise<void> {
  const reading = parseReading(message.Body ?? '');

  const config = await getThreshold(reading.unit_id);
  if (!config) {
    console.warn(`[${reading.unit_id}] no device_config in RDS — reading discarded`);
    return;
  }

  const previousState = await getState(reading.unit_id);
  const { state, alert } = evaluate(previousState, reading, config);

  if (state.phase !== previousState.phase || state.since !== previousState.since) {
    await saveState(reading.unit_id, state);
    console.log(`[${reading.unit_id}] ${previousState.phase} -> ${state.phase} (${reading.temp_c}°C)`);
  }

  if (alert) {
    await sns.send(
      new PublishCommand({
        TopicArn: THERMAL_EXCURSION_TOPIC_ARN,
        Subject: `Thermal excursion — ${alert.unit_id}`,
        Message:
          `${alert.detail}\n` +
          `Deviation start: ${alert.since}\n` +
          `Position: ${alert.lat}, ${alert.lon}`,
      }),
    );
    await insertAlert(alert);
    console.log(`[${alert.unit_id}] ALERT emitted: ${alert.detail}`);
  }
}

async function loop(): Promise<void> {
  console.log(`Alert processor listening on ${QUEUE_URL}`);
  while (running) {
    const { Messages } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20,
      }),
    );
    for (const message of Messages ?? []) {
      try {
        await processMessage(message);
        await sqs.send(
          new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: message.ReceiptHandle }),
        );
      } catch (err) {
        console.error(`message ${message.MessageId} failed, left for retry/DLQ:`, err);
      }
    }
  }
}

function shutdown(signal: string): void {
  console.log(`${signal} received, shutting down…`);
  running = false;
  void closePool().finally(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

loop().catch((err) => {
  console.error('main loop aborted:', err);
  process.exit(1);
});
