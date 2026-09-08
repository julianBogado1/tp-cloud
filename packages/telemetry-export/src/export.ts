import type { IngestedReading } from '@snowball/shared';
import { NAMES } from '@snowball/shared';
import { toNdjsonGz } from './ndjson';
import { exportWindow, objectKey } from './window';

/**
 * Daily archive of the hot DynamoDB history into S3. Pure orchestration:
 * every AWS call comes through `ExportDeps`, so the whole flow is tested with
 * in-memory fakes and `aws.ts` only has to implement four functions.
 *
 * Failure policy: a unit that throws is logged and skipped; the others still
 * get written; at the end the run throws `ExportError` so the scheduler
 * retries. Keys are deterministic, so a retry overwrites the same objects.
 */

export interface ExportDeps {
  /** every unit_id in the current-state table */
  listUnits(): Promise<string[]>;
  /** readings of one unit with `from <= ts <= to` (DynamoDB BETWEEN is inclusive) */
  queryReadings(unitId: string, from: string, to: string): Promise<IngestedReading[]>;
  putObject(key: string, body: Buffer): Promise<void>;
  log(message: string): void;
}

export interface ExportResult {
  /** YYYY-MM-DD of the exported day */
  day: string;
  /** units seen in the state table */
  units: number;
  /** objects written */
  exported: number;
  /** readings written */
  readings: number;
  /** unit_ids whose Query or PutObject threw, sorted */
  failed: string[];
}

export class ExportError extends Error {
  constructor(readonly result: ExportResult) {
    super(`export ${result.day}: ${result.failed.length} unit(s) failed: ${result.failed.join(', ')}`);
    this.name = 'ExportError';
  }
}

export async function runExport(
  deps: ExportDeps,
  now: Date,
  date?: string,
  concurrency = 10,
  prefix: string = NAMES.archivePrefix,
): Promise<ExportResult> {
  const w = exportWindow(now, date);
  const units = await deps.listUnits();
  const result: ExportResult = { day: w.from.slice(0, 10), units: units.length, exported: 0, readings: 0, failed: [] };

  await forEachLimited(units, concurrency, async (unitId) => {
    try {
      const rows = (await deps.queryReadings(unitId, w.from, w.to)).filter((r) => r.ts < w.to);
      if (rows.length === 0) {
        deps.log(`[${unitId}] no readings on ${result.day}, nothing written`);
        return;
      }
      const key = objectKey(prefix, w, unitId);
      await deps.putObject(key, toNdjsonGz(rows));
      result.exported += 1;
      result.readings += rows.length;
      deps.log(`[${unitId}] ${rows.length} readings -> ${key}`);
    } catch (err) {
      result.failed.push(unitId);
      deps.log(`[${unitId}] FAILED: ${(err as Error).message}`);
    }
  });

  result.failed.sort();
  deps.log(
    `export ${result.day}: ${result.exported}/${result.units} units written, ${result.readings} readings, ${result.failed.length} failed`,
  );
  if (result.failed.length > 0) throw new ExportError(result);
  return result;
}

/** Runs `fn` over `items` with at most `limit` calls in flight. */
export async function forEachLimited<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
