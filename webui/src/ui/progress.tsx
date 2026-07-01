import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * The indicator fill color. `default` = `bg-primary` (unchanged look). The
 * semantic variants replace the ad-hoc `[&>div]:bg-*` overrides consumers were
 * reaching for (DESIGN_STANDARD §5.2 / map §3.13).
 */
const progressIndicator = cva('h-full w-full flex-1 transition-all', {
  variants: {
    variant: {
      default: 'bg-primary',
      success: 'bg-success',
      warning: 'bg-warning',
      critical: 'bg-critical',
    },
  },
  defaultVariants: { variant: 'default' },
});

export interface ProgressProps
  extends React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>,
    VariantProps<typeof progressIndicator> {}

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(({ className, value, variant, ...props }, ref) => {
  const pct = Math.max(0, Math.min(100, value ?? 0));
  return (
    <ProgressPrimitive.Root
      ref={ref}
      // A sensible accessible default when the consumer didn't supply one.
      aria-valuenow={props['aria-valuenow'] ?? Math.round(pct)}
      aria-valuemin={props['aria-valuemin'] ?? 0}
      aria-valuemax={props['aria-valuemax'] ?? 100}
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={progressIndicator({ variant })}
        style={{ transform: `translateX(-${100 - pct}%)` }}
      />
    </ProgressPrimitive.Root>
  );
});
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
