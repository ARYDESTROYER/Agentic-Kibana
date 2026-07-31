/**
 * EmptyState — the canonical "nothing here (yet)" panel.
 *
 * Used on every surface for the no-data case (and, with `variant="error"`, as a
 * lightweight inline failure panel). The `title`/`description` are caller-supplied
 * UI copy; if a surface passes backend-derived text it must already be plain.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** A lucide icon component (rendered in a tinted chip). */
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary call-to-action(s) — e.g. a <Button>. */
  action?: React.ReactNode;
  /** Tightens padding for inline (in-card / in-table) usage. */
  compact?: boolean;
  /** `error` tints the icon chip with the critical colour. */
  variant?: 'default' | 'error';
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  (
    {
      className,
      icon: Icon = Inbox,
      title,
      description,
      action,
      compact = false,
      variant = 'default',
      ...props
    },
    ref,
  ) => {
    const isError = variant === 'error';
    return (
      <div
        ref={ref}
        role={isError ? 'alert' : undefined}
        className={cn(
          'flex flex-col items-center justify-center text-center',
          compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-10',
          className,
        )}
        {...props}
      >
        <div
          className={cn(
            'flex items-center justify-center rounded-md border',
            compact ? 'size-9' : 'size-11',
            isError
              ? 'border-critical/20 bg-critical/10 text-critical'
              : 'border-border bg-surface text-muted-foreground',
          )}
        >
          <Icon className={cn(compact ? 'size-4' : 'size-5')} aria-hidden />
        </div>
        <div className={cn('space-y-1', compact ? 'max-w-sm' : 'max-w-md')}>
          <p
            className={cn(
              'font-semibold text-foreground',
              compact ? 'text-sm' : 'text-base',
            )}
          >
            {title}
          </p>
          {description && (
            <p className={cn('text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>
              {description}
            </p>
          )}
        </div>
        {action && <div className={cn('flex flex-wrap items-center justify-center gap-2', compact ? 'mt-1' : 'mt-2')}>{action}</div>}
      </div>
    );
  },
);
EmptyState.displayName = 'EmptyState';
