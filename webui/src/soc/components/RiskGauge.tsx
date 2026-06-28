import * as React from 'react';
import { cn } from '@/lib/cn';

export interface RiskGaugeProps {
  /** Risk score 0-100 (clamped). */
  score: number;
  /** Optional label under the value (plain text). */
  label?: string;
  /** Optional pixel size of the gauge (square-ish). Defaults to 200. */
  size?: number;
  className?: string;
}

const TAU = Math.PI;

/** Polar→cartesian on the gauge arc. angle in radians, 0 = left, PI = right. */
function point(cx: number, cy: number, r: number, angle: number) {
  // Semicircle sweeping from left (180deg) over the top to right (0deg).
  const a = TAU - angle; // map 0..PI fraction onto the top half
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number) {
  const start = point(cx, cy, r, from);
  const end = point(cx, cy, r, to);
  const large = to - from > TAU ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

/**
 * Half-circle arc risk gauge, green→amber→red, with the score in the center and
 * a pointer needle. Hand-built SVG so the color band tracks severity precisely.
 * Colors come from semantic tokens (low/medium/high/critical) so both themes work.
 */
export const RiskGauge = React.forwardRef<HTMLDivElement, RiskGaugeProps>(
  ({ score, label, size = 200, className }, ref) => {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
    const w = size;
    const h = size * 0.62;
    const stroke = Math.max(10, size * 0.075);
    const cx = w / 2;
    const cy = h - stroke / 2 - 2;
    const r = w / 2 - stroke / 2 - 2;

    // Three colored bands across the semicircle (0..PI).
    const bands: { from: number; to: number; cls: string }[] = [
      { from: 0, to: TAU / 3, cls: 'stroke-low' },
      { from: TAU / 3, to: (2 * TAU) / 3, cls: 'stroke-medium' },
      { from: (2 * TAU) / 3, to: TAU, cls: 'stroke-high' },
    ];

    // Needle angle for the score.
    const frac = clamped / 100;
    const needle = point(cx, cy, r - stroke / 2 - 2, frac * TAU);

    // Value color by severity band.
    const valueCls =
      clamped >= 80
        ? 'text-critical'
        : clamped >= 66
          ? 'text-high'
          : clamped >= 33
            ? 'text-medium'
            : 'text-low';

    const gaugeId = React.useId();

    return (
      <div
        ref={ref}
        className={cn('flex flex-col items-center', className)}
      >
        <div className="relative" style={{ width: w, height: h }}>
          <svg
            width={w}
            height={h}
            viewBox={`0 0 ${w} ${h}`}
            role="img"
            aria-labelledby={gaugeId}
          >
            <title id={gaugeId}>
              {label ? `${label}: ` : 'Risk '}
              {Math.round(clamped)} of 100
            </title>
            {/* Track */}
            <path
              d={arcPath(cx, cy, r, 0, TAU)}
              fill="none"
              className="stroke-muted"
              strokeWidth={stroke}
              strokeLinecap="round"
              opacity={0.5}
            />
            {/* Colored bands */}
            {bands.map((b, i) => (
              <path
                key={i}
                d={arcPath(cx, cy, r, b.from, b.to)}
                fill="none"
                className={b.cls}
                strokeWidth={stroke}
                strokeLinecap="butt"
              />
            ))}
            {/* Needle */}
            <line
              x1={cx}
              y1={cy}
              x2={needle.x}
              y2={needle.y}
              className="stroke-foreground"
              strokeWidth={Math.max(2, size * 0.014)}
              strokeLinecap="round"
            />
            <circle
              cx={cx}
              cy={cy}
              r={Math.max(4, size * 0.03)}
              className="fill-foreground"
            />
          </svg>
          {/* Centered value overlay */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col items-center">
            <span className={cn('text-4xl font-bold leading-none tracking-tight', valueCls)}>
              {Math.round(clamped)}
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
