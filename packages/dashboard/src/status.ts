/** Pure helpers shared by the dashboard components (kept DOM-free for tests). */

export interface Thresholds {
  temp_min_c: number | null;
  temp_max_c: number | null;
  /** minutes of silence before the unit is stale; absent falls back to DEFAULT_STALE_MS */
  signal_timeout_min?: number | null;
}

export type UnitStatus = 'ok' | 'excursion' | 'stale';

const DEFAULT_STALE_MS = 2 * 60_000;

/**
 * The same window the no-signal monitor uses, so the card and the email alert
 * agree instead of the card crying "sin señal" minutes earlier.
 */
function staleMs(thresholds: Thresholds): number {
  const minutes = thresholds.signal_timeout_min;
  return typeof minutes === 'number' && minutes > 0 ? minutes * 60_000 : DEFAULT_STALE_MS;
}

export function readingStatus(
  reading: { ts: string; temp_c: number } | null,
  thresholds: Thresholds,
  nowMs: number,
): UnitStatus {
  if (!reading || nowMs - Date.parse(reading.ts) > staleMs(thresholds)) return 'stale';
  const { temp_min_c, temp_max_c } = thresholds;
  if (temp_min_c !== null && reading.temp_c < temp_min_c) return 'excursion';
  if (temp_max_c !== null && reading.temp_c > temp_max_c) return 'excursion';
  return 'ok';
}

export function formatAgo(ts: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(ts)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

export function deriveWsUrl(apiBase: string): string {
  const url = new URL(apiBase);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = url.pathname.endsWith('/') ? `${url.pathname}live` : `${url.pathname}/live`;
  return url.toString();
}
