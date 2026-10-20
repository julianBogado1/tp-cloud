import { DEVICE_CONFIG_FIELDS, type DeviceConfigField } from '@snowball/shared';
import type { ShadowState } from './api';

/**
 * Desired vs applied config, field by field (spec §4). Pure: ConfigPanel
 * renders these rows and uses shouldKeepPolling to refresh the shadow until
 * the unit confirms or we give up.
 */

export interface ShadowRow {
  field: DeviceConfigField;
  label: string;
  desired?: number;
  reported?: number;
  pending: boolean;
}

export const FIELD_LABELS: Record<DeviceConfigField, string> = {
  setpoint_c: 'Setpoint (°C)',
  temp_min_c: 'Mínimo (°C)',
  temp_max_c: 'Máximo (°C)',
  tolerance_min: 'Tolerancia (min)',
};

export const SHADOW_POLL_MS = 3000;
/** 40 × 3 s = 2 min */
export const SHADOW_POLL_MAX_ATTEMPTS = 40;

export function shadowRows(shadow: ShadowState): ShadowRow[] {
  return DEVICE_CONFIG_FIELDS.map((field) => {
    const desired = shadow.desired[field];
    const reported = shadow.reported[field];
    return { field, label: FIELD_LABELS[field], desired, reported, pending: desired !== undefined && desired !== reported };
  });
}

export function hasPending(shadow: ShadowState): boolean {
  return shadowRows(shadow).some((row) => row.pending);
}

export function shouldKeepPolling(shadow: ShadowState | null, attempts: number): boolean {
  return shadow !== null && hasPending(shadow) && attempts < SHADOW_POLL_MAX_ATTEMPTS;
}

export type SaveOutcome =
  | { kind: 'saved' }
  | { kind: 'saved-db-only' }
  | { kind: 'shadow-failed' }
  | { kind: 'error'; message: string };

export function saveOutcomeMessage(outcome: SaveOutcome): string {
  switch (outcome.kind) {
    case 'saved':
      return 'Guardado y enviado al equipo';
    case 'saved-db-only':
      return 'Guardado en base (sin conexión al equipo en este entorno)';
    case 'shadow-failed':
      return 'No se pudo enviar al equipo; no se guardó ningún cambio. Reintentá.';
    case 'error':
      return outcome.message;
  }
}
