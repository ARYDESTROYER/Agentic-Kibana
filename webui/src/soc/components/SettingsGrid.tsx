/**
 * Settings layout primitives — for the Round-3 Settings refactor.
 *
 * - `SettingsGrid`   — a responsive card grid (1 → 2 → 3 cols) that the Settings
 *                      pages drop `SettingsCard`s into. A card can span wide.
 * - `SettingsCard`   — a titled section card with an anchor id (for the TOC),
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
 * Responsive Settings card grid: 1 col on small, 2 on `lg`, 3 on `xl`. Cards flow
 * in source order; a `SettingsCard` (or any child) can opt into a wide span with
 * `className="lg:col-span-2"` / use the `wide` prop on `SettingsCard`.
 */
export const SettingsGrid = React.forwardRef<HTMLDivElement, SettingsGridProps>(
  ({ className, children, ...rest }, ref) => (
    <div
      ref={ref}
      className={cn('grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3', className)}
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
 * A titled Settings section card. Carries an `id={anchor}` + `scroll-mt` so the
 * sticky header / TOC can deep-link to it. Border-first, token-themed.
 */
export const SettingsCard = React.forwardRef<HTMLDivElement, SettingsCardProps>(
  ({ title, anchor, description, icon: Icon, actions, footer, wide, className, children, ...rest }, ref) => (
    <section
      ref={ref}
      id={anchor}
      className={cn(
        'flex scroll-mt-24 flex-col overflow-hidden rounded-lg border border-border bg-card',
        wide === 'full' ? 'lg:col-span-2 xl:col-span-3' : wide ? 'lg:col-span-2' : '',
        className,
      )}
      {...rest}
    >
      <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex min-w-0 items-start gap-3">
          {Icon ? (
            <span className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary">
              <Icon className="h-4 w-4" aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{title}</h3>
            {description ? (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
          </div>
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </header>
      <div className="flex-1 px-5 py-4">{children}</div>
      {footer ? <footer className="border-t border-border px-5 py-3 text-xs text-muted-foreground">{footer}</footer> : null}
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
  if (!visible) return null;
  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      className={cn(
        'sticky bottom-0 z-20 -mx-1 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card/95 px-4 py-3 shadow-elev2 backdrop-blur supports-[backdrop-filter]:bg-card/80',
        'animate-rise-in',
        className,
      )}
    >
      <span className="min-w-0 flex-1 text-sm text-muted-foreground" aria-live="polite">
        {message ?? 'You have unsaved changes.'}
      </span>
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDiscard} disabled={busy}>
          <RotateCcw className="h-3.5 w-3.5" aria-hidden />
          {discardLabel}
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={busy || saveDisabled}>
          <Check className="h-3.5 w-3.5" aria-hidden />
          {busy ? 'Saving…' : saveLabel}
        </Button>
      </div>
    </div>
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
  className?: string;
}

/**
 * In-section anchor TOC. Each entry scrolls its target `SettingsCard` into view
 * (honouring `scroll-mt` on the card) and reports the selection. Keyboard
 * accessible (each entry is a real button); the active entry gets an accent rail.
 */
export function SettingsTOC({ items, active, onSelect, className }: SettingsTOCProps) {
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
              'flex items-center gap-2 rounded-md border-l-2 px-3 py-1.5 text-left text-sm transition-colors',
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
