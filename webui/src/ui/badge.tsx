import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium leading-tight ' +
    'transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ' +
    'whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-border bg-muted text-muted-foreground',
        outline: 'border-border text-foreground',
        destructive: 'border-transparent bg-critical text-primary-foreground',
        success: 'border-success/20 bg-success/10 text-success',
        warning: 'border-warning/20 bg-warning/10 text-warning',
        info: 'border-info/20 bg-info/10 text-info',
        critical: 'border-critical/20 bg-critical/10 text-critical',
        high: 'border-high/20 bg-high/10 text-high',
        medium: 'border-medium/20 bg-medium/10 text-medium',
        low: 'border-low/20 bg-low/10 text-low',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
