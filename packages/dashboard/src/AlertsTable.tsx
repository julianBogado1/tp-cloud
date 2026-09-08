import { useState } from 'react';
import type { AlertRow } from './api';

interface Props {
  alerts: AlertRow[];
  canAck: boolean;
  onAck: (id: number) => Promise<void>;
}

export function AlertsTable({ alerts, canAck, onAck }: Props) {
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (alerts.length === 0) return <p className="empty">Sin alertas registradas.</p>;

  async function ack(id: number) {
    setBusy(id);
    setError(null);
    try {
      await onAck(id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <p className="error">{error}</p>}
      <table className="alerts">
        <thead>
          <tr>
            <th>Unidad</th>
            <th>Tipo</th>
            <th>Emitida</th>
            <th>Duración</th>
            <th>Temp</th>
            <th>Detalle</th>
            <th>Estado</th>
          </tr>
        </thead>
        <tbody>
          {alerts.map((a) => (
            <tr key={a.id} className={a.acknowledged_at ? 'acked' : ''}>
              <td>{a.unit_id}</td>
              <td>{a.severity}</td>
              <td>{new Date(a.emitted_at).toLocaleString()}</td>
              <td>{a.duration_min} min</td>
              <td>{a.temp_c !== null ? `${a.temp_c}°C` : '—'}</td>
              <td>{a.detail}</td>
              <td>
                {a.acknowledged_at ? (
                  <span className="muted">vista {new Date(a.acknowledged_at).toLocaleString()}</span>
                ) : canAck ? (
                  <button className="link" disabled={busy === a.id} onClick={() => ack(a.id)}>
                    {busy === a.id ? '…' : 'Marcar vista'}
                  </button>
                ) : (
                  <span className="muted">pendiente</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
