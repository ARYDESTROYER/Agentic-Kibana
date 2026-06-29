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

export interface KpiDelta {
  /** Signed delta value; sign drives the up/down arrow + color. */
  value: number;
  /** Optional pre-formatted label (e.g. "+12%"); falls back to the number. */
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
  /** Colored top accent bar. Defaults to 'primary'. */
  accent?: KpiAccent;
  /** Optional trend delta shown next to the value. */
  delta?: KpiDelta;
  /** When provided the tile becomes a keyboard-accessible button. */
  onClick?: () => void;
  className?: string;
}

/** Soft tinted chip behind the icon — the only place accent color appears. */
const ACCENT_CHIP: Record<KpiAccent, string> = {
  primary: 'bg-primary/10 text-primary',
  critical: 'bg-critical/10 text-critical',
  high: 'bg-high/10 text-high',
  medium: 'bg-medium/10 text-medium',
  low: 'bg-low/10 text-low',
  info: 'bg-info/10 text-info',
  success: 'bg-success/10 text-success',
};

/**
 * AdSense-clean KPI tile: muted small-caps label, a big tabular value, and a soft
 * tinted icon chip carrying the only accent color. Border-first (hairline border,
 * no resting shadow); a static card, or — when `onClick` is set — a
 * keyboard-accessible button with focus ring + calm hover. Token-themed.
 */
export const KpiTile = React.forwardRef<HTMLElement, KpiTileProps>(
  ({ label, value, sub, icon: Icon, accent = 'primary', delta, onClick, className }, ref) => {
    const clickable = typeof onClick === 'function';

    const inner = (
      <>
        <div className="flex items-start justify-between gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
          {Icon ? (
            <span
              className={cn(
                'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                ACCENT_CHIP[accent],
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </span>
          ) : null}
        </div>
        <div className="mt-3 flex items-end gap-2">
          <span className="text-3xl font-semibold leading-none tracking-tight tabular-nums text-foreground">
            {value}
          </span>
          {delta ? (
            <span
              className={cn(
                'mb-0.5 inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums',
                delta.value >= 0 ? 'text-success' : 'text-critical',
              )}
            >
              {delta.value >= 0 ? (
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ArrowDownRight className="h-3.5 w-3.5" aria-hidden />
              )}
              {delta.label ?? Math.abs(delta.value)}
            </span>
          ) : null}
        </div>
        {sub ? <span className="mt-2 block text-xs text-muted-foreground">{sub}</span> : null}
      </>
    );

    const base =
      'relative h-full overflow-hidden rounded-lg border border-border bg-card p-5 text-left';

    if (clickable) {
      return (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          onClick={onClick}
          className={cn(
            base,
            'block w-full transition-colors hover:border-primary/40 hover:bg-accent/30',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            className,
          )}
        >
          {inner}
        </button>
      );
    }

    return (
      <div ref={ref as React.Ref<HTMLDivElement>} className={cn(base, className)}>
        {inner}
      </div>
    );
  },
);
KpiTile.displayName = 'KpiTile';

export default KpiTile;
