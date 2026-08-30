import type { IngestedReading } from '@snowball/shared';
import type { UnitWithReading } from './api';
import { Sparkline } from './Sparkline';
import { formatAgo, readingStatus } from './status';

interface Props {
  unit: UnitWithReading;
  history: IngestedReading[];
  nowMs: number;
  selected: boolean;
  onSelect: (unitId: string) => void;
}

const STATUS_LABEL = { ok: 'en rango', excursion: 'fuera de rango', stale: 'sin señal' } as const;

export function UnitCard({ unit, history, nowMs, selected, onSelect }: Props) {
  const last = history.length > 0 ? history[history.length - 1] : unit.last_reading;
  const status = readingStatus(last, unit, nowMs);

  return (
    <button className={`unit-card status-${status}${selected ? ' selected' : ''}`} onClick={() => onSelect(unit.unit_id)}>
      <header>
        <span className="unit-id">{unit.unit_id}</span>
        <span className={`badge badge-${status}`}>{STATUS_LABEL[status]}</span>
      </header>
      <div className="temp">{last ? `${last.temp_c.toFixed(1)}°C` : '—'}</div>
      <div className="meta">
        {unit.temp_min_c !== null && unit.temp_max_c !== null && (
          <span>rango {unit.temp_min_c}° a {unit.temp_max_c}°</span>
        )}
        {last && <span>hace {formatAgo(last.ts, nowMs)}</span>}
        {last && <span>bat {Math.round(last.battery)}%</span>}
      </div>
      <Sparkline values={history.map((r) => r.temp_c)} min={unit.temp_min_c} max={unit.temp_max_c} />
      {unit.description && <div className="description">{unit.description}</div>}
    </button>
  );
}
