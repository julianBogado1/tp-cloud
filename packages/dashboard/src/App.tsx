import { useCallback, useEffect, useMemo, useState } from 'react';
import type { IngestedReading, ThresholdConfig } from '@snowball/shared';
import { ackAlert, ApiError, connectLive, fetchAlerts, fetchMe, fetchTelemetry, fetchUnits, setUnauthorizedHandler, type AlertRow, type UnitWithReading } from './api';
import { canAck, canConfig, clearSession, getSession, isAdmin, setSession, type Session } from './auth';
import { AlertsTable } from './AlertsTable';
import { COGNITO, consumeLoginRedirect, logoutUrl } from './cognito';
import { ConfigPanel } from './ConfigPanel';
import { Login } from './Login';
import { Sparkline } from './Sparkline';
import { UnitCard } from './UnitCard';
import { UnitsMap } from './UnitsMap';
import { UsersPanel } from './UsersPanel';

const HISTORY_POINTS = 60;
const ALERTS_REFRESH_MS = 30_000;

/**
 * Session gate: no valid token → login page (Cognito Hosted UI); coming back
 * from the login redirect → resolve the user with /auth/me; otherwise the
 * dashboard.
 */
export function App() {
  const [session, setSessionState] = useState<Session | null>(() => getSession());
  const [loginError, setLoginError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(() => consumeLoginRedirect().kind === 'tokens');

  useEffect(() => {
    // A 401 from any call (or a 4401 WebSocket close) lands here.
    setUnauthorizedHandler(() => setSessionState(null));
  }, []);

  useEffect(() => {
    const redirect = consumeLoginRedirect();
    if (redirect.kind === 'error') setLoginError(redirect.code);
    if (redirect.kind !== 'tokens') return;
    let cancelled = false;
    fetchMe(redirect.accessToken).then(
      (user) => {
        if (cancelled) return;
        const s = { token: redirect.accessToken, user };
        setSession(s);
        setSessionState(s);
        setCompleting(false);
      },
      (err: unknown) => {
        if (cancelled) return;
        // 401: valid Cognito user without an active snowball-users row.
        setLoginError(err instanceof ApiError && err.status === 401 ? 'no_access' : 'generic');
        setCompleting(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (completing) return <main className="app"><p className="empty">Iniciando sesión…</p></main>;
  if (!session) return <Login error={loginError} />;
  return (
    <Dashboard
      session={session}
      onLogout={() => {
        clearSession();
        // Also end the Hosted UI session, or the next "Ingresar" logs the same
        // user back in without asking. Cognito returns through the bridge's /logout.
        if (COGNITO) window.location.assign(logoutUrl(COGNITO));
        else setSessionState(null);
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
          ? { ...u, setpoint_c: config.setpoint_c, temp_min_c: config.temp_min_c, temp_max_c: config.temp_max_c, tolerance_min: config.tolerance_min }
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

      <UnitsMap
        units={units}
        history={history}
        nowMs={nowMs}
        selected={selected}
        onSelect={(id) => setSelected((prev) => (prev === id ? null : id))}
      />

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
        {units.length === 0 && <p className="empty">No hay unidades activas en DynamoDB.</p>}
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
