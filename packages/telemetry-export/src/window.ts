/**
 * The UTC day a run exports and where it lands in S3.
 *
 * Without `date`, the day before `now`: the EventBridge cron fires at 00:15Z,
 * when yesterday is closed. With `date` (YYYY-MM-DD) exactly that day — the
 * manual / backfill path. `to` is exclusive (the next UTC midnight); DynamoDB's
 * BETWEEN is inclusive, so the caller drops `ts >= to` after the Query.
 */

export interface ExportWindow {
  /** inclusive lower bound, ISO-8601 */
  from: string;
  /** exclusive upper bound, ISO-8601 — the next UTC midnight */
  to: string;
  day: { yyyy: string; mm: string; dd: string };
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 3600 * 1000;

export function exportWindow(now: Date, date?: string): ExportWindow {
  let start: Date;
  if (date === undefined) {
    start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  } else {
    const m = DATE_RE.exec(date);
    if (!m) throw new Error(`date must be YYYY-MM-DD, got "${date}"`);
    start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (start.toISOString().slice(0, 10) !== date) {
      throw new Error(`date is not a real calendar day: "${date}"`);
    }
  }
  const from = start.toISOString();
  return {
    from,
    to: new Date(start.getTime() + DAY_MS).toISOString(),
    day: { yyyy: from.slice(0, 4), mm: from.slice(5, 7), dd: from.slice(8, 10) },
  };
}

export function objectKey(prefix: string, w: ExportWindow, unitId: string): string {
  return `${prefix}${w.day.yyyy}/${w.day.mm}/${w.day.dd}/${unitId}.ndjson.gz`;
}
