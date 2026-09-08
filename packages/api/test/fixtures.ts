import type { Scope } from '../src/auth/scope';
import { DuplicateEmailError, type DataAccess, type UserRecord } from '../src/data-access';

/** In-memory DataAccess shared by the route tests. Later tasks add methods here. */

export const secret = 's'.repeat(32);

export const units = [
  { unit_id: 'SB-001', client_id: 1, description: 'Reefer BA-MDQ', active: true, setpoint_c: -18, temp_min_c: -25, temp_max_c: -15 },
  { unit_id: 'SB-003', client_id: 2, description: 'Furgón vacunas', active: true, setpoint_c: 5, temp_min_c: 2, temp_max_c: 8 },
];
export const alerts = [
  { id: 1, unit_id: 'SB-001', severity: 'thermal-excursion', since: '2026-08-30T09:00:00Z', emitted_at: '2026-08-30T09:06:00Z', duration_min: 6, temp_c: -12.5, detail: 'sustained -12.5°C', acknowledged_by: null, acknowledged_at: null },
  { id: 2, unit_id: 'SB-003', severity: 'thermal-excursion', since: '2026-08-30T09:00:00Z', emitted_at: '2026-08-30T09:07:00Z', duration_min: 7, temp_c: 9.5, detail: 'sustained 9.5°C', acknowledged_by: null, acknowledged_at: null },
];
export const telemetry = [
  { unit_id: 'SB-001', ts: '2026-08-30T10:00:00Z', temp_c: -18, humidity_pct: 60, lat: -34.6, lon: -58.4, battery: 90, signal: 4, expires_at: 0 },
];
export const configs = [
  { unit_id: 'SB-001', setpoint_c: -18, temp_min_c: -25, temp_max_c: -15, tolerance_min: 5 },
  { unit_id: 'SB-003', setpoint_c: 5, temp_min_c: 2, temp_max_c: 8, tolerance_min: 1 },
];

export function inScope(u: { client_id: number }, scope: Scope): boolean {
  return scope.all || u.client_id === scope.clientId;
}
export const strip = ({ client_id: _c, ...rest }: (typeof units)[number]) => rest;

export const userRecords: UserRecord[] = [
  { id: 1, email: 'op@x', role: 'operator', client_id: 1, active: true, password_hash: 'h' },
  { id: 3, email: 'adm@x', role: 'admin', client_id: null, active: true, password_hash: 'h' },
];
const publicUser = ({ password_hash: _p, ...rest }: UserRecord) => rest;

export const fakeData: DataAccess = {
  listUnits: async (scope) => units.filter((u) => inScope(u, scope)).map(strip),
  listUnitIds: async (scope) => units.filter((u) => inScope(u, scope)).map((u) => u.unit_id),
  unitInScope: async (unitId, scope) => units.some((u) => u.unit_id === unitId && inScope(u, scope)),
  latestReading: async (unitId) => (unitId === 'SB-001' ? telemetry[0] : undefined),
  latestReadings: async (unitIds) => new Map(telemetry.filter((reading) => unitIds.includes(reading.unit_id)).map((reading) => [reading.unit_id, reading])),
  queryTelemetry: async (unitId, q) => (unitId === 'SB-001' && q.limit > 0 ? telemetry : []),
  listAlerts: async (_limit, scope) =>
    alerts.filter((a) => inScope(units.find((u) => u.unit_id === a.unit_id)!, scope)),
  findUserByEmail: async (email) => userRecords.find((u) => u.email === email),
  listUsers: async () => userRecords.map(publicUser),
  findUserById: async (id) => { const u = userRecords.find((x) => x.id === id); return u && publicUser(u); },
  createUser: async (input) => {
    if (userRecords.some((u) => u.email === input.email)) throw new DuplicateEmailError(input.email);
    const row: UserRecord = { id: userRecords.length + 10, active: true, ...input };
    userRecords.push(row);
    return publicUser(row);
  },
  updateUser: async (id, patch) => {
    const u = userRecords.find((x) => x.id === id);
    if (!u) return undefined;
    Object.assign(u, patch);
    return publicUser(u);
  },
  clientExists: async (id) => id === 1 || id === 2,
  acknowledgeAlert: async (alertId, userId, scope) => {
    const alert = alerts.find((a) => a.id === alertId);
    if (!alert || !inScope(units.find((u) => u.unit_id === alert.unit_id)!, scope)) return { status: 'not-found' };
    if (alert.acknowledged_at) return { status: 'already' };
    alert.acknowledged_by = userId;
    alert.acknowledged_at = '2026-08-30T10:00:00Z';
    return { status: 'ok', alert };
  },
  getConfig: async (unitId) => configs.find((c) => c.unit_id === unitId),
  updateConfig: async (unitId, patch) => {
    const i = configs.findIndex((c) => c.unit_id === unitId);
    configs[i] = { ...configs[i], ...patch };
    return configs[i];
  },
};
