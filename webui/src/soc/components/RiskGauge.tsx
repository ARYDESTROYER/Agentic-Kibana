import * as React from 'react';
import { cn } from '@/lib/cn';

export interface RiskGaugeProps {
  /** Risk score 0-100 (clamped). */
  score: number;
  /** Optional label under the value (plain text). */
  label?: string;
  /** Optional pixel size of the gauge (width). Defaults to 200. */
  size?: number;
  className?: string;
}

/**
 * Point on a circle for the gauge sweep.
 *
 * The track runs along the TOP semicircle: 180° = left baseline, 90° = top,
 * 0° = right baseline. SVG's y axis points down, so we subtract the sine term to
 * lift the arc above the baseline.
 */
function point(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

/**
 * Top-sweeping semicircle arc path from `fromDeg` to `toDeg`.
 *
 * `sweep-flag 0` draws counter-clockwise in SVG screen space (i.e. over the top).
 * The total span never exceeds 180° here, so `large-arc-flag` is always 0.
 * Coordinates are rounded to 3dp so the path string is deterministic + NaN-free
 * for finite inputs (the caller clamps `score` before deriving the angles).
 */
function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number) {
  const a = point(cx, cy, r, fromDeg);
  const b = point(cx, cy, r, toDeg);
  return [
    'M',
    a.x.toFixed(3),
    a.y.toFixed(3),
    'A',
    r.toFixed(3),
    r.toFixed(3),
    0,
    0,
    0,
    b.x.toFixed(3),
    b.y.toFixed(3),
  ].join(' ');
}

/** Severity band for a clamped 0-100 score (matches RiskBadge / Overview bands). */
function bandOf(score: number): 'critical' | 'high' | 'medium' | 'low' {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 33) return 'medium';
  return 'low';
}

/** Drives BOTH `currentColor` (gradient stops) and the value text per band. */
const TEXT_CLASS: Record<ReturnType<typeof bandOf>, string> = {
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
};

/**
 * Crisp half-circle risk gauge.
 *
 * A thin muted track sits under a thicker, severity-coloured progress arc that
 * fills left→right as the score grows; the score is centred in the bowl. The arc
 * geometry is clipped to the bowl so the rounded stroke caps can never bleed
 * below the baseline (the source of the old "blob / triangle" artifacts), and the
 * progress arc only renders once it is long enough to read as a stroke rather than
 * a stray dot. Severity colour comes from the semantic tokens (low / medium / high
 * / critical), so both themes are correct. No needle, no overlap, no stray caps.
 */
export const RiskGauge = React.forwardRef<HTMLDivElement, RiskGaugeProps>(
  ({ score, label, size = 200, className }, ref) => {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
    const w = size;
    const stroke = Math.max(8, Math.round(size * 0.06));
    const pad = Math.max(2, Math.round(stroke / 2));
    const cx = w / 2;
    const r = w / 2 - stroke / 2 - pad;
    const cy = stroke / 2 + pad + r; // baseline sits at the bottom of the arc
    // Clip a hair below the baseline so rounded caps tuck cleanly to the edge
    // without protruding underneath it.
    const h = cy + Math.ceil(stroke / 2) + pad;

    const frac = clamped / 100;
    const endDeg = 180 - frac * 180; // sweep left→right as score grows

    const band = bandOf(clamped);
    const uid = React.useId().replace(/:/g, '');
    const clipId = `gauge-clip-${uid}`;
    const gradId = `gauge-grad-${uid}`;
    const titleId = `gauge-title-${uid}`;

    // Only draw the progress arc once it is long enough that a rounded cap reads
    // as a stroke end rather than a free-floating dot.
    const showProgress = frac > 0.015;

    return (
      <div ref={ref} className={cn('flex flex-col items-center', className)}>
        <div className="relative" style={{ width: w, height: h }}>
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            role="img"
            aria-labelledby={titleId}
          >
            <title id={titleId}>
              {label ? `${label}: ` : 'Risk '}
              {Math.round(clamped)} of 100
            </title>
            <defs>
              {/* Subtle left→right wash on the progress arc for depth. */}
              <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="currentColor" stopOpacity={0.55} />
                <stop offset="100%" stopColor="currentColor" stopOpacity={1} />
              </linearGradient>
              {/* Clip to the bowl + baseline so no cap bleeds below the line. */}
              <clipPath id={clipId}>
                <rect x={0} y={0} width={w} height={cy} />
              </clipPath>
            </defs>

            <g clipPath={`url(#${clipId})`}>
              {/* Muted track — the full semicircle. */}
              <path
                d={arcPath(cx, cy, r, 180, 0)}
                fill="none"
                className="stroke-muted"
                strokeWidth={stroke}
                strokeLinecap="round"
              />
              {/* Severity-coloured progress. The band `text-*` class sets
                  `currentColor`, which the gradient stops consume; the gradient
                  is the actual stroke (a subtle left→right wash). */}
              {showProgress ? (
                <path
                  d={arcPath(cx, cy, r, 180, endDeg)}
                  fill="none"
                  stroke={`url(#${gradId})`}
                  className={TEXT_CLASS[band]}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                />
              ) : null}
            </g>
          </svg>

          {/* Centred value overlay — sits in the bowl, clear of the arc. */}
          <div
            className="pointer-events-none absolute inset-x-0 flex flex-col items-center"
            style={{ top: cy - r * 0.5 }}
          >
            <span
              className={cn('font-semibold leading-none tracking-tight tabular-nums', TEXT_CLASS[band])}
              style={{ fontSize: size * 0.24 }}
            >
              {Math.round(clamped)}
            </span>
            <span
              className="mt-1 font-medium uppercase tracking-wider text-muted-foreground"
              style={{ fontSize: Math.max(9, size * 0.055) }}
            >
              / 100
            </span>
          </div>
        </div>
        {label ? (
          <div className="mt-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
        ) : null}
      </div>
    );
  },
);
RiskGauge.displayName = 'RiskGauge';

export default RiskGauge;
