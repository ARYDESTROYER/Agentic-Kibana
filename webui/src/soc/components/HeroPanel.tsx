import * as React from 'react';
import { cn } from '@/lib/cn';
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
}

/**
 * Gradient command-center hero panel. Uses the `bg-hero-glow` token gradient over
 * the card surface with a subtle border + glow. Eyebrow + title on the left,
 * meta/actions on the right. Theme-aware (light + dark) via tokens only.
 */
export function HeroPanel({
  eyebrow,
  title,
  description,
  icon: Icon,
  meta,
  actions,
  className,
  children,
}: HeroPanelProps) {
  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-lg border border-border bg-card shadow-elev1',
        className,
      )}
    >
      {/* Gradient glow layer */}
      <div className="pointer-events-none absolute inset-0 bg-hero-glow" aria-hidden />
      <div className="relative flex flex-col gap-4 p-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary">
              {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
              <span className="truncate">{eyebrow}</span>
            </div>
          ) : null}
          <h1 className="mt-1.5 text-3xl font-bold tracking-tight text-foreground">
            {title}
          </h1>
          {description ? (
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {meta || actions ? (
          <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
            {meta ? (
              <div className="font-mono text-xs text-muted-foreground">{meta}</div>
            ) : null}
            {actions ? (
              <div className="flex flex-wrap items-center gap-2">{actions}</div>
            ) : null}
          </div>
        ) : null}
      </div>
      {children ? <div className="relative px-6 pb-6">{children}</div> : null}
    </section>
  );
}

export default HeroPanel;
