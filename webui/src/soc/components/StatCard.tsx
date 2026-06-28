import * as React from 'react';
import { cn } from '@/lib/cn';
import type { LucideIcon } from 'lucide-react';

export type StatAccent =
  | 'primary'
  | 'critical'
  | 'high'
  | 'medium'
  | 'low'
  | 'info'
  | 'success';

export interface StatCardProps {
  /** Metric label (plain text). */
  label: string;
  /** Big metric value (plain text / node). */
  value: React.ReactNode;
  /** Optional sub-line (e.g. "13 valid samples"). Plain text. */
  sub?: string;
  /** Left accent bar color. Defaults to 'primary'. */
  accent?: StatAccent;
  /** Optional trailing icon next to the label. */
  icon?: LucideIcon;
  className?: string;
}

const ACCENT_BAR: Record<StatAccent, string> = {
  primary: 'bg-primary',
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
  info: 'bg-info',
  success: 'bg-success',
};

/**
 * Big-metric card with a colored LEFT accent bar — used for MTTD / MTTA / MTTR
 * style timing metrics. Token-themed (light + dark). All text plain (UNTRUSTED-safe).
 */
export const StatCard = React.forwardRef<HTMLDivElement, StatCardProps>(
  ({ label, value, sub, accent = 'primary', icon: Icon, className }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'relative overflow-hidden rounded-lg border border-border bg-card p-5 pl-6 shadow-elev1',
          className,
        )}
      >
        <span
          className={cn('absolute inset-y-0 left-0 w-1', ACCENT_BAR[accent])}
          aria-hidden
        />
        <div className="flex items-center gap-1.5 text-sm font-medium uppercase tracking-wide text-muted-foreground">
          <span>{label}</span>
          {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden /> : null}
        </div>
        <div className="mt-2 text-3xl font-bold tracking-tight text-foreground">
          {value}
        </div>
        {sub ? <p className="mt-2 text-xs text-muted-foreground">{sub}</p> : null}
      </div>
    );
  },
);
StatCard.displayName = 'StatCard';

export default StatCard;
