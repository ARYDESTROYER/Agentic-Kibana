import * as React from 'react';
import { cn } from '@/lib/cn';

/**
 * Skeleton placeholder. Uses the global `.shimmer` sweep (defined in theme.css)
 * over a muted block. Token-themed for both light and dark.
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

export { Skeleton };
