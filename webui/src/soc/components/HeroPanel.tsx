import * as React from 'react';
import { PageHeader } from './PageHeader';
import type { LucideIcon } from 'lucide-react';

export interface HeroPanelProps {
  /** Small uppercase eyebrow (e.g. "CYBER COMMAND CENTER"). Plain text. */
  eyebrow?: string;
  /** Main hero title. Plain text. */
  title: string;
  /** Optional supporting line under the title. Plain text. */
  description?: string;
  /** Optional leading icon for the eyebrow row. */
  icon?: LucideIcon;
  /** Right-aligned meta (e.g. "Last refresh ..."), rendered above actions. */
  meta?: React.ReactNode;
  /** Right-aligned actions slot (toggles, refresh button, etc.). */
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
  /** Optional stable test anchor forwarded to the hero root. */
  'data-testid'?: string;
}

/**
 * @deprecated `HeroPanel` was merged into `PageHeader` as `variant='hero'` (W0-D D2,
 * DESIGN_STANDARD §4.2). This is now a THIN re-export kept for one transition wave so
 * existing callers (Overview/Standup/Home/Wizard/layouts) keep working unchanged; the
 * Codemod wave migrates them to `<PageHeader variant="hero" .../>` directly.
 *
 * The old right-side `meta`-over-`actions` stack is preserved by folding both into
 * PageHeader's right-aligned `actions` slot (denser posture band, not the old
 * ~176px marketing hero). All text plain (UNTRUSTED-safe, #9).
 */
export function HeroPanel({
  eyebrow,
  title,
  description,
  icon,
  meta,
  actions,
  className,
  children,
  'data-testid': dataTestId,
}: HeroPanelProps) {
  const right =
    meta || actions ? (
      <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
        {meta ? <div className="font-mono text-xs text-muted-foreground">{meta}</div> : null}
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    ) : undefined;

  return (
    <PageHeader
      variant="hero"
      eyebrow={eyebrow}
      title={title}
      description={description}
      icon={icon}
      actions={right}
      className={className}
      data-testid={dataTestId}
    >
      {children}
    </PageHeader>
  );
}

export default HeroPanel;
