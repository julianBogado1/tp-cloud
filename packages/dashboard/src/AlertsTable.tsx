import type { AlertRow } from './api';

export function AlertsTable({ alerts }: { alerts: AlertRow[] }) {
  if (alerts.length === 0) return <p className="empty">Sin alertas registradas.</p>;
  return (
    <table className="alerts">
      <thead>
        <tr>
          <th>Unidad</th>
          <th>Tipo</th>
          <th>Emitida</th>
          <th>Duración</th>
          <th>Temp</th>
          <th>Detalle</th>
        </tr>
      </thead>
      <tbody>
        {alerts.map((a) => (
          <tr key={a.id}>
            <td>{a.unit_id}</td>
            <td>{a.severity}</td>
            <td>{new Date(a.emitted_at).toLocaleString()}</td>
            <td>{a.duration_min} min</td>
            <td>{a.temp_c !== null ? `${a.temp_c}°C` : '—'}</td>
            <td>{a.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
