/**
 * Settings layout primitives — for the Round-3 Settings refactor.
 *
 * - `SettingsGrid`   — a responsive settings-section grid (1 → 2 → 3 cols).
 * - `SettingsCard`   — a flat, divider-led section with an anchor id (for the TOC),
 *                      optional description + header actions + footer.
 * - `StickySaveBar`  — a bottom sticky bar with Save / Discard, shown only when a
 *                      page is dirty; respects busy + disabled states.
 * - `SettingsTOC`    — an in-section anchor table-of-contents that scrolls to the
 *                      matching `SettingsCard` and highlights the active section.
 *
 * All copy is caller-supplied UI text (plain). Tokenised + AA + reduced-motion via
 * the global rules. No new deps.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';
import { Button } from '@/ui/button';
import type { LucideIcon } from 'lucide-react';
import { Check, RotateCcw } from 'lucide-react';

/* ------------------------------------------------------------------------- */
/* SettingsGrid                                                               */
/* ------------------------------------------------------------------------- */

export interface SettingsGridProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
}

/**
 * Responsive Settings section grid: 1 col on small, 2 on `lg`, 3 on `2xl`. Settings
 * has both an app rail and a section rail, so the third column waits until the
 * content pane itself has enough breathing room; at 1280px an `xl` breakpoint made
 * action-bearing card headers collapse into one-character text columns. Cards flow
 * in source order; a `SettingsCard` (or any child) can opt into a wide span with
 * `className="lg:col-span-2"` / use the `wide` prop on `SettingsCard`.
 */
export const SettingsGrid = React.forwardRef<HTMLDivElement, SettingsGridProps>(
  ({ className, children, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn('grid grid-cols-1 gap-x-8 gap-y-6 lg:grid-cols-2 2xl:grid-cols-3', className)}
      {...rest}
    >
      {children}
    </div>
  ),
);
SettingsGrid.displayName = 'SettingsGrid';

/* ------------------------------------------------------------------------- */
/* SettingsCard                                                              */
/* ------------------------------------------------------------------------- */

export interface SettingsCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Section title (plain text). */
  title: React.ReactNode;
  /** Stable anchor id used by SettingsTOC + deep links (e.g. "notifications"). */
  anchor?: string;
  /** Optional supporting description (plain text). */
  description?: React.ReactNode;
  /** Optional leading icon. */
  icon?: LucideIcon;
  /** Right-aligned header actions (e.g. a toggle / "test" button). */
  actions?: React.ReactNode;
  /** Footer slot (e.g. per-card save hint). */
  footer?: React.ReactNode;
  /** Span two/three columns in the grid (wide card). */
  wide?: boolean | 'full';
  children?: React.ReactNode;
}

/**
 * A titled Settings section band. Carries an `id={anchor}` + `scroll-mt` so the
 * sticky header / TOC can deep-link to it. The flat border treatment mirrors the
 * command-center dashboard and avoids card-inside-card visual weight.
 */
export const SettingsCard = React.forwardRef<HTMLDivElement, SettingsCardProps>(
  ({ title, anchor, description, icon: Icon, actions, footer, wide, className, children, ...rest }, ref) => (
    <section
      ref={ref}
      id={anchor}
      className={cn(
        'flex scroll-mt-24 flex-col overflow-hidden border-y border-border bg-transparent',
        wide === 'full' ? 'lg:col-span-2 2xl:col-span-3' : wide ? 'lg:col-span-2' : '',
        className,
      )}
      {...rest}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border/70 px-1 py-4">
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center border border-border bg-surface text-primary">
              <Icon className="h-4 w-4" aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
            {description ? (
              <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="flex-1 px-1 py-4">{children}</div>
      {footer ? <footer className="border-t border-border/70 px-1 py-3 text-xs text-muted-foreground">{footer}</footer> : null}
    </section>
  ),
);
SettingsCard.displayName = 'SettingsCard';

/* ------------------------------------------------------------------------- */
/* StickySaveBar                                                             */
/* ------------------------------------------------------------------------- */

export interface StickySaveBarProps {
  /** Show the bar (typically `dirty`). When false the bar is not rendered. */
  visible: boolean;
  /** Save handler. */
  onSave: () => void;
  /** Discard handler. */
  onDiscard: () => void;
  /** In-flight flag → disables both + shows a saving label. */
  busy?: boolean;
  /** Disable save (e.g. validation errors) while keeping discard active. */
  saveDisabled?: boolean;
  /** Message on the left (e.g. "3 unsaved changes"). Plain text. */
  message?: React.ReactNode;
  /** Save / discard button labels. */
  saveLabel?: string;
  discardLabel?: string;
  className?: string;
}

/**
 * Bottom sticky save/discard bar. Sticks to the bottom of its scroll container
 * (`sticky bottom-0`); render it as the LAST child of the settings scroll region.
 * Hidden entirely when `!visible` so it never occupies space on a clean page.
 */
export function StickySaveBar({
  visible,
  onSave,
  onDiscard,
  busy = false,
  saveDisabled = false,
  message,
  saveLabel = 'Save changes',
  discardLabel = 'Discard',
  className,
}: StickySaveBarProps) {
  // A PERSISTENT (always-mounted) polite live region: screen readers only announce
  // content that changes INSIDE a region that already existed in the DOM, so a live
  // region inserted at the same instant as its text (the old `!visible → null` path)
  // was never announced. Keeping this node mounted and toggling its text means the
  // MUTATION (empty → message) is what AT announces when the save bar appears.
  const liveMessage = visible
    ? typeof message === 'string'
      ? message
      : 'You have unsaved changes.'
    : '';
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </div>
      {visible ? (
        <div
          role="region"
          aria-label="Unsaved changes"
          className={cn(
            'sticky bottom-0 z-20 -mx-1 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/95 px-4 py-3 shadow-elev2 backdrop-blur supports-[backdrop-filter]:bg-card/80',
            // Honour prefers-reduced-transparency: `.glass-surface` drops the backdrop-filter
            // (global guard in theme.css) and the media variant forces a fully-opaque bg so
            // scrolling content never bleeds through behind the muted text (WCAG-AA).
            'glass-surface [@media(prefers-reduced-transparency:reduce)]:!bg-card',
            'animate-rise-in',
            className,
          )}
        >
          <span className="min-w-0 flex-1 text-sm text-muted-foreground">
            {message ?? 'You have unsaved changes.'}
          </span>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
              {/* No size override: the shared Button's `[&_svg]:size-4` wins on specificity,
                  so an `h-3.5 w-3.5` here would be dead — rely on the uniform 16px icon. */}
              <RotateCcw aria-hidden />
              {discardLabel}
            </Button>
            <Button type="button" size="sm" onClick={onSave} disabled={busy || saveDisabled}>
              <Check aria-hidden />
              {busy ? 'Saving…' : saveLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------------- */
/* SettingsTOC                                                               */
/* ------------------------------------------------------------------------- */

export interface SettingsTOCItem {
  /** The `anchor` id of the target SettingsCard. */
  anchor: string;
  /** Plain-text label. */
  label: string;
  /** Optional leading icon. */
  icon?: LucideIcon;
}

export interface SettingsTOCProps {
  items: SettingsTOCItem[];
  /** The currently active anchor (caller may track via scroll). */
  active?: string;
  /** Called with the clicked anchor (caller may smooth-scroll / setActive). */
  onSelect?: (anchor: string) => void;
  /**
   * Active-item accent orientation. `vertical` (default) draws a left rail — correct for
   * the stacked rail; `horizontal` draws a bottom underline — correct when the TOC is laid
   * out as a `flex-row` tab strip (otherwise the left rail reads as a stray vertical bar).
   */
  orientation?: 'vertical' | 'horizontal';
  className?: string;
}

/**
 * In-section anchor TOC. Each entry scrolls its target `SettingsCard` into view
 * (honouring `scroll-mt` on the card) and reports the selection. Keyboard
 * accessible (each entry is a real button); the active entry gets an accent rail.
 */
export function SettingsTOC({ items, active, onSelect, orientation = 'vertical', className }: SettingsTOCProps) {
  const horizontal = orientation === 'horizontal';
  const go = React.useCallback(
    (anchor: string) => {
      onSelect?.(anchor);
      if (typeof document === 'undefined') return;
      const el = document.getElementById(anchor);
      // Honour prefers-reduced-motion (#7): smooth-scroll only when the user has NOT
      // requested reduced motion; otherwise jump instantly with 'auto'.
      const reduceMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    },
    [onSelect],
  );
  return (
    <nav aria-label="Settings sections" className={cn('flex flex-col gap-0.5', className)}>
      {items.map((it) => {
        const isActive = active === it.anchor;
        const Icon = it.icon;
        return (
          <button
            key={it.anchor}
            type="button"
            onClick={() => go(it.anchor)}
            aria-current={isActive ? 'true' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors',
              // Left rail for the vertical rail; bottom underline for the horizontal tab strip.
              horizontal ? 'border-b-2' : 'border-l-2',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive
                ? 'border-primary bg-accent/40 font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:bg-accent/30 hover:text-foreground',
            )}
          >
            {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            <span className="truncate">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

export default SettingsGrid;
