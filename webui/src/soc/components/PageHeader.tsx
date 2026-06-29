import * as React from 'react';
import { cn } from '@/lib/cn';
import type { LucideIcon } from 'lucide-react';

export interface PageHeaderProps {
  /** Small uppercase label above the title (UNTRUSTED-safe: plain text). */
  eyebrow?: string;
  /** Main page title (plain text). */
  title: string;
  /** Optional supporting description (plain text). */
  description?: string;
  /** Optional leading icon component from lucide-react. */
  icon?: LucideIcon;
  /** Optional right-aligned actions (buttons, toggles, etc.). */
  actions?: React.ReactNode;
  className?: string;
}

/**
 * Standard page header: an optional icon chip, eyebrow, title + description,
 * and a right-aligned actions slot. All text renders as plain (UNTRUSTED-safe).
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  icon: Icon,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3.5">
        {Icon ? (
          <span className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
            <Icon className="h-5 w-5" aria-hidden />
          </span>
        ) : null}
        <div className="min-w-0">
          {eyebrow ? (
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {eyebrow}
            </div>
          ) : null}
          <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

export default PageHeader;
