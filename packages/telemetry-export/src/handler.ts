import { awsDepsFromEnv } from './aws';
import { runExport, type ExportResult } from './export';

/**
 * Lambda entry point (`index.handler` once bundled by esbuild).
 *
 * Event: the EventBridge scheduled event (no `date` -> previous UTC day), or
 * a manual `{ "date": "YYYY-MM-DD" }` for a demo run or a backfill.
 */
const deps = awsDepsFromEnv();

export async function handler(event: { date?: unknown } = {}): Promise<ExportResult> {
  const date = event?.date;
  if (date !== undefined && typeof date !== 'string') {
    throw new Error('event.date must be a string YYYY-MM-DD');
  }
  return runExport(deps, new Date(), date);
}
