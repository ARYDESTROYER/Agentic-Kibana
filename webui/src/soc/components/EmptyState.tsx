/**
 * EmptyState — the canonical explanation for absent Console content.
 *
 * New call sites should choose an explicit `state` so assistive technology and
 * visual treatment can distinguish an empty first-use surface, filtered results,
 * a successfully cleared queue, an unavailable capability, and a failure. The
 * `title`/`description` remain caller-supplied because only the surface knows why
 * content is absent and which recovery action is safe. Backend-derived copy must
 * already be plain text.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  CircleCheck,
  CircleOff,
  Inbox,
  ListPlus,
  SearchX,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '@/lib/cn';

export type EmptyStateSemantic =
  | 'first-use'
  | 'no-data'
  | 'no-results'
  | 'success'
  | 'unavailable'
  | 'error';

const STATE_META: Record<
  EmptyStateSemantic,
  { icon: LucideIcon; markerClassName: string }
> = {
  'first-use': {
    icon: ListPlus,
    markerClassName: 'border-border bg-surface text-muted-foreground',
  },
  'no-data': {
    icon: Inbox,
    markerClassName: 'border-border bg-surface text-muted-foreground',
  },
  'no-results': {
    icon: SearchX,
    markerClassName: 'border-border bg-surface text-muted-foreground',
  },
  success: {
    icon: CircleCheck,
    markerClassName: 'border-success/20 bg-success/10 text-success',
  },
  unavailable: {
    icon: CircleOff,
    markerClassName: 'border-warning/25 bg-warning/10 text-warning',
  },
  error: {
    icon: TriangleAlert,
    markerClassName: 'border-critical/20 bg-critical/10 text-critical',
  },
};

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** A lucide icon component (rendered in a tinted chip). */
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary call-to-action(s) — e.g. a <Button>. */
  action?: React.ReactNode;
  /** Tightens padding for inline (in-card / in-table) usage. */
  compact?: boolean;
  /** Why content is absent. Prefer an explicit value on new call sites. */
  state?: EmptyStateSemantic;
  /** Legacy visual API. `error` remains an alias that forces `state="error"`. */
  variant?: 'default' | 'error';
}

export const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(
  (
    {
      className,
      icon: IconOverride,
      title,
      description,
      action,
      compact = false,
      state,
      variant = 'default',
      ...props
    },
    ref,
  ) => {
    const resolvedState: EmptyStateSemantic =
      variant === 'error' ? 'error' : (state ?? 'no-data');
    const meta = STATE_META[resolvedState];
    const Icon = IconOverride ?? meta.icon;
    const titleId = React.useId();
    const descriptionId = React.useId();
    const semanticRole =
      resolvedState === 'error'
        ? 'alert'
        : state === undefined
          ? undefined
          : resolvedState === 'first-use' || resolvedState === 'no-data'
            ? 'group'
            : 'status';
    const isLiveFeedback = semanticRole === 'alert' || semanticRole === 'status';

    return (
      <div
        ref={ref}
        role={semanticRole}
        aria-atomic={isLiveFeedback ? true : undefined}
        aria-labelledby={semanticRole ? titleId : undefined}
        aria-describedby={semanticRole && description ? descriptionId : undefined}
        data-empty-state={resolvedState}
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
            meta.markerClassName,
          )}
        >
          <Icon className={cn(compact ? 'size-4' : 'size-5')} aria-hidden />
        </div>
        <div className={cn('space-y-1', compact ? 'max-w-sm' : 'max-w-md')}>
          <p
            id={titleId}
            className={cn(
              'font-semibold text-foreground',
              compact ? 'text-sm' : 'text-base',
            )}
          >
            {title}
          </p>
          {description && (
            <p
              id={descriptionId}
              className={cn('text-muted-foreground', compact ? 'text-xs' : 'text-sm')}
            >
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
