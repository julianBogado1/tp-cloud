import type { IngestedReading } from '@snowball/shared';
import { deriveWsUrl } from './status';

/**
 * HTTP + WebSocket client against @snowball/api. The base URL is baked in at
 * build time (VITE_API_BASE); with no value the bundle assumes same-origin,
 * which only makes sense in local dev behind the Vite proxy-less setup.
 */

export const API_BASE: string = import.meta.env.VITE_API_BASE ?? window.location.origin;

export interface UnitWithReading {
  unit_id: string;
  description: string | null;
  active: boolean;
  setpoint_c: number | null;
  temp_min_c: number | null;
  temp_max_c: number | null;
  last_reading: IngestedReading | null;
}

export interface AlertRow {
  id: number;
  unit_id: string;
  severity: string;
  since: string;
  emitted_at: string;
  duration_min: number;
  temp_c: number | null;
  detail: string;
  acknowledged_at: string | null;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`);
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return res.json() as Promise<T>;
}

export function fetchUnits(): Promise<UnitWithReading[]> {
  return getJson('/units');
}

export function fetchTelemetry(unitId: string, limit: number): Promise<IngestedReading[]> {
  return getJson(`/units/${encodeURIComponent(unitId)}/telemetry?limit=${limit}`);
}

export function fetchAlerts(): Promise<AlertRow[]> {
  return getJson('/alerts');
}

/**
 * Live feed with auto-reconnect. Returns a cleanup function; after calling
 * it no further reconnects happen.
 */
export function connectLive(
  unitIds: string[],
  onReading: (reading: IngestedReading) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let socket: WebSocket | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function open(): void {
    socket = new WebSocket(deriveWsUrl(API_BASE));
    socket.onopen = () => {
      onStatus(true);
      socket?.send(JSON.stringify({ subscribe: unitIds }));
    };
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as { type: string; data?: IngestedReading };
      if (msg.type === 'reading' && msg.data) onReading(msg.data);
    };
    socket.onclose = () => {
      onStatus(false);
      if (!closed) retry = setTimeout(open, 3000);
    };
    socket.onerror = () => socket?.close();
  }

  open();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    socket?.close();
  };
}
