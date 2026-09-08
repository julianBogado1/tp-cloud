import type { IngestedReading, ThresholdConfig } from '@snowball/shared';
import { clearSession, getSession, type Role, type Session, type SessionUser } from './auth';
import { deriveWsUrl } from './status';

/**
 * HTTP + WebSocket client against @snowball/api. The base URL is baked in at
 * build time (VITE_API_BASE); with no value the bundle assumes same-origin.
 * Every /api call carries the session token; a 401 (or a 4401 WebSocket
 * close) clears the session and notifies App through setUnauthorizedHandler.
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
  acknowledged_by: number | null;
  acknowledged_at: string | null;
}

export interface UserRow {
  id: number;
  email: string;
  role: Role;
  client_id: number | null;
  active: boolean;
}

export interface ShadowState {
  desired: { setpoint_c?: number };
  reported: { setpoint_c?: number };
}

export type ConfigPatch = Partial<Pick<ThresholdConfig, 'setpoint_c' | 'temp_min_c' | 'temp_max_c' | 'tolerance_min'>>;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const session = getSession();
  const headers: Record<string, string> = {};
  if (session) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/auth/login') {
    clearSession();
    onUnauthorized();
  }
  if (!res.ok) {
    let message = `${method} ${path}: ${res.status}`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export function login(email: string, password: string): Promise<Session> {
  return request<{ token: string; user: SessionUser }>('POST', '/auth/login', { email, password });
}

export const fetchUnits = () => request<UnitWithReading[]>('GET', '/api/units');
export const fetchTelemetry = (unitId: string, limit: number) =>
  request<IngestedReading[]>('GET', `/api/units/${encodeURIComponent(unitId)}/telemetry?limit=${limit}`);
export const fetchAlerts = () => request<AlertRow[]>('GET', '/api/alerts');
export const ackAlert = (id: number) => request<AlertRow>('POST', `/api/alerts/${id}/ack`);
export const fetchShadow = (unitId: string) => request<ShadowState>('GET', `/api/units/${encodeURIComponent(unitId)}/shadow`);
export const updateConfig = (unitId: string, patch: ConfigPatch) =>
  request<ThresholdConfig & { warning?: string }>('PUT', `/api/units/${encodeURIComponent(unitId)}/config`, patch);
export const fetchUsers = () => request<UserRow[]>('GET', '/api/users');
export const createUser = (input: { email: string; password: string; role: Role; client_id: number | null }) =>
  request<UserRow>('POST', '/api/users', input);
export const updateUser = (id: number, patch: { active?: boolean; role?: Role; client_id?: number | null }) =>
  request<UserRow>('PATCH', `/api/users/${id}`, patch);

/**
 * Live feed with auto-reconnect. Returns a cleanup function; after calling
 * it no further reconnects happen. A 4401 close means the token was rejected:
 * the session is cleared and there is no retry.
 */
export function connectLive(
  unitIds: string[],
  token: string,
  onReading: (reading: IngestedReading) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let socket: WebSocket | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function open(): void {
    const url = new URL(deriveWsUrl(API_BASE));
    url.searchParams.set('token', token);
    socket = new WebSocket(url.toString());
    socket.onopen = () => onStatus(true);
    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data as string) as { type: string; data?: IngestedReading };
      if (msg.type === 'ready') socket?.send(JSON.stringify({ subscribe: unitIds }));
      if (msg.type === 'reading' && msg.data) onReading(msg.data);
    };
    socket.onclose = (event) => {
      onStatus(false);
      if (event.code === 4401) {
        closed = true;
        clearSession();
        onUnauthorized();
        return;
      }
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
