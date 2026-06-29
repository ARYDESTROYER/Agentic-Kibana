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

/** Point on a circle. Angle in degrees, 180°=left, 90°=top, 0°=right (SVG y-down). */
function point(cx: number, cy: number, r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}

/** Semicircle arc path from `fromDeg` to `toDeg` (sweeping over the top). */
function arc(cx: number, cy: number, r: number, fromDeg: number, toDeg: number) {
  const a = point(cx, cy, r, fromDeg);
  const b = point(cx, cy, r, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  // sweep-flag 0 = counter-clockwise in SVG screen space → over the top.
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 0 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

/**
 * Clean half-circle risk gauge: a muted track with a single severity-coloured
 * progress arc and the score centred in the bowl (no needle, no overlap). Colours
 * come from semantic tokens (low/medium/high/critical) so both themes work.
 */
export const RiskGauge = React.forwardRef<HTMLDivElement, RiskGaugeProps>(
  ({ score, label, size = 200, className }, ref) => {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
    const w = size;
    const stroke = Math.max(10, Math.round(size * 0.07));
    const pad = 4;
    const cx = w / 2;
    const r = w / 2 - stroke / 2 - pad;
    const cy = stroke / 2 + pad + r; // baseline sits at the bottom of the arc
    const h = cy + stroke / 2 + pad;

    const frac = clamped / 100;
    const endDeg = 180 - frac * 180; // sweep left→right as score grows

    const bandCls =
      clamped >= 80
        ? 'stroke-critical'
        : clamped >= 60
          ? 'stroke-high'
          : clamped >= 33
            ? 'stroke-medium'
            : 'stroke-low';
    const valueCls =
      clamped >= 80
        ? 'text-critical'
        : clamped >= 60
          ? 'text-high'
          : clamped >= 33
            ? 'text-medium'
            : 'text-low';

    const gaugeId = React.useId();

    return (
      <div ref={ref} className={cn('flex flex-col items-center', className)}>
        <div className="relative" style={{ width: w, height: h }}>
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={gaugeId}>
            <title id={gaugeId}>
              {label ? `${label}: ` : 'Risk '}
              {Math.round(clamped)} of 100
            </title>
            {/* Track */}
            <path
              d={arc(cx, cy, r, 180, 0)}
              fill="none"
              className="stroke-muted"
              strokeWidth={stroke}
              strokeLinecap="round"
            />
            {/* Severity-coloured progress */}
            {frac > 0 ? (
              <path
                d={arc(cx, cy, r, 180, endDeg)}
                fill="none"
                className={bandCls}
                strokeWidth={stroke}
                strokeLinecap="round"
              />
            ) : null}
          </svg>
          {/* Centred value overlay — sits in the bowl, clear of the arc. */}
          <div
            className="pointer-events-none absolute inset-x-0 flex flex-col items-center"
            style={{ top: cy - r * 0.52 }}
          >
            <span className={cn('font-bold leading-none tracking-tight', valueCls)} style={{ fontSize: size * 0.22 }}>
              {Math.round(clamped)}
            </span>
            <span className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
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
