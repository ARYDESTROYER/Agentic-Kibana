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
      className={cn('relative h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      // Pass the CLAMPED value to Radix so the visible fill, data-state, and the
      // Radix-derived aria-valuenow/min/max stay consistent. Forwarding a raw
      // out-of-range value made Radix console.error + flip data-state to
      // "indeterminate" (dropping aria-valuenow) while the bar still showed a full
      // fill — display and a11y disagreed. Consumer aria-* overrides still win via
      // the {...props} spread below.
      value={pct}
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
