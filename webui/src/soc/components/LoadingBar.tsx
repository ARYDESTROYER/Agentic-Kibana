/**
 * LoadingBar — a slim indeterminate progress bar for "work in flight" states
 * (route loads, async actions, streaming). Uses the shared
 * `animate-bar-indeterminate` keyframes; honors reduced-motion globally via CSS.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

export interface LoadingBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** When false the bar renders nothing (convenient inline toggle). */
  active?: boolean;
  /** Track thickness. */
  size?: 'sm' | 'default';
  /** Accessible label for the progress role. */
  label?: string;
}

export const LoadingBar = React.forwardRef<HTMLDivElement, LoadingBarProps>(
  ({ className, active = true, size = 'default', label = 'Loading', ...props }, ref) => {
    if (!active) return null;
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-busy="true"
        aria-label={label}
        className={cn(
          'relative w-full overflow-hidden rounded-full bg-muted',
          size === 'sm' ? 'h-0.5' : 'h-1',
          className,
        )}
        {...props}
      >
        <div
          data-testid="loading-bar-indicator"
          className={cn(
            'absolute inset-y-0 left-0 rounded-full bg-accent-bar',
            // Animate only when the operator has not requested reduced motion. The
            // reduced state is a full, calm track fill: progress remains visible and
            // never depends on a near-zero global animation-duration override.
            'w-1/3 motion-safe:animate-bar-indeterminate motion-reduce:w-full motion-reduce:opacity-60',
          )}
        />
      </div>
    );
  },
);
LoadingBar.displayName = 'LoadingBar';
