/**
 * SOC-domain chart primitives — theme-aware (palette.ts), accessible, no new deps.
 *
 * These complement the generic wrappers in `charts.tsx` with SOC-shaped views:
 *   - `MitreHeatmap`     — ATT&CK tactic × technique coverage grid (+ data-table fallback).
 *   - `BurnDownChart`    — open vs closed cases over time (stacked area + net line).
 *   - `AreaSpark`        — a gradient-filled area sparkline (thin stroke, no axes).
 *   - `MultiSeriesTrend` — several labelled series over time with a legend.
 *
 * UNTRUSTED-data note (#9): every value here is numeric or a caller-supplied label,
 * rendered as plain SVG `<text>` / recharts category strings / plain DOM text —
 * NEVER HTML. Attacker-influenced labels cannot inject markup. Colours resolve from
 * the live CSS tokens via palette.ts, so all four track the active theme with no hex.
 */
import * as React from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/cn';
import { categorical, semanticColor, token } from './palette';

const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 } as const;

/* ------------------------------------------------------------------------- */
/* Shared tooltip (token-themed, plain-text).                                 */
/* ------------------------------------------------------------------------- */

interface SocTooltipProps {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string }>;
  label?: string | number;
  format?: (v: number) => string;
}

function SocTooltip({ active, payload, label, format }: SocTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const fmt = (v: number | string | undefined) =>
    typeof v === 'number' ? (format ? format(v) : v.toLocaleString()) : (v ?? '');
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-elev2">
      {label != null ? <div className="mb-1 font-medium text-foreground">{String(label)}</div> : null}
      <ul className="flex flex-col gap-1">
        {payload.map((p, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="ml-auto font-mono font-semibold tabular-nums text-foreground">{fmt(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ========================================================================= */
/* MitreHeatmap                                                              */
/* ========================================================================= */

export interface MitreCell {
  /** Technique id (e.g. "T1059"). Plain text. */
  technique: string;
  /** Optional technique name (plain text). */
  name?: string;
  /** Coverage/observation count for this technique in this tactic column. */
  value: number;
}

export interface MitreTacticColumn {
  /** Tactic id/key (e.g. "TA0002"). */
  tactic: string;
  /** Tactic display label (plain text, e.g. "Execution"). */
  label: string;
  /** The technique cells under this tactic (top-N already chosen by the caller). */
  cells: MitreCell[];
}

export interface MitreHeatmapProps {
  columns: MitreTacticColumn[];
  /** Max value used to scale the colour ramp (defaults to the data max). */
  maxValue?: number;
  /** Colour token name for the ramp (default 'critical'). */
  colorToken?: string;
  /** Accessible name. */
  ariaLabel?: string;
  className?: string;
}

/** Quantise a 0..1 intensity into 5 alpha steps so empty cells read distinctly. */
function intensityAlpha(v: number, max: number): number {
  if (max <= 0 || v <= 0) return 0;
  const r = Math.min(1, v / max);
  // 5 visible buckets (0.18 → 1.0) so low counts are still legible on a card.
  return 0.18 + Math.round(r * 4) * (0.82 / 4);
}

/**
 * ATT&CK tactic × technique coverage grid. Each tactic is a column; each technique
 * a tinted cell whose alpha encodes its count. Includes a legend and a visually
 * hidden `<table>` data fallback for screen readers / no-CSS. Pure DOM (no SVG
 * paths), so it's robust under jsdom and fully token-themed.
 */
export const MitreHeatmap = React.forwardRef<HTMLDivElement, MitreHeatmapProps>(
  ({ columns, maxValue, colorToken = 'critical', ariaLabel, className }, ref) => {
    const cols = columns ?? [];
    const dataMax =
      maxValue ?? cols.reduce((m, c) => Math.max(m, ...c.cells.map((x) => x.value || 0)), 0);
    const base = colorToken;
    const label =
      ariaLabel ?? `MITRE ATT&CK coverage heatmap across ${cols.length} tactic(s)`;

    if (cols.length === 0) {
      return (
        <div
          ref={ref}
          role="img"
          aria-label={`${label} (no data)`}
          className={cn('flex items-center justify-center rounded-md border border-dashed border-border py-10 text-sm text-muted-foreground', className)}
        >
          No coverage data
        </div>
      );
    }

    const maxRows = cols.reduce((m, c) => Math.max(m, c.cells.length), 0);

    return (
      <div ref={ref} className={cn('w-full', className)}>
        {/* Visible grid (decorative; the table below is the accessible source). */}
        <div role="presentation" className="overflow-x-auto">
          <div
            className="grid min-w-max gap-1"
            style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(72px, 1fr))` }}
          >
            {/* Header row */}
            {cols.map((c) => (
              <div
                key={`h-${c.tactic}`}
                className="truncate px-1 pb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                title={c.label}
              >
                {c.label}
              </div>
            ))}
            {/* Cells, row-major across the tallest column. */}
            {Array.from({ length: maxRows }).map((_, row) =>
              cols.map((c) => {
                const cell = c.cells[row];
                if (!cell) {
                  return <div key={`${c.tactic}-${row}`} className="h-9 rounded-sm bg-muted/20" aria-hidden />;
                }
                const a = intensityAlpha(cell.value, dataMax);
                return (
                  <div
                    key={`${c.tactic}-${row}`}
                    className="flex h-9 items-center justify-center rounded-sm border border-border/40 text-[10px] font-medium text-foreground"
                    style={{ backgroundColor: a > 0 ? token(base, a) : 'hsl(var(--muted) / 0.2)' }}
                    title={`${cell.technique}${cell.name ? ` · ${cell.name}` : ''}: ${cell.value}`}
                  >
                    <span className="truncate px-1">{cell.technique}</span>
                  </div>
                );
              }),
            )}
          </div>
        </div>

        {/* Legend */}
        <div className="mt-3 flex items-center gap-2 text-[10px] text-muted-foreground">
          <span>Low</span>
          {[0.18, 0.38, 0.59, 0.79, 1].map((a) => (
            <span key={a} className="h-3 w-5 rounded-sm border border-border/40" style={{ backgroundColor: token(base, a) }} aria-hidden />
          ))}
          <span>High</span>
          <span className="ml-auto">max {dataMax.toLocaleString()}</span>
        </div>

        {/* Accessible data-table fallback (visually hidden, screen-reader source). */}
        <table className="sr-only">
          <caption>{label}</caption>
          <thead>
            <tr>
              <th scope="col">Technique</th>
              {cols.map((c) => (
                <th key={c.tactic} scope="col">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: maxRows }).map((_, row) => (
              <tr key={row}>
                <th scope="row">{cols.find((c) => c.cells[row])?.cells[row]?.technique ?? ''}</th>
                {cols.map((c) => (
                  <td key={c.tactic}>{c.cells[row] ? c.cells[row].value : ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  },
);
MitreHeatmap.displayName = 'MitreHeatmap';

/* ========================================================================= */
/* BurnDownChart                                                             */
/* ========================================================================= */

export interface BurnDownPoint {
  /** X label (e.g. a date string). Plain text. */
  x: string;
  /** Open (or backlog) count at this point. */
  open: number;
  /** Closed/resolved count at this point. */
  closed: number;
}

export interface BurnDownChartProps {
  data: BurnDownPoint[];
  height?: number;
  format?: (v: number) => string;
  /** Series labels (for the legend + tooltip). */
  openLabel?: string;
  closedLabel?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Open-vs-closed burn-down: a stacked gradient area of the open backlog with a
 * solid closed line, over time. Tracks the theme (info=open, success=closed).
 */
export const BurnDownChart = React.forwardRef<HTMLDivElement, BurnDownChartProps>(
  ({ data, height = 240, format, openLabel = 'Open', closedLabel = 'Closed', ariaLabel, className }, ref) => {
    const rows = data ?? [];
    const gid = React.useId().replace(/:/g, '');
    const openColor = token('info');
    const closedColor = token('success');
    const label = ariaLabel ?? `Burn-down of open vs closed over ${rows.length} point(s)`;

    if (rows.length === 0) {
      return (
        <div
          ref={ref}
          role="img"
          aria-label={`${label} (no data)`}
          className={cn('flex items-center justify-center text-sm text-muted-foreground', className)}
          style={{ height }}
        >
          No data
        </div>
      );
    }

    return (
      <div ref={ref} role="img" aria-label={label} className={className} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`bd-open-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={openColor} stopOpacity={0.32} />
                <stop offset="100%" stopColor={openColor} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="x" tickLine={false} axisLine={false} tick={AXIS_TICK} minTickGap={24} />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
              width={40}
              tickFormatter={(v) => (format ? format(Number(v)) : String(v))}
            />
            <Tooltip content={<SocTooltip format={format} />} cursor={{ stroke: openColor, strokeOpacity: 0.3 }} />
            <Legend wrapperStyle={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }} />
            <Area
              type="monotone"
              dataKey="open"
              name={openLabel}
              stroke={openColor}
              strokeWidth={2}
              fill={`url(#bd-open-${gid})`}
              isAnimationActive={false}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="closed"
              name={closedLabel}
              stroke={closedColor}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
BurnDownChart.displayName = 'BurnDownChart';

/* ========================================================================= */
/* AreaSpark — gradient-area sparkline (thin stroke, no axes/tooltip).        */
/* ========================================================================= */

export interface AreaSparkProps {
  /** Bare numeric series. */
  data: number[];
  height?: number;
  /** Colour token name (default 'primary'). */
  colorToken?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * A compact gradient-filled area spark — like `Sparkline` but with a stronger
 * gradient floor and a thinner stroke, for inline KPI context. No axes/tooltip.
 */
export const AreaSpark = React.forwardRef<HTMLDivElement, AreaSparkProps>(
  ({ data, height = 44, colorToken = 'primary', ariaLabel, className }, ref) => {
    const rows = (data ?? []).map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 }));
    const color = token(colorToken);
    const gid = React.useId().replace(/:/g, '');
    const label = ariaLabel ?? `Area sparkline of ${rows.length} value(s)`;

    if (rows.length === 0) {
      return <div ref={ref} role="img" aria-label={`${label} (no data)`} className={className} style={{ height }} />;
    }

    return (
      <div ref={ref} role="img" aria-label={label} className={className} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`aspark-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                <stop offset="100%" stopColor={color} stopOpacity={0.04} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="v"
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#aspark-${gid})`}
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
AreaSpark.displayName = 'AreaSpark';

/* ========================================================================= */
/* MultiSeriesTrend — several labelled series over time with a legend.        */
/* ========================================================================= */

export interface MultiSeries {
  /** Series key — must match the data-row property holding this series' value. */
  key: string;
  /** Plain-text legend label. */
  label: string;
  /** Optional explicit colour string; else a semantic/categorical colour. */
  color?: string;
}

export interface MultiSeriesTrendProps {
  /** Rows of `{ x, [seriesKey]: number, ... }`. */
  data: Array<Record<string, string | number>>;
  series: MultiSeries[];
  /** Property name for the X axis category (default 'x'). */
  xKey?: string;
  height?: number;
  format?: (v: number) => string;
  showXAxis?: boolean;
  showYAxis?: boolean;
  ariaLabel?: string;
  className?: string;
}

/** Resolve a series colour: explicit → semantic(by label) → categorical(by index). */
function seriesColor(s: MultiSeries, i: number): string {
  if (s.color) return s.color;
  const sem = semanticColor(s.label, i);
  return sem || categorical(i);
}

/**
 * Multi-series line trend with a legend. Each series is a token-coloured line; the
 * legend + tooltip carry plain-text labels. Suitable for verdict mix / per-source
 * volume / cost-by-model over time.
 */
export const MultiSeriesTrend = React.forwardRef<HTMLDivElement, MultiSeriesTrendProps>(
  (
    { data, series, xKey = 'x', height = 240, format, showXAxis = true, showYAxis = true, ariaLabel, className },
    ref,
  ) => {
    const rows = data ?? [];
    const list = series ?? [];
    const label = ariaLabel ?? `Trend of ${list.length} series over ${rows.length} point(s)`;

    if (rows.length === 0 || list.length === 0) {
      return (
        <div
          ref={ref}
          role="img"
          aria-label={`${label} (no data)`}
          className={cn('flex items-center justify-center text-sm text-muted-foreground', className)}
          style={{ height }}
        >
          No data
        </div>
      );
    }

    return (
      <div ref={ref} role="img" aria-label={label} className={className} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
            {showXAxis ? (
              <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={AXIS_TICK} minTickGap={24} />
            ) : (
              <XAxis dataKey={xKey} hide />
            )}
            {showYAxis ? (
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={AXIS_TICK}
                width={40}
                tickFormatter={(v) => (format ? format(Number(v)) : String(v))}
              />
            ) : (
              <YAxis hide />
            )}
            <Tooltip content={<SocTooltip format={format} />} cursor={{ stroke: 'hsl(var(--muted-foreground))', strokeOpacity: 0.25 }} />
            <Legend wrapperStyle={{ fontSize: 11, color: 'hsl(var(--muted-foreground))' }} />
            {list.map((s, i) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={seriesColor(s, i)}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
MultiSeriesTrend.displayName = 'MultiSeriesTrend';
