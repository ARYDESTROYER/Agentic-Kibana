/**
 * `ChartCard` — a small titled section card (icon chip + plain-text title + optional
 * header action) wrapping a chart/list body. Promoted OUT of `Metrics.tsx` (it lived
 * inline there) so the custom-dashboard widget bodies (G7) and the Metrics page share
 * ONE card chrome instead of re-rolling it. Behaviour is byte-identical to the former
 * inline component — Metrics only swaps its inline definition for this import.
 *
 * SECURITY (#9): `title` is caller-supplied text (a widget title may be
 * operator-authored / UNTRUSTED). It is rendered as PLAIN text — never
 * `dangerouslySetInnerHTML`. Callers must keep passing plain strings.
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';

export interface ChartCardProps {
  /** Section title — PLAIN text (#9), never markup. */
  title: string;
  /** Leading icon shown in a bordered chip. */
  icon: LucideIcon;
  /** Tailwind text-color class for the icon (defaults to the primary accent). */
  accentClass?: string;
  children: React.ReactNode;
  className?: string;
  /** Optional header-right action (e.g. a sort toggle or export link). */
  action?: React.ReactNode;
}

/**
 * A titled card with an icon chip + optional right-aligned action, wrapping a
 * flex-column body. Equal-height friendly (`flex flex-col` + a `flex-1` body) so it
 * tiles cleanly in a dashboard grid.
 */
export function ChartCard({
  title,
  icon: Icon,
  accentClass = 'text-primary',
  children,
  className,
  action,
}: ChartCardProps) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2.5 text-sm font-semibold">
          <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-surface">
            <Icon className={cn('h-3.5 w-3.5', accentClass)} aria-hidden />
          </span>
          {title}
          {action ? <span className="ml-auto">{action}</span> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1">{children}</CardContent>
    </Card>
  );
}

/** Centered inline empty hint for a chart card (no data in the active window). */
export function ChartEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center px-2 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
