import { useEffect, useState, type FormEvent } from 'react';
import { DEVICE_CONFIG_FIELDS, type DeviceConfig, type ThresholdConfig } from '@snowball/shared';
import { ApiError, fetchShadow, updateConfig, type ConfigPatch, type ShadowState, type UnitWithReading } from './api';
import {
  FIELD_LABELS,
  hasPending,
  saveOutcomeMessage,
  SHADOW_POLL_MAX_ATTEMPTS,
  SHADOW_POLL_MS,
  shadowRows,
  shouldKeepPolling,
  type SaveOutcome,
} from './shadow-diff';

interface Props {
  unit: UnitWithReading;
  editable: boolean;
  onSaved: (config: ThresholdConfig) => void;
}

/** Form state now covers all four fields. */
type ConfigForm = DeviceConfig;

function formFromUnit(unit: UnitWithReading): ConfigForm {
  return {
    setpoint_c: unit.setpoint_c ?? 0,
    temp_min_c: unit.temp_min_c ?? 0,
    temp_max_c: unit.temp_max_c ?? 0,
    tolerance_min: unit.tolerance_min ?? 0,
  };
}

function outcomeOf(err: unknown): SaveOutcome {
  if (err instanceof ApiError && err.status === 502) return { kind: 'shadow-failed' };
  return { kind: 'error', message: (err as Error).message };
}

/**
 * Setpoint + thresholds of the selected unit. Shows the Device Shadow's
 * desired vs reported value of every field so the operator sees whether the
 * unit has applied the last order (spec §4 of the PDF), and re-reads the
 * shadow while any field is pending, giving up after 2 min.
 */
export function ConfigPanel({ unit, editable, onSaved }: Props) {
  const [form, setForm] = useState<ConfigForm>(() => formFromUnit(unit));
  const [shadow, setShadow] = useState<ShadowState | null | 'unavailable'>(null);
  const [attempts, setAttempts] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-fires only when the SELECTED UNIT changes (not on every field edit
  // saved back into `unit`), so a successful save's confirmation message
  // isn't erased by this effect re-running, and the shadow isn't re-fetched
  // twice for the same save (submit() already refreshes it once).
  useEffect(() => {
    setMessage(null);
    setShadow(null);
    setAttempts(0);
    let cancelled = false;
    fetchShadow(unit.unit_id).then(
      (s) => { if (!cancelled) setShadow(s); },
      () => { if (!cancelled) setShadow('unavailable'); },
    );
    return () => { cancelled = true; };
  }, [unit.unit_id]);

  // While some field is pending, re-read the shadow every SHADOW_POLL_MS.
  // Each fetch produces a new `shadow`, which re-runs this effect.
  useEffect(() => {
    if (shadow === 'unavailable' || !shouldKeepPolling(shadow, attempts)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchShadow(unit.unit_id).then(
        (s) => { if (!cancelled) { setShadow(s); setAttempts((n) => n + 1); } },
        () => { if (!cancelled) setShadow('unavailable'); },
      );
    }, SHADOW_POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [unit.unit_id, shadow, attempts]);

  // Keeps the form synced to the unit's persisted values, including right
  // after a save changes them (via onSaved → App's units state → this prop).
  useEffect(() => {
    setForm(formFromUnit(unit));
  }, [unit.unit_id, unit.setpoint_c, unit.temp_min_c, unit.temp_max_c, unit.tolerance_min]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const patch: ConfigPatch = {};
    for (const key of DEVICE_CONFIG_FIELDS) {
      if (form[key] !== unit[key]) patch[key] = form[key];
    }
    if (Object.keys(patch).length === 0) { setBusy(false); setMessage('Sin cambios'); return; }
    try {
      const saved = await updateConfig(unit.unit_id, patch);
      onSaved(saved);
      setMessage(saveOutcomeMessage({ kind: saved.warning === 'shadow not configured' ? 'saved-db-only' : 'saved' }));
      setAttempts(0);
      fetchShadow(unit.unit_id).then(setShadow, () => setShadow('unavailable'));
    } catch (err) {
      setMessage(saveOutcomeMessage(outcomeOf(err)));
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof ConfigForm, step = '0.5', min?: string) => (
    <label>
      {FIELD_LABELS[key]}
      <input
        type="number"
        step={step}
        min={min}
        value={form[key]}
        disabled={!editable}
        onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
      />
    </label>
  );

  const gaveUp = shadow !== null && shadow !== 'unavailable' && hasPending(shadow) && attempts >= SHADOW_POLL_MAX_ATTEMPTS;

  return (
    <form className="form config" onSubmit={submit}>
      <h3>Configuración</h3>
      {field('setpoint_c')}
      {field('temp_min_c')}
      {field('temp_max_c')}
      {field('tolerance_min', '1', '0')}
      <div className="muted">
        Equipo:{' '}
        {shadow === null && 'consultando…'}
        {shadow === 'unavailable' && 'sin datos del shadow'}
        {shadow && shadow !== 'unavailable' && (
          <table className="shadow">
            <thead>
              <tr><th>Campo</th><th>Deseado</th><th>Aplicado</th><th /></tr>
            </thead>
            <tbody>
              {shadowRows(shadow).map((row) => (
                <tr key={row.field}>
                  <td>{row.label}</td>
                  <td>{row.desired ?? '—'}</td>
                  <td>{row.reported ?? '—'}</td>
                  <td>{row.pending && <span className="badge badge-stale">pendiente</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {gaveUp && (
        <p className="muted">
          El equipo todavía no confirmó: puede estar desconectado. La orden queda guardada y se aplica al reconectar.
        </p>
      )}
      {editable && <button className="primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>}
      {message && <p className="muted">{message}</p>}
    </form>
  );
}
