import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { Telemetry } from '@snowball/shared';
import { parseReading } from './parse';
import { processReading } from './process';

/**
 * Lambda entry point behind the SQS event source mapping on
 * `snowball-readings` (batch_size 10, ReportBatchItemFailures).
 *
 * Records are grouped by unit_id and each group is processed in reading `ts`
 * order, so a batch never evaluates a unit's readings out of order. When a
 * record fails, it and every later record of the same unit in this batch are
 * reported in `batchItemFailures`: SQS redelivers them together and, past
 * maxReceiveCount, moves them to the DLQ. Other units are unaffected.
 *
 * Malformed bodies are reported as failures too, matching `index.ts` and the
 * contract in `parse.ts`: they have no side effects, so the retries are
 * harmless, and they end up in the DLQ where they can be inspected instead of
 * vanishing. Their unit is unknown, so they never block another record.
 *
 * Readings of a unit without device_config are dropped with a warning
 * (`processReading` returns normally): retrying would not fix them.
 */

interface Parsed { record: SQSRecord; reading: Telemetry }

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: SQSBatchItemFailure[] = [];
  const groups = new Map<string, Parsed[]>();

  for (const record of event.Records) {
    let reading: Telemetry;
    try {
      reading = parseReading(record.body);
    } catch (err) {
      console.error(`message ${record.messageId} is malformed, left for retry/DLQ:`, err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const group = groups.get(reading.unit_id) ?? [];
    group.push({ record, reading });
    groups.set(reading.unit_id, group);
  }

  for (const [unitId, group] of groups) {
    group.sort((a, b) => Date.parse(a.reading.ts) - Date.parse(b.reading.ts));
    for (let i = 0; i < group.length; i++) {
      try {
        await processReading(group[i].reading);
      } catch (err) {
        const rest = group.slice(i);
        console.error(
          `[${unitId}] message ${group[i].record.messageId} failed; ` +
            `${rest.length} message(s) of this unit left for retry/DLQ:`,
          err,
        );
        for (const { record } of rest) batchItemFailures.push({ itemIdentifier: record.messageId });
        break;
      }
    }
  }

  return { batchItemFailures };
}
