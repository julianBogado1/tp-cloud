import { describe, expect, test } from 'vitest';
import { DEVICE_CONFIG_FIELDS } from '@snowball/shared';
import { hasPending, saveOutcomeMessage, shadowRows, shouldKeepPolling } from '../src/shadow-diff';

describe('shadow diff', () => {
  test('rows follow field order with labels', () => {
    const rows = shadowRows({ desired: {}, reported: {} });
    expect(rows.map((r) => r.field)).toEqual([...DEVICE_CONFIG_FIELDS]);
    expect(rows[3].label).toBe('Tolerancia (min)');
  });

  test('pending only when desired differs from reported', () => {
    const rows = shadowRows({ desired: { setpoint_c: -20, temp_min_c: -25 }, reported: { setpoint_c: -20, temp_min_c: -24 } });
    expect(rows.find((r) => r.field === 'setpoint_c')!.pending).toBe(false);
    expect(rows.find((r) => r.field === 'temp_min_c')!.pending).toBe(true);
  });

  test('rows show undefined reported as pending', () => {
    const row = shadowRows({ desired: { temp_max_c: -15 }, reported: {} }).find((r) => r.field === 'temp_max_c')!;
    expect(row.pending).toBe(true);
    expect(row.reported).toBeUndefined();
  });

  test('field without desired is never pending', () => {
    expect(hasPending({ desired: {}, reported: { setpoint_c: -18 } })).toBe(false);
  });

  test('stops polling after the max attempts', () => {
    const pendingShadow = { desired: { setpoint_c: -20 }, reported: { setpoint_c: -18 } };
    expect(shouldKeepPolling(pendingShadow, 39)).toBe(true);
    expect(shouldKeepPolling(pendingShadow, 40)).toBe(false);
    expect(shouldKeepPolling(null, 0)).toBe(false);
    expect(shouldKeepPolling({ desired: { setpoint_c: -18 }, reported: { setpoint_c: -18 } }, 0)).toBe(false);
  });

  test('saveOutcomeMessage maps each outcome to its copy', () => {
    expect(saveOutcomeMessage({ kind: 'saved' })).toBe('Guardado y enviado al equipo');
    expect(saveOutcomeMessage({ kind: 'saved-db-only' })).toBe('Guardado en base (sin conexión al equipo en este entorno)');
    expect(saveOutcomeMessage({ kind: 'shadow-failed' })).toBe('No se pudo enviar al equipo; no se guardó ningún cambio. Reintentá.');
    expect(saveOutcomeMessage({ kind: 'error', message: 'boom' })).toBe('boom');
  });
});
