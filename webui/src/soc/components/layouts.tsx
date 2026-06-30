/**
 * Page archetype layout wrappers — break the uniform "KPI-row + table" monotony.
 *
 * Three composable shells that pages opt into for a distinctive feel without
 * re-rolling structure. They compose the existing `PageHeader` / `HeroPanel`, use
 * only tokens, and stay fully responsive + AA. Pages remain free to NOT use these.
 *
 *   - `CommandCenterLayout`  — a hero band + a KPI/summary strip + a free body.
 *                              For overview/dashboard surfaces.
 *   - `WorklistLayout`       — a compact header + a left filter/aside rail and a
 *                              main list/table region (a queue/worklist surface).
 *   - `InvestigationLayout`  — a header + a main investigation column and a sticky
 *                              right context rail (case/entity detail surfaces).
 *
 * All slot content is caller-supplied; any backend-derived text passed in must
 * already be plain (#9). No new deps.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';
import { HeroPanel, type HeroPanelProps } from './HeroPanel';
import { PageHeader, type PageHeaderProps } from './PageHeader';

/* ------------------------------------------------------------------------- */
/* CommandCenterLayout                                                       */
/* ------------------------------------------------------------------------- */

export interface CommandCenterLayoutProps {
  /** Props forwarded to the `HeroPanel` band at the top. */
  hero: HeroPanelProps;
  /** A strip directly under the hero — typically a KPI tile row. */
  strip?: React.ReactNode;
  /** The main body (charts / panels). */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Dashboard archetype: a `HeroPanel` band, an optional summary `strip` (KPI tiles),
 * then the body. The strip sits in its own row so it reads as a distinct band.
 */
export function CommandCenterLayout({ hero, strip, children, className }: CommandCenterLayoutProps) {
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <HeroPanel {...hero} />
      {strip ? <div>{strip}</div> : null}
      {children ? <div className="flex flex-col gap-6">{children}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* WorklistLayout                                                            */
/* ------------------------------------------------------------------------- */

export interface WorklistLayoutProps {
  /** Props forwarded to the compact `PageHeader`. */
  header: PageHeaderProps;
  /** Left rail content (filters, saved views, facets). */
  aside?: React.ReactNode;
  /** Place the aside on the right instead of the left. */
  asideSide?: 'left' | 'right';
  /** Width of the aside rail (Tailwind width class). Default `w-64`. */
  asideWidth?: string;
  /** The main worklist/table region. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Queue archetype: a header, then a two-column body with a sticky filter/aside rail
 * beside the main list. The aside collapses ABOVE the main column on small screens.
 */
export function WorklistLayout({
  header,
  aside,
  asideSide = 'left',
  asideWidth = 'w-64',
  children,
  className,
}: WorklistLayoutProps) {
  const railFirst = asideSide === 'left';
  const rail = aside ? (
    <aside className={cn('shrink-0 lg:sticky lg:top-20 lg:self-start', asideWidth)}>{aside}</aside>
  ) : null;
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <PageHeader {...header} />
      <div className="flex flex-col gap-6 lg:flex-row">
        {railFirst ? rail : null}
        <div className="min-w-0 flex-1">{children}</div>
        {!railFirst ? rail : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/* InvestigationLayout                                                       */
/* ------------------------------------------------------------------------- */

export interface InvestigationLayoutProps {
  /** Props forwarded to the `PageHeader`. */
  header: PageHeaderProps;
  /** The right-hand context rail (entity/threat/timeline panels). */
  context?: React.ReactNode;
  /** Context rail width (Tailwind width class). Default `w-80`. */
  contextWidth?: string;
  /** The main investigation column. */
  children?: React.ReactNode;
  className?: string;
}

/**
 * Case archetype: a header, then a main investigation column with a STICKY right
 * context rail (related cases / threat context / timeline). The rail drops below
 * the main column on small screens.
 */
export function InvestigationLayout({
  header,
  context,
  contextWidth = 'w-80',
  children,
  className,
}: InvestigationLayoutProps) {
  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <PageHeader {...header} />
      <div className="flex flex-col gap-6 xl:flex-row">
        <div className="min-w-0 flex-1">{children}</div>
        {context ? (
          <aside className={cn('shrink-0 xl:sticky xl:top-20 xl:self-start', contextWidth)}>
            {context}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
