/**
 * ControlBar — the compact control-bar row of the three-zone dashboard
 * (DESIGN_STANDARD §4.3, IMPLEMENTATION Dash-B). ONE dense row: a title/eyebrow +
 * optional breadcrumb on the LEFT, and the controls (TimeRangePicker, filter
 * Selects, refresh, view actions) on the RIGHT. Reusable across Overview / Metrics /
 * any operational dashboard so the control row stays byte-consistent.
 *
 * It is intentionally thin — a flex layout + a `flat`/`bordered` surface — and does
 * NOT own any state; the page composes `<TimeRangePicker>`, filters, etc. into the
 * `controls` slot. Wraps at small widths (controls drop below the title) so it stays
 * usable on narrow viewports without a media-query fork.
 *
 * a11y: renders as a labelled `role="group"` region for the controls when a
 * `label` is given (NOT `role="toolbar"` — the children are independently tabbable
 * with no roving-tabindex/arrow navigation, which a toolbar would falsely advertise;
 * a labelled group carries no keyboard-navigation expectation and matches the actual
 * behavior). The title (if any) is a plain-text `<h2>`-ish eyebrow (never HTML). All
 * values passed in are the caller's responsibility to keep UNTRUSTED-safe.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';

export interface ControlBarProps {
  /** Optional left-side title/eyebrow (plain text or a small node, e.g. a breadcrumb). */
  title?: React.ReactNode;
  /** Optional muted sub-line under/next to the title. */
  meta?: React.ReactNode;
  /** The controls, right-aligned (TimeRangePicker, filter Selects, buttons). */
  controls?: React.ReactNode;
  /** Accessible name for the controls group (recommended when `controls` is set). */
  label?: string;
  /**
   * Surface: `flat` (default) sits on the page with a bottom hairline; `bordered`
   * is a full bordered card row; `plain` is layout-only (no border/background).
   */
  variant?: 'flat' | 'bordered' | 'plain';
  /** Stick to the top of the scroll container (offset by --header-h). Default false. */
  sticky?: boolean;
  className?: string;
}

const SURFACE: Record<NonNullable<ControlBarProps['variant']>, string> = {
  flat: 'border-b border-border',
  bordered: 'rounded-lg border border-border bg-card px-3 shadow-elev1',
  plain: '',
};

export function ControlBar({
  title,
  meta,
  controls,
  label,
  variant = 'flat',
  sticky = false,
  className,
}: ControlBarProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 py-2',
        SURFACE[variant],
        sticky && 'sticky z-20 top-[var(--header-h)] bg-background/95 backdrop-blur',
        className,
      )}
    >
      {(title || meta) && (
        <div className="mr-auto flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          {title ? (
            <div className="min-w-0 truncate text-sm font-semibold text-foreground">{title}</div>
          ) : null}
          {meta ? <div className="truncate text-xs text-muted-foreground">{meta}</div> : null}
        </div>
      )}
      {controls ? (
        <div
          role={label ? 'group' : undefined}
          aria-label={label}
          className={cn(
            'flex flex-wrap items-center gap-2',
            // When there is no title, the controls should still push right.
            !title && !meta && 'ml-auto',
          )}
        >
          {controls}
        </div>
      ) : null}
    </div>
  );
}
ControlBar.displayName = 'ControlBar';
