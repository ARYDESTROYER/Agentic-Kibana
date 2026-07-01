/**
 * Shared scaffolding for custom-dashboard widget bodies (Round 5 / G7).
 *
 * Every widget receives {@link WidgetProps}: its persisted `options` (declarative
 * config — an operator-authored PLAIN-data bag, #9) plus an optional title override.
 * A widget reads shared data via `useDashboardSource(...)` (fetched ONCE by the
 * provider — CD2) and renders inside a `ChartCard`. It NEVER fetches on its own, never
 * writes, and its layout is advisory (never feeds `decide()`, #3).
 *
 * `WidgetShell` wraps a body in the shared `ChartCard` and handles the three universal
 * states — loading (skeleton), error/unavailable (EmptyState), ready — so each widget
 * only implements the ready body. The card TITLE is always plain text (#9).
 */
import * as React from 'react';
import type { LucideIcon } from 'lucide-react';

import { Skeleton } from '@/ui/skeleton';
import { ChartCard } from '@/soc/components/ChartCard';
import { EmptyState } from '@/soc/components/EmptyState';

/** Declarative per-widget config (title override, series, source id, …) — PLAIN (#9). */
export type WidgetOptions = Record<string, unknown>;

/** Props every widget body receives. `options` is the persisted declarative config. */
export interface WidgetProps<O extends WidgetOptions = WidgetOptions> {
  /** The widget instance id (RGL `i`). */
  id: string;
  /** Declarative config from the persisted `DashboardWidget.options` (PLAIN data #9). */
  options: O;
  /**
   * Operator title override (PLAIN text #9). When absent the widget uses the
   * registry's default title. Never HTML — rendered as text.
   */
  title?: string;
}

/**
 * Read an optional PLAIN-text title from a widget's options bag, falling back to the
 * registry default. Coerced to a string so a tampered non-string option can never
 * inject a node (#9).
 */
export function resolveTitle(
  props: Pick<WidgetProps, 'title' | 'options'>,
  fallback: string,
): string {
  const fromOptions = props.options?.title;
  const raw = props.title ?? (typeof fromOptions === 'string' ? fromOptions : undefined);
  const s = (raw ?? '').trim();
  return s || fallback;
}

export interface WidgetShellProps {
  title: string;
  icon: LucideIcon;
  accentClass?: string;
  /** True while the widget's source(s) are still loading their first payload. */
  loading?: boolean;
  /** Non-null renders an EmptyState instead of the body (error OR honest no-data). */
  emptyMessage?: React.ReactNode;
  /** Optional icon for the empty/error state. */
  emptyIcon?: LucideIcon;
  /** Optional header-right action. */
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

/**
 * The standard widget frame: a `ChartCard` that shows a skeleton while loading, an
 * `EmptyState` when there's no data / a fetch failed, and the body otherwise. Keeps
 * every widget visually consistent and DASH-safe (a widget renders `emptyMessage`
 * rather than printing a sentinel where a value belongs).
 */
export function WidgetShell({
  title,
  icon,
  accentClass,
  loading,
  emptyMessage,
  emptyIcon,
  action,
  className,
  children,
}: WidgetShellProps) {
  let body: React.ReactNode;
  if (loading) {
    body = (
      <div className="space-y-2.5" aria-busy="true" aria-label={`Loading ${title}`}>
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  } else if (emptyMessage != null) {
    body =
      typeof emptyMessage === 'string' ? (
        <EmptyState icon={emptyIcon ?? icon} title={emptyMessage} compact />
      ) : (
        emptyMessage
      );
  } else {
    body = children;
  }

  return (
    <ChartCard title={title} icon={icon} accentClass={accentClass} action={action} className={className}>
      {body}
    </ChartCard>
  );
}
