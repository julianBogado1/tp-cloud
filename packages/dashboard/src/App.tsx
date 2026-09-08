import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IngestedReading, ThresholdConfig } from '@snowball/shared';
import { ackAlert, connectLive, fetchAlerts, fetchTelemetry, fetchUnits, setUnauthorizedHandler, type AlertRow, type UnitWithReading } from './api';
import { canAck, canConfig, clearSession, getSession, isAdmin, setSession, type Session } from './auth';
import { AlertsTable } from './AlertsTable';
import { ConfigPanel } from './ConfigPanel';
import { Login } from './Login';
import { Sparkline } from './Sparkline';
import { UnitCard } from './UnitCard';
import { UsersPanel } from './UsersPanel';

const HISTORY_POINTS = 60;
const ALERTS_REFRESH_MS = 30_000;

/** Session gate: no valid token → login page; otherwise the dashboard. */
export function App() {
  const [session, setSessionState] = useState<Session | null>(() => getSession());

  useEffect(() => {
    // A 401 from any call (or a 4401 WebSocket close) lands here.
    setUnauthorizedHandler(() => setSessionState(null));
  }, []);

  if (!session) {
    return (
      <Login
        onLogin={(s) => {
          setSession(s);
          setSessionState(s);
        }}
      />
    );
  }
  return (
    <Dashboard
      session={session}
      onLogout={() => {
        clearSession();
        setSessionState(null);
      }}
    />
  );
}

function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
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
    return connectLive(units.map((u) => u.unit_id), session.token, onReading, setConnected);
  }, [units, onReading, session.token]);

  useEffect(() => {
    if (!selected) return;
    setDetail([]);
    fetchTelemetry(selected, 200).then(
      (readings) => setDetail(readings.slice().reverse()), // API returns newest-first
      () => undefined,
    );
  }, [selected]);

  const onAck = useCallback(async (id: number) => {
    const updated = await ackAlert(id);
    setAlerts((prev) => prev.map((a) => (a.id === id ? updated : a)));
  }, []);

  const onConfigSaved = useCallback((config: ThresholdConfig) => {
    setUnits((prev) =>
      prev?.map((u) =>
        u.unit_id === config.unit_id
          ? { ...u, setpoint_c: config.setpoint_c, temp_min_c: config.temp_min_c, temp_max_c: config.temp_max_c }
          : u,
      ) ?? prev,
    );
  }, []);

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
        <span className="spacer" />
        <span className="muted">{session.user.email} · {session.user.role}</span>
        <button className="link" onClick={onLogout}>Salir</button>
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
          <ConfigPanel unit={selectedUnit} editable={canConfig(session.user.role)} onSaved={onConfigSaved} />
        </section>
      )}

      <section>
        <h2>Alertas</h2>
        <AlertsTable alerts={alerts} canAck={canAck(session.user.role)} onAck={onAck} />
      </section>

      {isAdmin(session.user.role) && <UsersPanel selfId={session.user.id} />}
    </main>
  );
}
