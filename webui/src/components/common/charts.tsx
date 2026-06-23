/**
 * Tiny, dependency-free SVG chart primitives for the console.
 *
 * Deliberately NOT @elastic/charts (heavy). These are small, theme-aware SVGs
 * (donut, ranked bar list, sparkline, mini bar series, radial gauge) sized for
 * dashboard tiles. Colours come from `lib/theme`; text uses EUI's subdued tone.
 */
import React from 'react';
import { EuiFlexGroup, EuiFlexItem, EuiText } from '@elastic/eui';
import { COLORS, chartColor } from '../../lib/theme';

const MUTED = COLORS.subdued;

export interface Segment {
  label: string;
  value: number;
  color?: string;
}

/* ------------------------------------------------------------------ donut -- */
export const Donut: React.FC<{
  segments: Segment[];
  size?: number;
  thickness?: number;
  centerValue?: React.ReactNode;
  centerLabel?: string;
}> = ({ segments, size = 132, thickness = 16, centerValue, centerLabel }) => {
  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img">
      <circle cx={cx} cy={cx} r={r} fill="none" stroke={MUTED} strokeOpacity={0.15} strokeWidth={thickness} />
      {total > 0 &&
        segments.map((seg, i) => {
          const frac = Math.max(0, seg.value) / total;
          const dash = frac * c;
          const el = (
            <circle
              key={seg.label}
              cx={cx}
              cy={cx}
              r={r}
              fill="none"
              stroke={seg.color || chartColor(i)}
              strokeWidth={thickness}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
              transform={`rotate(-90 ${cx} ${cx})`}
            />
          );
          offset += dash;
          return el;
        })}
      {(centerValue !== undefined || centerLabel) && (
        <g>
          <text x="50%" y="47%" textAnchor="middle" dominantBaseline="central"
                style={{ fontSize: 22, fontWeight: 700, fill: 'currentColor' }}>
            {centerValue}
          </text>
          {centerLabel && (
            <text x="50%" y="63%" textAnchor="middle" dominantBaseline="central"
                  style={{ fontSize: 10, fill: MUTED }}>
              {centerLabel}
            </text>
          )}
        </g>
      )}
    </svg>
  );
};

/** Donut + a legend, side by side. */
export const DonutWithLegend: React.FC<{
  segments: Segment[];
  size?: number;
  centerValue?: React.ReactNode;
  centerLabel?: string;
}> = ({ segments, size, centerValue, centerLabel }) => (
  <EuiFlexGroup alignItems="center" gutterSize="l" responsive={false} wrap>
    <EuiFlexItem grow={false}>
      <Donut segments={segments} size={size} centerValue={centerValue} centerLabel={centerLabel} />
    </EuiFlexItem>
    <EuiFlexItem>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {segments.map((s, i) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color || chartColor(i), flex: '0 0 auto' }} />
            <EuiText size="xs" style={{ flex: 1 }}><span>{s.label}</span></EuiText>
            <EuiText size="xs" color="subdued"><strong>{s.value}</strong></EuiText>
          </div>
        ))}
      </div>
    </EuiFlexItem>
  </EuiFlexGroup>
);

/* -------------------------------------------------------------- bar list -- */
export const BarList: React.FC<{
  items: Segment[];
  format?: (n: number) => React.ReactNode;
  max?: number;
}> = ({ items, format, max }) => {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => (
        <div key={it.label}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
            <EuiText size="xs"><span style={{ wordBreak: 'break-word' }}>{it.label}</span></EuiText>
            <EuiText size="xs" color="subdued"><strong>{format ? format(it.value) : it.value}</strong></EuiText>
          </div>
          <div style={{ height: 8, borderRadius: 6, background: 'rgba(105,112,125,0.14)', overflow: 'hidden' }}>
            <div style={{
              width: `${Math.max(2, (it.value / top) * 100)}%`,
              height: '100%',
              borderRadius: 6,
              background: it.color || chartColor(i),
            }} />
          </div>
        </div>
      ))}
    </div>
  );
};

/* ------------------------------------------------------------ sparkline -- */
export const Sparkline: React.FC<{
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}> = ({ values, width = 240, height = 48, color = COLORS.primary, fill = true }) => {
  if (!values.length) return <svg width={width} height={height} />;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const stepX = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => [i * stepX, height - ((v - min) / span) * (height - 6) - 3]);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      {fill && <path d={area} fill={color} fillOpacity={0.12} />}
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};

/* ----------------------------------------------------------- histogram --- */
export const Histogram: React.FC<{
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  markerColor?: string;
  markers?: number[];
}> = ({ values, width = 480, height = 72, color = COLORS.success, markerColor = COLORS.warning, markers = [] }) => {
  if (!values.length) return <svg width={width} height={height} />;
  const max = Math.max(1, ...values);
  const gap = 3;
  const bw = (width - gap * (values.length - 1)) / values.length;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      {values.map((v, i) => {
        const h = (v / max) * (height - 2);
        const x = i * (bw + gap);
        const y = height - h;
        const isMarker = markers.includes(i);
        return (
          <g key={i}>
            <rect x={x} y={y} width={Math.max(1, bw)} height={Math.max(1, h)}
                  rx={2} fill={color} fillOpacity={isMarker ? 1 : 0.9} />
            {isMarker && (
              <rect x={x} y={y - 7} width={Math.max(1, bw)} height={4}
                    rx={1} fill={markerColor} />
            )}
          </g>
        );
      })}
    </svg>
  );
};

/* ------------------------------------------------------------- mini bars -- */
export const MiniBars: React.FC<{
  values: number[];
  width?: number;
  height?: number;
  color?: string;
}> = ({ values, width = 240, height = 48, color = COLORS.primary }) => {
  if (!values.length) return <svg width={width} height={height} />;
  const max = Math.max(1, ...values);
  const gap = 2;
  const bw = (width - gap * (values.length - 1)) / values.length;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img">
      {values.map((v, i) => {
        const h = (v / max) * (height - 2);
        return (
          <rect key={i} x={i * (bw + gap)} y={height - h} width={Math.max(1, bw)} height={Math.max(1, h)}
                rx={1.5} fill={color} fillOpacity={0.85} />
        );
      })}
    </svg>
  );
};

/* ----------------------------------------------------------- risk gauge --- */
export const RiskGauge: React.FC<{ score: number; size?: number; color: string }> = ({
  score,
  size = 120,
  color,
}) => {
  const thickness = 12;
  const r = (size - thickness) / 2;
  const c = Math.PI * r; // half circle
  const frac = Math.max(0, Math.min(100, score)) / 100;
  return (
    <svg width={size} height={size / 2 + 8} viewBox={`0 0 ${size} ${size / 2 + 8}`} role="img">
      <path
        d={`M ${thickness / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - thickness / 2} ${size / 2}`}
        fill="none" stroke={MUTED} strokeOpacity={0.15} strokeWidth={thickness} strokeLinecap="round"
      />
      <path
        d={`M ${thickness / 2} ${size / 2} A ${r} ${r} 0 0 1 ${size - thickness / 2} ${size / 2}`}
        fill="none" stroke={color} strokeWidth={thickness} strokeLinecap="round"
        strokeDasharray={`${frac * c} ${c}`}
      />
      <text x="50%" y="82%" textAnchor="middle" style={{ fontSize: 22, fontWeight: 700, fill: 'currentColor' }}>
        {Math.round(score)}
      </text>
    </svg>
  );
};
