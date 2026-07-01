/**
 * PageContainer — the ONE width authority for routed page bodies (DESIGN_STANDARD
 * §4.1, §4.5). The AppShell no longer hard-caps content at 1400px; instead each
 * page opts into a width by wrapping its body in this component with a `variant`
 * chosen per archetype:
 *
 *   - `fixed`  — focused single-column (forms/settings body). DEFAULT, so pages
 *                that have not yet opted in look exactly as before (~1200px cap).
 *   - `wide`   — operational surfaces (Cases, Overview, Metrics, Standup,
 *                Campaigns, Baseline, Batch, Logs): widen by COLUMN COUNT on
 *                ultrawide, not by stretching rows.
 *   - `fluid`  — full-bleed grids / the custom-dashboard canvas (still gutter-
 *                framed, never edge-to-edge tables).
 *   - `prose`  — narrative (CaseDetail "Why"/rationale, chat threads, long-form
 *                settings) capped at a readable ~72ch measure.
 *
 * Every variant shares the gutter/vertical rhythm `mx-auto w-full px-4 sm:px-6
 * lg:px-8 2xl:px-12 py-6` and establishes a container-query context (`@container`)
 * so wrapped widgets can reflow by their SLOT width rather than the viewport
 * (via `@tailwindcss/container-queries`, shipped by W0-A's tailwind.config edit).
 *
 * `min-w-0` is set so flex/grid children inside can shrink and truncate correctly.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

export type ContainerVariant = 'fixed' | 'wide' | 'fluid' | 'prose';

/** The max-width per archetype (DESIGN_STANDARD §4.1). */
const WIDTHS: Record<ContainerVariant, string> = {
  fixed: 'max-w-[1200px]',
  wide: 'max-w-[1760px] 2xl:max-w-[1920px]',
  fluid: 'max-w-none',
  prose: 'max-w-[75ch]',
};

export interface PageContainerProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** Width archetype for the page body. Default `fixed` (nothing changes until a page opts in). */
  variant?: ContainerVariant;
  /**
   * Render into a different element (e.g. `'main'`, `'section'`). Defaults to a
   * plain `div`. Kept intentionally minimal (no `asChild`) — this is a layout box.
   */
  as?: React.ElementType;
  children: React.ReactNode;
}

/**
 * The one width authority. Centers + gutters the page body per archetype and opens
 * a container-query context for its children.
 */
export function PageContainer({
  variant = 'fixed',
  as: Comp = 'div',
  className,
  children,
  ...rest
}: PageContainerProps) {
  return (
    <Comp
      className={cn(
        '@container mx-auto w-full min-w-0 px-4 py-6 sm:px-6 lg:px-8 2xl:px-12',
        WIDTHS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </Comp>
  );
}

export default PageContainer;
