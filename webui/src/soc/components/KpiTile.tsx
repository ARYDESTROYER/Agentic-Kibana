import * as React from 'react';
import { cn } from '@/lib/cn';
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from 'lucide-react';

export type KpiAccent =
  | 'primary'
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info'
  | 'success';

/**
 * Which direction of change is GOOD for this metric.
 *  - `'up'`   (default): higher-is-better (e.g. agreement rate, coverage).
 *  - `'down'`: lower-is-better (e.g. MTTA/MTTR/dwell, open alerts, FP rate).
 *  - `'none'`: neutral — color the delta muted, no judgement implied.
 */
export type KpiGoodDirection = 'up' | 'down' | 'none';

export interface KpiDelta {
  /** Signed delta value; the SIGN drives the arrow (true direction of change). */
  value: number;
  /** Optional pre-formatted label (e.g. "+12%"); falls back to |value|. */
  label?: string;
}

export interface KpiTileProps {
  /** Metric label (plain text). */
  label: string;
  /** Metric value — string or number (plain text). */
  value: React.ReactNode;
  /** Optional sub-line under the value (plain text). */
  sub?: string;
  /** Optional leading icon. */
  icon?: LucideIcon;
  /** Colored accent — a soft icon chip (default variant) or the left bar (`bar`). */
  accent?: KpiAccent;
  /** Optional trend delta shown next to the value. */
  delta?: KpiDelta;
  /**
   * Which direction of change counts as an improvement. COLOR encodes the
   * judgement (improved → success, regressed → critical); the ARROW always shows
   * the true direction of change and is never flipped. Defaults to `'up'` so no
   * existing call site regresses (the call-site sweep is the Codemod wave).
   */
  goodDirection?: KpiGoodDirection;
  /**
   * `'default'` — soft tinted icon chip carrying the accent (KPI strip tiles).
   * `'bar'`     — a slim colored LEFT accent bar (absorbs the former `StatCard`,
   *               used for MTTD/MTTA/MTTR-style timing metrics).
   */
  variant?: 'default' | 'bar';
  /** When provided the tile becomes a keyboard-accessible button. */
  onClick?: () => void;
  /**
   * Stable id for the `data-testid="kpi-<id>"` anchor. When omitted it is derived
   * from the label (slugified), so every tile is test-addressable without churn.
   */
  testId?: string;
  className?: string;
}

/** Slugify a label into a stable, lowercase, dash-joined id for test anchors. */
function slugId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Soft tinted chip behind the icon — the only place accent color appears (default variant). */
const ACCENT_CHIP: Record<KpiAccent, string> = {
  primary: 'bg-primary/10 text-primary',
  critical: 'bg-critical/10 text-critical',
  high: 'bg-high/10 text-high',
  medium: 'bg-medium/10 text-medium',
  low: 'bg-low/10 text-low',
  info: 'bg-info/10 text-info',
  success: 'bg-success/10 text-success',
};

/** Slim left accent bar — used by the `bar` variant. */
const ACCENT_BAR: Record<KpiAccent, string> = {
  primary: 'bg-primary',
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
  success: 'bg-success',
};

/**
 * Resolve the delta into its visual + accessible facts.
 *
 * BUG #2 FIX (DESIGN_STANDARD §5.3): color = judgement (did the metric improve?),
 * arrow = true direction of change (never flipped). "Open alerts +30%" must read
 * as a REGRESSION (critical + up arrow), not green just because the sign is +.
 */
function resolveDelta(delta: KpiDelta, goodDirection: KpiGoodDirection) {
  const rising = delta.value >= 0;
  // A zero / no-change delta (incl. the "new" badge that carries value 0) is NEUTRAL —
  // never an improvement OR a regression (DESIGN_STANDARD §5.3). Only a real move is
  // judged, so a fresh appearance of a bad metric can't render as a green "improved".
  const flat = delta.value === 0;
  const improved =
    flat || goodDirection === 'none'
      ? null
      : goodDirection === 'up'
        ? rising
        : /* 'down' */ !rising;

  // Use the AA-tuned standalone `-text` companions: the fill tokens (`text-success` /
  // `text-critical`) fail 4.5:1 as small text on the card in the light theme
  // (DESIGN_STANDARD §1.3, matching badges.tsx), so this 12px delta must use `-text`.
  const colorClass =
    improved === null
      ? 'text-muted-foreground'
      : improved
        ? 'text-success-text'
        : 'text-critical-text';

  const Arrow = rising ? ArrowUpRight : ArrowDownRight;
  const directionWord = rising ? 'up' : 'down';
  // a11y: announce BOTH the direction and the judgement (never color-only).
  const judgement = improved === null ? '' : improved ? ', improved' : ', worse';
  const ariaLabel = `changed ${directionWord} by ${delta.label ?? Math.abs(delta.value)}${judgement}`;

  return { colorClass, Arrow, ariaLabel };
}

/**
 * AdSense-clean KPI tile: muted small-caps label, a big tabular value, and a soft
 * tinted icon chip (or a left accent bar in `variant='bar'`) carrying the only
 * accent color. Border-first (hairline border, no resting shadow); a static card,
 * or — when `onClick` is set — a keyboard-accessible button with focus ring + calm
 * hover. Token-themed. All text plain (UNTRUSTED-safe, #9).
 */
export const KpiTile = React.forwardRef<HTMLElement, KpiTileProps>(
  (
    {
      label,
      value,
      sub,
      icon: Icon,
      accent = 'primary',
      delta,
      goodDirection = 'up',
      variant = 'default',
      onClick,
      testId,
      className,
    },
    ref,
  ) => {
    const clickable = typeof onClick === 'function';
    const kpiTestId = `kpi-${testId ?? slugId(label)}`;
    const bar = variant === 'bar';

    const deltaFacts = delta ? resolveDelta(delta, goodDirection) : null;

    const deltaNode = deltaFacts ? (
      <span
        // `role="img"` makes `aria-label` a valid accessible name on this element (a
        // bare span maps to the generic role, where aria-label is prohibited/ignored —
        // axe `aria-prohibited-attr`). With the visible value aria-hidden, this is the
        // ONLY reliable announcement of the trend direction + judgement (Round-5 §6.1).
        role="img"
        className={cn(
          'mb-0.5 inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums',
          deltaFacts.colorClass,
        )}
        aria-label={deltaFacts.ariaLabel}
      >
        <deltaFacts.Arrow className="h-3.5 w-3.5" aria-hidden />
        <span aria-hidden>{delta!.label ?? Math.abs(delta!.value)}</span>
      </span>
    ) : null;

    const inner = (
      <>
        <div className="flex items-start justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {Icon && !bar ? (
            <span
              className={cn(
                'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                ACCENT_CHIP[accent],
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </span>
          ) : Icon && bar ? (
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          ) : null}
        </div>
        <div className="mt-3 flex items-end gap-2">
          <span className="text-3xl font-semibold leading-none tracking-tight tabular-nums text-foreground">
            {value}
          </span>
          {deltaNode}
        </div>
        {sub ? <span className="mt-2 block text-xs text-muted-foreground">{sub}</span> : null}
      </>
    );

    const base = cn(
      'relative h-full overflow-hidden rounded-lg border border-border bg-card p-4 text-left',
      bar && 'pl-5',
    );

    const barEdge = bar ? (
      <span className={cn('absolute inset-y-0 left-0 w-0.5', ACCENT_BAR[accent])} aria-hidden />
    ) : null;

    if (clickable) {
      return (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          onClick={onClick}
          data-testid={kpiTestId}
          className={cn(
            base,
            'block w-full transition-colors hover:border-primary/40 hover:bg-accent/30',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className,
          )}
        >
          {barEdge}
          {inner}
        </button>
      );
    }

    return (
      <div ref={ref as React.Ref<HTMLDivElement>} data-testid={kpiTestId} className={cn(base, className)}>
        {barEdge}
        {inner}
      </div>
    );
  },
);
KpiTile.displayName = 'KpiTile';

export default KpiTile;
