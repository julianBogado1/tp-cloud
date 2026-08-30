import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IngestedReading } from '@snowball/shared';
import { connectLive, fetchAlerts, fetchTelemetry, fetchUnits, type AlertRow, type UnitWithReading } from './api';
import { AlertsTable } from './AlertsTable';
import { Sparkline } from './Sparkline';
import { UnitCard } from './UnitCard';

const HISTORY_POINTS = 60;
const ALERTS_REFRESH_MS = 30_000;

export function App() {
  const [units, setUnits] = useState<UnitWithReading[] | null>(null);
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [history, setHistory] = useState<Record<string, IngestedReading[]>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<IngestedReading[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    fetchUnits().then(setUnits, (err: Error) => setError(err.message));
    const clock = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    const load = () => fetchAlerts().then(setAlerts, () => undefined);
    load();
    const timer = setInterval(load, ALERTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const onReading = useCallback((reading: IngestedReading) => {
    setHistory((prev) => {
      const readings = [...(prev[reading.unit_id] ?? []), reading].slice(-HISTORY_POINTS);
      return { ...prev, [reading.unit_id]: readings };
    });
    setNowMs(Date.now());
  }, []);

  useEffect(() => {
    if (!units || units.length === 0) return;
    return connectLive(units.map((u) => u.unit_id), onReading, setConnected);
  }, [units, onReading]);

  useEffect(() => {
    if (!selected) return;
    setDetail([]);
    fetchTelemetry(selected, 200).then(
      (readings) => setDetail(readings.slice().reverse()), // API returns newest-first
      () => undefined,
    );
  }, [selected]);

  const selectedUnit = useMemo(
    () => units?.find((u) => u.unit_id === selected) ?? null,
    [units, selected],
  );

  if (error) return <main className="app"><p className="empty">Error contra la API: {error}</p></main>;
  if (!units) return <main className="app"><p className="empty">Cargando…</p></main>;

  return (
    <main className="app">
      <header className="topbar">
        <h1>Snowball</h1>
        <span className={`badge ${connected ? 'badge-ok' : 'badge-stale'}`}>
          {connected ? 'feed en vivo' : 'reconectando…'}
        </span>
      </header>

      <section className="units">
        {units.map((unit) => (
          <UnitCard
            key={unit.unit_id}
            unit={unit}
            history={history[unit.unit_id] ?? []}
            nowMs={nowMs}
            selected={selected === unit.unit_id}
            onSelect={(id) => setSelected((prev) => (prev === id ? null : id))}
          />
        ))}
        {units.length === 0 && <p className="empty">No hay unidades activas en RDS.</p>}
      </section>

      {selectedUnit && (
        <section className="detail">
          <h2>Historial — {selectedUnit.unit_id}</h2>
          {detail.length > 1 ? (
            <Sparkline
              values={detail.map((r) => r.temp_c)}
              min={selectedUnit.temp_min_c}
              max={selectedUnit.temp_max_c}
              width={900}
              height={180}
            />
          ) : (
            <p className="empty">Sin historial suficiente en DynamoDB.</p>
          )}
        </section>
      )}

      <section>
        <h2>Alertas</h2>
        <AlertsTable alerts={alerts} />
      </section>
    </main>
  );
}
