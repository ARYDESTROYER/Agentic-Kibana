/**
 * Theme-aware recharts wrappers for the SOC console.
 *
 * Every chart pulls its colors from `palette.ts` (which resolves the live CSS
 * design tokens), so they track the active light / dark "command center" theme
 * with NO hardcoded hex. Each exported chart carries an accessible name
 * (`role="img"` + `aria-label`, with an `<title>` where it renders custom SVG) so
 * screen readers get a meaningful summary instead of a soup of paths.
 *
 * recharts ResponsiveContainer needs a sized parent; pass `className`/`height`.
 * UNTRUSTED data note: these render numeric values + caller-supplied labels.
 * Labels are placed as plain SVG `<text>` / recharts category strings (never HTML),
 * so attacker-influenced label strings cannot inject markup.
 */
import * as React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/lib/cn';
import { categorical, semanticIcon, token } from './palette';

/* ------------------------------------------------------------------------- */
/* Beside-color glyph (WCAG 1.4.1, §6.1) — a recharts swatch is color-only. When
/* a segment/series NAME maps to a semantic key (verdict/severity/status), show the
/* SEMANTIC_ICON shape beside the swatch so the reading survives CVD/monochrome.
/* Decorative (`aria-hidden`) — the plain-text label carries the meaning (#9).      */
/* ------------------------------------------------------------------------- */

function SeriesGlyph({ name, className }: { name?: string; className?: string }) {
  const Icon = semanticIcon(name);
  if (!Icon) return null;
  return <Icon className={cn('size-3 shrink-0', className)} aria-hidden />;
}

/* ------------------------------------------------------------------------- */
/* Shared tooltip — token-themed, plain-text labels.                         */
/* ------------------------------------------------------------------------- */

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number | string; color?: string; payload?: any }>;
  label?: string | number;
  /** Optional value formatter. */
  format?: (v: number) => string;
  /** Hide the axis label row (e.g. donut). */
  hideLabel?: boolean;
}

function ChartTooltip({ active, payload, label, format, hideLabel }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const fmt = (v: number | string | undefined) => {
    if (typeof v === 'number') return format ? format(v) : v.toLocaleString();
    return v ?? '';
  };
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-elev2">
      {!hideLabel && label != null ? (
        <div className="mb-1 font-medium text-foreground">{String(label)}</div>
      ) : null}
      <ul className="flex flex-col gap-1">
        {payload.map((p, i) => (
          <li key={i} className="flex items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              // A Bar colored only via per-<Cell> fill leaves p.color undefined (recharts
              // reads the Bar's own fill), so fall back to the datum's resolved color.
              style={{ background: p.color ?? p.payload?.color ?? p.payload?.fill }}
              aria-hidden
            />
            <SeriesGlyph name={p.name} className="text-muted-foreground" />
            <span className="text-muted-foreground">{p.name}</span>
            <span className="ml-auto font-mono font-semibold tabular-nums text-foreground">
              {fmt(p.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const AXIS_TICK = { fill: 'hsl(var(--muted-foreground))', fontSize: 11 } as const;

/* ------------------------------------------------------------------------- */
/* DonutChart                                                                 */
/* ------------------------------------------------------------------------- */

export interface DonutSegment {
  /** Plain-text label (UNTRUSTED-safe — rendered as SVG text / tooltip text). */
  label: string;
  value: number;
  /** Optional explicit color string (else categorical or semantic via caller). */
  color?: string;
}

export interface DonutChartProps {
  segments: DonutSegment[];
  /** Center overlay node (e.g. total). Rendered absolutely over the ring. */
  center?: React.ReactNode;
  /** Pixel height (and the square-ish width via ResponsiveContainer). */
  height?: number;
  /** Ring thickness as a fraction; inner radius = outer * (1 - thickness). */
  thickness?: number;
  /** Optional value formatter for the tooltip. */
  format?: (v: number) => string;
  /** Whether hovering a segment opens the chart tooltip (default true). */
  showTooltip?: boolean;
  /** Accessible chart name. */
  ariaLabel?: string;
  className?: string;
}

/** Donut / ring chart with optional centered overlay. */
export const DonutChart = React.forwardRef<HTMLDivElement, DonutChartProps>(
  (
    {
      segments,
      center,
      height = 200,
      thickness = 0.38,
      format,
      showTooltip = true,
      ariaLabel,
      className,
    },
    ref,
  ) => {
    const data = (segments ?? []).filter((s) => (s.value || 0) > 0);
    const total = data.reduce((a, s) => a + (s.value || 0), 0);
    const label =
      ariaLabel ??
      `Distribution chart with ${data.length} segment(s)` +
        (total ? `, total ${total.toLocaleString()}` : '');

    if (data.length === 0) {
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

    // Hole size as a % of the chart box's smaller dimension — the SINGLE source of
    // truth reused for the Pie's `innerRadius` AND the center overlay bound below, so
    // oversized center content is clipped to the actual hole and never bleeds onto the ring.
    const innerPct = Math.round((1 - thickness) * 70);
    // The donut hole is a CIRCLE whose diameter is `innerPct% * min(width, height)`. These
    // charts are height-constrained (the card fixes `height`; width is ≥ height), so the hole
    // ≈ `innerPct%` of the height IN PIXELS. The old overlay sized itself off the CONTAINER
    // WIDTH (`width: innerPct%`), which is far wider than the hole in a wide/stacked layout —
    // so a long center caption (e.g. "RESOLVED") bled onto the ring. A px square pinned to the
    // height keeps the overlay matched to the actual hole at any container aspect ratio.
    const holePx = Math.max(0, Math.round((innerPct / 100) * height));

    return (
      <div
        ref={ref}
        role="img"
        aria-label={label}
        className={cn('relative', className)}
        style={{ height }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={`${innerPct}%`}
              outerRadius="70%"
              paddingAngle={data.length > 1 ? 2 : 0}
              stroke="hsl(var(--card))"
              strokeWidth={2}
              isAnimationActive={false}
            >
              {data.map((s, i) => (
                <Cell
                  key={i}
                  fill={s.color ?? categorical(i)}
                  aria-label={`${s.label}: ${format ? format(s.value) : s.value.toLocaleString()}`}
                />
              ))}
            </Pie>
            {showTooltip ? (
              <Tooltip content={<ChartTooltip format={format} hideLabel />} cursor={false} />
            ) : null}
          </PieChart>
        </ResponsiveContainer>
        {center != null ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div
              className="flex max-h-full max-w-full flex-col items-center justify-center gap-0.5 overflow-hidden text-center"
              // Bound the overlay to the ACTUAL circular hole (a px square pinned to the
              // height — see `holePx`), so oversized/long center content is clipped instead of
              // bleeding onto the coloured ring, at any container aspect ratio.
              style={{ width: holePx, height: holePx }}
            >
              {center}
            </div>
          </div>
        ) : null}
      </div>
    );
  },
);
DonutChart.displayName = 'DonutChart';

/* ------------------------------------------------------------------------- */
/* HBarChart                                                                  */
/* ------------------------------------------------------------------------- */

export interface HBarDatum {
  /** Category label (UNTRUSTED-safe — plain SVG/category text). */
  label: string;
  value: number;
  color?: string;
}

export interface HBarChartProps {
  data: HBarDatum[];
  /** Pixel height; auto-grows to fit rows when omitted. */
  height?: number;
  /** Width reserved for the Y-axis labels. */
  labelWidth?: number;
  format?: (v: number) => string;
  /** Single bar color token name (e.g. 'primary') applied to all bars. */
  colorToken?: string;
  /** Tooltip series name for the value row (default 'Count') — else it reads "value". */
  valueLabel?: string;
  ariaLabel?: string;
  className?: string;
}

/** Horizontal bar chart (ranked categories). */
export const HBarChart = React.forwardRef<HTMLDivElement, HBarChartProps>(
  ({ data, height, labelWidth = 120, format, colorToken, valueLabel = 'Count', ariaLabel, className }, ref) => {
    const rows = data ?? [];
    const h = height ?? Math.max(120, rows.length * 34 + 16);
    const label =
      ariaLabel ?? `Horizontal bar chart with ${rows.length} categor${rows.length === 1 ? 'y' : 'ies'}`;
    const barFill = colorToken ? token(colorToken) : undefined;
    // Resolve each bar's color INTO the datum so the tooltip swatch can recover it
    // (the Bar itself has no `fill`; color lives only on the per-row <Cell>).
    const resolved = rows.map((d, i) => ({ ...d, color: d.color ?? barFill ?? categorical(i) }));

    if (rows.length === 0) {
      return (
        <div
          ref={ref}
          role="img"
          aria-label={`${label} (no data)`}
          className={cn('flex items-center justify-center text-sm text-muted-foreground', className)}
          style={{ height: h }}
        >
          No data
        </div>
      );
    }

    return (
      <div ref={ref} role="img" aria-label={label} className={className} style={{ height: h }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={resolved}
            layout="vertical"
            margin={{ top: 4, right: 12, bottom: 4, left: 4 }}
            barCategoryGap={8}
          >
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="label"
              width={labelWidth}
              tickLine={false}
              axisLine={false}
              tick={AXIS_TICK}
            />
            <Tooltip
              content={<ChartTooltip format={format} />}
              cursor={{ fill: 'hsl(var(--muted) / 0.4)' }}
            />
            <Bar dataKey="value" name={valueLabel} radius={[0, 4, 4, 0]} isAnimationActive={false}>
              {resolved.map((d, i) => (
                <Cell key={i} fill={d.color} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
HBarChart.displayName = 'HBarChart';

/* ------------------------------------------------------------------------- */
/* TrendArea                                                                  */
/* ------------------------------------------------------------------------- */

export interface TrendPoint {
  /** X label (category, e.g. a date string). UNTRUSTED-safe. */
  x: string;
  y: number;
}

export interface TrendAreaProps {
  data: TrendPoint[];
  height?: number;
  /** Color token name for the line/area fill (default 'primary'). */
  colorToken?: string;
  format?: (v: number) => string;
  /** Show the X axis (default true) and Y axis (default false). */
  showXAxis?: boolean;
  showYAxis?: boolean;
  ariaLabel?: string;
  className?: string;
}

/** Filled trend area chart (spend / volume over time). */
export const TrendArea = React.forwardRef<HTMLDivElement, TrendAreaProps>(
  (
    {
      data,
      height = 220,
      colorToken = 'primary',
      format,
      showXAxis = true,
      showYAxis = false,
      ariaLabel,
      className,
    },
    ref,
  ) => {
    const rows = data ?? [];
    const gid = React.useId().replace(/:/g, '');
    const color = token(colorToken);
    const label = ariaLabel ?? `Trend over ${rows.length} point(s)`;

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
              <linearGradient id={`trend-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            {showXAxis ? (
              <XAxis
                dataKey="x"
                tickLine={false}
                axisLine={false}
                tick={AXIS_TICK}
                minTickGap={24}
              />
            ) : (
              <XAxis dataKey="x" hide />
            )}
            {showYAxis ? (
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={AXIS_TICK}
                width={44}
                tickFormatter={(v) => (format ? format(Number(v)) : String(v))}
              />
            ) : (
              <YAxis hide />
            )}
            <Tooltip content={<ChartTooltip format={format} />} cursor={{ stroke: color, strokeOpacity: 0.4 }} />
            <Area
              type="monotone"
              dataKey="y"
              name="Value"
              stroke={color}
              strokeWidth={2}
              fill={`url(#trend-${gid})`}
              isAnimationActive={false}
              dot={false}
              activeDot={{ r: 3, fill: color, stroke: 'hsl(var(--card))', strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
TrendArea.displayName = 'TrendArea';

/* ------------------------------------------------------------------------- */
/* MiniBars — compact, axis-less vertical bars (inline KPI / cell context).  */
/* ------------------------------------------------------------------------- */

export interface MiniBarsProps {
  /** Bare numeric series (e.g. last N days). */
  data: number[];
  height?: number;
  /** Color token name (default 'primary'). */
  colorToken?: string;
  ariaLabel?: string;
  className?: string;
}

/** Tiny barchart with no axes/tooltip — context spark in cards & cells. */
export const MiniBars = React.forwardRef<HTMLDivElement, MiniBarsProps>(
  ({ data, height = 40, colorToken = 'primary', ariaLabel, className }, ref) => {
    const rows = (data ?? []).map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 }));
    const color = token(colorToken);
    const label = ariaLabel ?? `Mini bar series of ${rows.length} value(s)`;

    if (rows.length === 0) {
      return <div ref={ref} role="img" aria-label={`${label} (no data)`} className={className} style={{ height }} />;
    }

    return (
      <div ref={ref} role="img" aria-label={label} className={className} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }} barCategoryGap={1}>
            <XAxis dataKey="i" hide />
            <YAxis hide />
            <Bar dataKey="v" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
MiniBars.displayName = 'MiniBars';

/* ------------------------------------------------------------------------- */
/* Sparkline — compact, axis-less trend line (inline KPI deltas).            */
/* ------------------------------------------------------------------------- */

export interface SparklineProps {
  /** Bare numeric series. */
  data: number[];
  height?: number;
  /** Color token name (default 'primary'). */
  colorToken?: string;
  /** Fill the area under the line. */
  fill?: boolean;
  ariaLabel?: string;
  className?: string;
}

/** Tiny line/area sparkline with no axes/tooltip. */
export const Sparkline = React.forwardRef<HTMLDivElement, SparklineProps>(
  ({ data, height = 40, colorToken = 'primary', fill = true, ariaLabel, className }, ref) => {
    const rows = (data ?? []).map((v, i) => ({ i, v: Number.isFinite(v) ? v : 0 }));
    const color = token(colorToken);
    const gid = React.useId().replace(/:/g, '');
    const label = ariaLabel ?? `Sparkline of ${rows.length} value(s)`;

    if (rows.length === 0) {
      return <div ref={ref} role="img" aria-label={`${label} (no data)`} className={className} style={{ height }} />;
    }

    return (
      <div ref={ref} role="img" aria-label={label} className={className} style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={rows} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={fill ? 0.3 : 0} />
                <stop offset="100%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area
              type="monotone"
              dataKey="v"
              stroke={color}
              strokeWidth={1.75}
              fill={`url(#spark-${gid})`}
              isAnimationActive={false}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    );
  },
);
Sparkline.displayName = 'Sparkline';
