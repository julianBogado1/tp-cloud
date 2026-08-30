interface Props {
  values: number[];
  min?: number | null;
  max?: number | null;
  width?: number;
  height?: number;
}

/**
 * Hand-rolled SVG polyline: enough for a per-unit temperature trend without
 * pulling a chart library into the static bundle. Threshold band drawn when
 * the unit has config.
 */
export function Sparkline({ values, min = null, max = null, width = 260, height = 60 }: Props) {
  if (values.length < 2) return <div className="sparkline-empty">esperando datos…</div>;

  const pad = 4;
  const candidates = [...values, ...(min !== null ? [min] : []), ...(max !== null ? [max] : [])];
  const lo = Math.min(...candidates);
  const hi = Math.max(...candidates);
  const span = hi - lo || 1;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - 2 * pad);
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - 2 * pad);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');

  return (
    <svg width={width} height={height} className="sparkline" role="img" aria-label="tendencia de temperatura">
      {min !== null && max !== null && (
        <rect x={0} y={y(max)} width={width} height={Math.max(0, y(min) - y(max))} className="sparkline-band" />
      )}
      <polyline points={points} fill="none" className="sparkline-line" />
    </svg>
  );
}
