/** Pure helpers shared by the dashboard components (kept DOM-free for tests). */

export interface Thresholds {
  temp_min_c: number | null;
  temp_max_c: number | null;
}

export type UnitStatus = 'ok' | 'excursion' | 'stale';

const STALE_MS = 2 * 60_000;

export function readingStatus(
  reading: { ts: string; temp_c: number } | null,
  thresholds: Thresholds,
  nowMs: number,
): UnitStatus {
  if (!reading || nowMs - Date.parse(reading.ts) > STALE_MS) return 'stale';
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
