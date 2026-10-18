import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { requireEnv } from '@snowball/shared';
import { processMessage } from './process';
import { closePool } from './thresholds';

/**
 * Alert processor, local long-poll loop (`npm run dev`). In AWS the same
 * logic runs as a Lambda behind an SQS event source mapping (`handler.ts`);
 * both share `process.ts`.
 *
 * Environment variables:
 *   SQS_QUEUE_URL                    (required)
 *   SNS_THERMAL_EXCURSION_TOPIC_ARN  (required)
 *   DDB_TABLE                        (default snowball-telemetry)
 *
 * A failing message is not deleted: SQS retries it and, past maxReceiveCount,
 * moves it to the DLQ. A message for a unit without device_config is deleted
 * with a warning: retrying will not fix it.
 */

const sqs = new SQSClient({});

const QUEUE_URL = requireEnv('SQS_QUEUE_URL');
// Fail fast at startup rather than on the first alert.
requireEnv('SNS_THERMAL_EXCURSION_TOPIC_ARN');

let running = true;

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
        await processMessage(message.Body ?? '');
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
