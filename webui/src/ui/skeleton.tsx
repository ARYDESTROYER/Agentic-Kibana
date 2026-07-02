import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Skeleton placeholder. Uses the global `.shimmer` sweep (defined in theme.css)
 * over a muted block. Token-themed for both light and dark; reduced-motion safe
 * (the sweep is neutralised globally under `prefers-reduced-motion`).
 */
const Skeleton = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      'shimmer relative overflow-hidden bg-muted rounded-md',
      className,
    )}
    {...props}
  />
));
Skeleton.displayName = 'Skeleton';

/**
 * SkeletonCard — a card-shaped loading placeholder that mirrors the resting card
 * chrome (hairline border, radius, padding) so the page doesn't shift when real
 * content arrives. Renders a small header line + a few body lines by default.
 */
export interface SkeletonCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Number of body lines under the header (default 3). */
  lines?: number;
  /** Show a square "icon chip" placeholder in the header row (default true). */
  withIcon?: boolean;
}

const SkeletonCard = React.forwardRef<HTMLDivElement, SkeletonCardProps>(
  ({ className, lines = 3, withIcon = true, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('rounded-lg border border-border bg-card p-5', className)}
      aria-hidden
      {...props}
    >
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-3.5 w-24" />
        {withIcon ? <Skeleton className="h-8 w-8 rounded-md" /> : null}
      </div>
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: Math.max(1, lines) }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-3"
            // Floor the width so large `lines` values (i>=6 would go sub-visible /
            // negative → invalid CSS that snaps back to full width) still render a
            // visible, on-brand placeholder line.
            style={{ width: `${Math.max(28, 92 - i * 14)}%` }}
          />
        ))}
      </div>
    </div>
  ),
);
SkeletonCard.displayName = 'SkeletonCard';

export { Skeleton, SkeletonCard };
