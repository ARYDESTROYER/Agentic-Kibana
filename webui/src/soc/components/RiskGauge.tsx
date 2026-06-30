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
 * Severity band for a clamped 0-100 score (matches RiskBadge / Overview bands).
 * The gauge is 4-band by design: it intentionally collapses the canonical info
 * (<15) band into low, so its single non-canonical boundary is medium >= 35.
 */
function bandOf(score: number): 'critical' | 'high' | 'medium' | 'low' {
  if (score >= 80) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

/**
 * Per-band semantic tokens, written as LITERAL class strings so the Tailwind JIT
 * emits them. `text-*` sets `color` (→ `currentColor`, consumed by the progress
 * arc's `stroke="currentColor"`) and `stroke-*` is a belt-and-braces fallback so
 * the arc is coloured even if `currentColor` resolution is ever bypassed.
 *
 * These are passed LAST to `cn()` at the call sites so tailwind-merge keeps them.
 */
const TEXT_CLASS: Record<ReturnType<typeof bandOf>, string> = {
  critical: 'text-critical stroke-critical',
  high: 'text-high stroke-high',
  medium: 'text-medium stroke-medium',
  low: 'text-low stroke-low',
};

/**
 * Crisp half-circle risk gauge.
 *
 * The arc is a single fixed half-circle path drawn TWICE: a muted full-length
 * track and, on top, a severity-coloured progress stroke revealed left→right via
 * `stroke-dasharray` / `stroke-dashoffset`. This avoids per-score arc geometry
 * (no floating-point endpoint math, so the path is always finite) and avoids the
 * earlier defects entirely:
 *
 *  - Colour: the progress stroke is `currentColor` on the SAME element that
 *    carries the band `text-*` class — no `<defs>` gradient whose stops resolved
 *    `currentColor` against the document foreground (the old near-white sliver).
 *  - Caps: the rounded start cap rides the coloured arc (never a bare baseline),
 *    so it can't read as a stray dark half-disc / blob.
 *  - Layout: the value overlay is a height-bounded flex container inside the bowl,
 *    with the score and `/100` on ONE line, so it never overflows into the
 *    external label below the svg.
 */
export const RiskGauge = React.forwardRef<HTMLDivElement, RiskGaugeProps>(
  ({ score, label, size = 200, className }, ref) => {
    const clamped = Math.max(0, Math.min(100, Number.isFinite(score) ? score : 0));
    const w = size;
    const stroke = Math.max(8, Math.round(size * 0.07));
    const pad = Math.max(2, Math.round(stroke / 2));
    const cx = w / 2;
    const r = w / 2 - stroke / 2 - pad;
    const cy = stroke / 2 + pad + r; // baseline sits at the bottom of the arc
    // Height bounds the rounded caps that ride the baseline.
    const h = cy + Math.ceil(stroke / 2) + pad;

    // One fixed half-circle (left baseline → over the top → right baseline),
    // rounded to 3dp so the string is deterministic + NaN-free for finite inputs.
    const d = `M ${(cx - r).toFixed(3)} ${cy.toFixed(3)} A ${r.toFixed(3)} ${r.toFixed(
      3,
    )} 0 0 1 ${(cx + r).toFixed(3)} ${cy.toFixed(3)}`;
    const len = Math.PI * r;
    const dashOffset = (1 - clamped / 100) * len;

    const band = bandOf(clamped);
    const titleId = `gauge-title-${React.useId().replace(/:/g, '')}`;

    // Value font caps to the bowl so it never collides with the external label.
    const valueFont = Math.min(size * 0.22, cy * 0.5);
    const suffixFont = Math.max(9, valueFont * 0.42);

    return (
      <div ref={ref} className={cn('flex flex-col items-center', className)}>
        <div className="relative" style={{ width: w, height: h }}>
          <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-labelledby={titleId}>
            <title id={titleId}>
              {label ? `${label}: ` : 'Risk '}
              {Math.round(clamped)} of 100
            </title>
            {/* Muted track — the full semicircle. */}
            <path d={d} fill="none" className="stroke-muted" strokeWidth={stroke} strokeLinecap="round" />
            {/* Severity-coloured progress, revealed left→right by the dash offset.
                `stroke="currentColor"` resolves against the band `text-*` class on
                THIS element (kept last in cn() so tailwind-merge keeps it). */}
            <path
              d={d}
              fill="none"
              stroke="currentColor"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={len}
              strokeDashoffset={dashOffset}
              className={cn('transition-[stroke-dashoffset] duration-500', TEXT_CLASS[band])}
            />
          </svg>

          {/* Centred value overlay — height-bounded to the bowl, single line. */}
          <div
            className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end"
            style={{ height: cy, paddingBottom: pad }}
          >
            <div className="flex items-baseline">
              <span
                className={cn('font-semibold leading-none tracking-tight tabular-nums', TEXT_CLASS[band])}
                style={{ fontSize: valueFont }}
              >
                {Math.round(clamped)}
              </span>
              <span
                className="ml-1 font-medium uppercase tracking-wider text-muted-foreground"
                style={{ fontSize: suffixFont }}
              >
                /100
              </span>
            </div>
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
