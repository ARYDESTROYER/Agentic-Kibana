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

const ACCENT_BAR: Record<KpiAccent, string> = {
  primary: 'bg-primary',
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
  success: 'bg-success',
};

const ACCENT_TEXT: Record<KpiAccent, string> = {
  primary: 'text-primary',
  critical: 'text-critical',
  high: 'text-high',
  medium: 'text-medium',
  low: 'text-low',
  info: 'text-info',
  success: 'text-success',
};

/**
 * Accent-topped KPI tile. Renders as a static card, or — when `onClick` is set —
 * a keyboard-accessible button with focus ring + hover affordance. Token-themed.
 */
export const KpiTile = React.forwardRef<HTMLElement, KpiTileProps>(
  ({ label, value, sub, icon: Icon, accent = 'primary', delta, onClick, className }, ref) => {
    const clickable = typeof onClick === 'function';

    const inner = (
      <>
        {/* Top accent bar */}
        <span
          className={cn('absolute inset-x-0 top-0 h-1', ACCENT_BAR[accent])}
          aria-hidden
        />
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-muted-foreground">{label}</span>
          {Icon ? (
            <span className={cn('shrink-0', ACCENT_TEXT[accent])}>
              <Icon className="h-4 w-4" aria-hidden />
            </span>
          ) : null}
        </div>
        <div className="mt-3 flex items-end gap-2">
          <span className="text-3xl font-bold leading-none tracking-tight text-foreground">
            {value}
          </span>
          {delta ? (
            <span
              className={cn(
                'mb-0.5 inline-flex items-center gap-0.5 text-xs font-semibold',
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
        {sub ? <p className="mt-2 text-xs text-muted-foreground">{sub}</p> : null}
      </>
    );

    const base =
      'relative overflow-hidden rounded-lg border border-border bg-card p-4 pt-5 text-left shadow-elev1';

    if (clickable) {
      return (
        <button
          ref={ref as React.Ref<HTMLButtonElement>}
          type="button"
          onClick={onClick}
          className={cn(
            base,
            'block w-full transition-colors hover:bg-accent/40 hover:border-primary/40',
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
