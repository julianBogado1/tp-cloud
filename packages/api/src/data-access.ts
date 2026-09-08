import type { IngestedReading, Role, ThresholdConfig } from '@snowball/shared';
import type { Scope } from './auth/scope';
import type { TelemetryQuery } from './query';

/**
 * Everything the routers need from storage, behind one interface so tests
 * inject fakes. Every RDS read that touches `units` takes the caller's Scope
 * (see auth/scope.ts); DynamoDB reads are only reached after the unit was
 * confirmed in scope.
 */

export interface UnitRow {
  unit_id: string;
  description: string | null;
  active: boolean;
  setpoint_c: number | null;
  temp_min_c: number | null;
  temp_max_c: number | null;
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

export interface UserRecord extends UserRow {
  password_hash: string;
}

export type AckResult = { status: 'ok'; alert: AlertRow } | { status: 'not-found' } | { status: 'already' };

export type ConfigPatch = Partial<Pick<ThresholdConfig, 'setpoint_c' | 'temp_min_c' | 'temp_max_c' | 'tolerance_min'>>;

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`email already registered: ${email}`);
  }
}

export interface NewUser {
  email: string;
  password_hash: string;
  role: Role;
  client_id: number | null;
}

export interface UserPatch {
  active?: boolean;
  role?: Role;
  client_id?: number | null;
}

export interface DataAccess {
  listUnits(scope: Scope): Promise<UnitRow[]>;
  listUnitIds(scope: Scope): Promise<string[]>;
  unitInScope(unitId: string, scope: Scope): Promise<boolean>;
  latestReading(unitId: string): Promise<IngestedReading | undefined>;
  /** Latest reading of many units in one BatchGetItem round-trip set. */
  latestReadings(unitIds: string[]): Promise<Map<string, IngestedReading>>;
  queryTelemetry(unitId: string, query: TelemetryQuery): Promise<IngestedReading[]>;
  listAlerts(limit: number, scope: Scope): Promise<AlertRow[]>;
  findUserByEmail(email: string): Promise<UserRecord | undefined>;
  acknowledgeAlert(alertId: number, userId: number, scope: Scope): Promise<AckResult>;
  getConfig(unitId: string): Promise<ThresholdConfig | undefined>;
  updateConfig(unitId: string, patch: ConfigPatch): Promise<ThresholdConfig>;
  listUsers(): Promise<UserRow[]>;
  findUserById(id: number): Promise<UserRow | undefined>;
  createUser(input: NewUser): Promise<UserRow>;
  updateUser(id: number, patch: UserPatch): Promise<UserRow | undefined>;
  clientExists(id: number): Promise<boolean>;
}
