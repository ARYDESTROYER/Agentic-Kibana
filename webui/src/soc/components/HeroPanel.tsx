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
  /** Optional stable test anchor forwarded to the hero <section> root. */
  'data-testid'?: string;
}

/**
 * Calm hero panel. A whisper-soft `bg-hero-glow` wash over the card surface with a
 * hairline border — border-first elevation, no neon. Eyebrow + title on the left,
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
  'data-testid': dataTestId,
}: HeroPanelProps) {
  return (
    <section
      data-testid={dataTestId}
      className={cn(
        'relative overflow-hidden rounded-lg border border-border bg-card',
        className,
      )}
    >
      {/* Whisper-soft wash (token gradient) — decorative only. */}
      <div className="pointer-events-none absolute inset-0 bg-hero-glow" aria-hidden />
      <div className="relative flex flex-col gap-5 p-6 sm:flex-row sm:items-start sm:justify-between sm:p-8">
        <div className="flex min-w-0 items-start gap-4">
          {Icon ? (
            <span className="mt-0.5 hidden h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-primary sm:inline-flex">
              <Icon className="h-5 w-5" aria-hidden />
            </span>
          ) : null}
          <div className="min-w-0">
            {eyebrow ? (
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {Icon ? <Icon className="h-3.5 w-3.5 sm:hidden" aria-hidden /> : null}
                <span className="truncate">{eyebrow}</span>
              </div>
            ) : null}
            <h1 className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
              {title}
            </h1>
            {description ? (
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
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
      {children ? <div className="relative px-6 pb-6 sm:px-8 sm:pb-8">{children}</div> : null}
    </section>
  );
}

export default HeroPanel;
