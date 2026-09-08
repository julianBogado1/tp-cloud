import { useEffect, useState, type FormEvent } from 'react';
import type { ThresholdConfig } from '@snowball/shared';
import { fetchShadow, updateConfig, type ConfigPatch, type ShadowState, type UnitWithReading } from './api';

interface Props {
  unit: UnitWithReading;
  editable: boolean;
  onSaved: (config: ThresholdConfig) => void;
}

/**
 * Setpoint + thresholds of the selected unit. Shows the Device Shadow's
 * desired vs reported setpoint so the operator sees whether the unit has
 * applied the last order (spec §4 of the PDF).
 */
export function ConfigPanel({ unit, editable, onSaved }: Props) {
  const [form, setForm] = useState({
    setpoint_c: unit.setpoint_c ?? 0,
    temp_min_c: unit.temp_min_c ?? 0,
    temp_max_c: unit.temp_max_c ?? 0,
  });
  const [shadow, setShadow] = useState<ShadowState | null | 'unavailable'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-fires only when the SELECTED UNIT changes (not on every field edit
  // saved back into `unit`), so a successful save's confirmation message
  // isn't erased by this effect re-running, and the shadow isn't re-fetched
  // twice for the same save (submit() already refreshes it once).
  useEffect(() => {
    setMessage(null);
    let cancelled = false;
    fetchShadow(unit.unit_id).then(
      (s) => { if (!cancelled) setShadow(s); },
      () => { if (!cancelled) setShadow('unavailable'); },
    );
    return () => { cancelled = true; };
  }, [unit.unit_id]);

  // Keeps the form synced to the unit's persisted values, including right
  // after a save changes them (via onSaved → App's units state → this prop).
  useEffect(() => {
    setForm({ setpoint_c: unit.setpoint_c ?? 0, temp_min_c: unit.temp_min_c ?? 0, temp_max_c: unit.temp_max_c ?? 0 });
  }, [unit.unit_id, unit.setpoint_c, unit.temp_min_c, unit.temp_max_c]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const patch: ConfigPatch = {};
    if (form.setpoint_c !== unit.setpoint_c) patch.setpoint_c = form.setpoint_c;
    if (form.temp_min_c !== unit.temp_min_c) patch.temp_min_c = form.temp_min_c;
    if (form.temp_max_c !== unit.temp_max_c) patch.temp_max_c = form.temp_max_c;
    if (Object.keys(patch).length === 0) { setBusy(false); setMessage('Sin cambios'); return; }
    try {
      const saved = await updateConfig(unit.unit_id, patch);
      onSaved(saved);
      setMessage(saved.warning ? 'Guardado en base, pero no se pudo enviar al equipo (shadow)' : 'Guardado');
      fetchShadow(unit.unit_id).then(setShadow, () => setShadow('unavailable'));
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const field = (key: keyof typeof form, label: string) => (
    <label>
      {label}
      <input
        type="number"
        step="0.5"
        value={form[key]}
        disabled={!editable}
        onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })}
      />
    </label>
  );

  return (
    <form className="form config" onSubmit={submit}>
      <h3>Configuración</h3>
      {field('setpoint_c', 'Setpoint (°C)')}
      {field('temp_min_c', 'Mínimo (°C)')}
      {field('temp_max_c', 'Máximo (°C)')}
      <p className="muted">
        Equipo:{' '}
        {shadow === null && 'consultando…'}
        {shadow === 'unavailable' && 'sin datos del shadow'}
        {shadow && shadow !== 'unavailable' && (
          <>
            deseado {shadow.desired.setpoint_c ?? '—'}° · aplicado {shadow.reported.setpoint_c ?? '—'}°
            {shadow.desired.setpoint_c !== undefined && shadow.desired.setpoint_c !== shadow.reported.setpoint_c && ' (pendiente)'}
          </>
        )}
      </p>
      {editable && <button className="primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>}
      {message && <p className="muted">{message}</p>}
    </form>
  );
}
