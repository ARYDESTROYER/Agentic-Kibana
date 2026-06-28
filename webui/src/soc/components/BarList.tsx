import * as React from 'react';
import { cn } from '@/lib/cn';

export interface BarListItem {
  /** Row label — UNTRUSTED, rendered as plain text. */
  label: string;
  /** Numeric value driving the bar width + displayed figure. */
  value: number;
  /**
   * Optional explicit bar color token class (e.g. 'bg-critical', 'bg-high').
   * When omitted, the shared `bg-accent-bar` gradient is used.
   */
  color?: string;
  /** Optional secondary line under the bar (plain text). */
  sub?: string;
}

export interface BarListProps {
  items: BarListItem[];
  /** Optional value formatter (defaults to locale integer). */
  format?: (value: number) => string;
  /** Show each row's share of the max as a trailing %. */
  showPercent?: boolean;
  /** Optional card title (plain text). */
  title?: string;
  /** Show a 1-based rank index gutter on each row. */
  showRank?: boolean;
  /** Empty-state message when items is empty. */
  emptyLabel?: string;
  className?: string;
}

function defaultFormat(v: number): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  try {
    return v.toLocaleString();
  } catch {
    return String(v);
  }
}

/**
 * Ranked horizontal bar list — the dashboard "Product Category Signals" /
 * "Severity Pressure" look. Bars use the `bg-accent-bar` gradient by default or a
 * per-item token color. Labels are UNTRUSTED → rendered as plain text. Token-themed.
 */
export const BarList = React.forwardRef<HTMLDivElement, BarListProps>(
  (
    {
      items,
      format = defaultFormat,
      showPercent = false,
      title,
      showRank = false,
      emptyLabel = 'No data',
      className,
    },
    ref,
  ) => {
    const max = items.reduce((m, it) => Math.max(m, it.value || 0), 0) || 1;

    return (
      <div ref={ref} className={cn('flex flex-col', className)}>
        {title ? (
          <div className="mb-3 text-sm font-semibold text-foreground">{title}</div>
        ) : null}
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          <ul className="flex flex-col gap-4">
            {items.map((it, i) => {
              const value = it.value || 0;
              const pct = Math.max(0, Math.min(100, (value / max) * 100));
              return (
                <li key={`${it.label}-${i}`} className="flex items-start gap-3">
                  {showRank ? (
                    <span className="mt-1.5 w-6 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-medium text-foreground">
                        {it.label}
                      </span>
                      <span className="shrink-0 font-mono text-sm font-semibold tabular-nums text-foreground">
                        {format(value)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted/60">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          it.color ?? 'bg-accent-bar',
                        )}
                        style={{ width: `${pct}%` }}
                        role="progressbar"
                        aria-valuenow={Math.round(pct)}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-label={it.label}
                      />
                    </div>
                    <div className="mt-1 flex items-baseline justify-between gap-3">
                      {it.sub ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {it.sub}
                        </span>
                      ) : (
                        <span />
                      )}
                      {showPercent ? (
                        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                          {Math.round(pct)}%
                        </span>
                      ) : null}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  },
);
BarList.displayName = 'BarList';

export default BarList;
