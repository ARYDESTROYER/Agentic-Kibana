import * as React from 'react';
import { cn } from '@/lib/cn';
import { ChevronRight, type LucideIcon } from 'lucide-react';

/** A single breadcrumb crumb (plain text; `href` optional for deep-linking). */
export interface Crumb {
  label: string;
  href?: string;
}

export interface PageHeaderProps {
  /**
   * `'dense'` (default) — a compact ~52px header band (breadcrumb over a
   * `text-lg/xl` title, small icon chip, actions right).
   * `'hero'` — a compacted posture band (`p-6`, `text-2xl`, whisper `bg-hero-glow`
   * wash) that folds a KPI/meta summary into the `meta`/`tabs` slots. NOT the old
   * ~176px marketing hero.
   */
  variant?: 'dense' | 'hero';
  /** Breadcrumb trail above the title (plain text). Preferred over `eyebrow`. */
  breadcrumb?: Crumb[];
  /**
   * @deprecated Small uppercase label above the title. Kept for the transition
   * wave; the Codemod migrates call sites to `breadcrumb`. Plain text (#9).
   */
  eyebrow?: string;
  /** Main page title (plain text). */
  title: string;
  /** Optional supporting description (plain text). */
  description?: string;
  /** Optional leading icon component from lucide-react. */
  icon?: LucideIcon;
  /** Status/severity badges (or a folded KPI summary) beside the title. Denser than prose. */
  meta?: React.ReactNode;
  /** Section tabs rendered on the header's bottom edge (no second band). */
  tabs?: React.ReactNode;
  /** Optional right-aligned actions (buttons, toggles, etc.). */
  actions?: React.ReactNode;
  /** Optional stick-to-top behavior (offset by `--header-h`). */
  sticky?: boolean;
  className?: string;
  /**
   * Extra content rendered below the header (hero variant). Kept for the
   * `HeroPanel` transition wrapper.
   */
  children?: React.ReactNode;
  /** Stable test anchor forwarded to the header root (e.g. `page-hero`). */
  'data-testid'?: string;
}

/**
 * Only http(s), root-relative, or in-page fragment hrefs may become links (#9,
 * defense-in-depth). A `javascript:`/`data:` crumb href — React does NOT sanitize
 * href — would execute on click, so any other scheme is dropped to a plain `<span>`.
 * Mirrors `ThreatContextPanel.mitreUrl()`'s `^https?://` guard. Returns `undefined`
 * for an unsafe/absent href so the caller renders a non-interactive crumb.
 */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (/^\s*javascript:/i.test(href) || /^\s*data:/i.test(href)) return undefined;
  return /^(https?:|\/|#)/i.test(href.trim()) ? href : undefined;
}

/** Breadcrumb trail — plain text crumbs joined by chevrons (UNTRUSTED-safe, #9). */
function Breadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
    >
      {crumbs.map((c, i) => {
        const href = safeHref(c.href);
        return (
          <React.Fragment key={`${c.label}-${i}`}>
            {i > 0 ? <ChevronRight className="h-3 w-3 shrink-0 opacity-60" aria-hidden /> : null}
            {href ? (
              <a href={href} className="truncate hover:text-foreground">
                {c.label}
              </a>
            ) : (
              <span className="truncate">{c.label}</span>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/**
 * Standard page header. `variant='dense'` (default) is a single compact band —
 * breadcrumb/eyebrow over the title, a small icon chip, meta beside the title, and
 * a right-aligned actions slot, with optional section `tabs` on the bottom edge.
 * `variant='hero'` is the compacted posture band (whisper wash, `text-2xl`).
 *
 * All text renders as plain (UNTRUSTED-safe, #9); never `dangerouslySetInnerHTML`.
 */
export function PageHeader({
  variant = 'dense',
  breadcrumb,
  eyebrow,
  title,
  description,
  icon: Icon,
  meta,
  tabs,
  actions,
  sticky,
  className,
  children,
  'data-testid': dataTestId,
}: PageHeaderProps) {
  const hero = variant === 'hero';
  const crumbs = breadcrumb && breadcrumb.length > 0 ? breadcrumb : null;

  const overline = crumbs ? (
    <Breadcrumbs crumbs={crumbs} />
  ) : eyebrow ? (
    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
      {eyebrow}
    </div>
  ) : null;

  const stickyCls = sticky
    ? 'sticky top-[var(--header-h)] z-20 bg-background/95 supports-[backdrop-filter]:bg-background/80 backdrop-blur'
    : undefined;

  return (
    <section
      data-testid={dataTestId}
      className={cn(
        'relative',
        hero && 'overflow-hidden rounded-lg border border-border bg-card',
        stickyCls,
        className,
      )}
    >
      {/* Whisper-soft wash — decorative only (hero variant). */}
      {hero ? (
        <div className="pointer-events-none absolute inset-0 bg-hero-glow" aria-hidden />
      ) : null}

      <div
        className={cn(
          'relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
          hero && 'gap-4 p-6 sm:gap-5',
        )}
      >
        <div className={cn('flex min-w-0 items-start', hero ? 'gap-3.5' : 'gap-3')}>
          {Icon ? (
            <span
              className={cn(
                'mt-0.5 inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary',
                hero ? 'h-8 w-8' : 'h-7 w-7',
              )}
            >
              <Icon className={hero ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0">
            {overline}
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <h1
                className={cn(
                  'truncate font-semibold tracking-tight text-foreground',
                  hero ? 'text-2xl' : 'text-lg sm:text-xl',
                )}
              >
                {title}
              </h1>
              {meta ? <div className="flex flex-wrap items-center gap-2">{meta}</div> : null}
            </div>
            {description ? (
              <p
                className={cn(
                  'mt-1 max-w-2xl leading-relaxed text-muted-foreground',
                  hero ? 'text-sm' : 'text-xs sm:text-sm',
                )}
              >
                {description}
              </p>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>

      {tabs ? <div className={cn('relative', hero && 'px-6')}>{tabs}</div> : null}
      {hero && children ? <div className="relative px-6 pb-6">{children}</div> : null}
    </section>
  );
}

export default PageHeader;
