/**
 * HelpTip — a small (?) affordance that reveals contextual help.
 *
 * Short help (no link / no code) renders as a Tooltip; longer help, a link, or a
 * code block renders as a Popover (more room, focusable). All help text is
 * operator/author-controlled (trusted) — but we still render it as plain text /
 * inside a code block, never as markup.
 *
 * No new deps: uses the existing Radix `ui/tooltip` + `ui/popover` primitives.
 */
import * as React from 'react';
import { HelpCircle } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/ui/tooltip';
import { Popover, PopoverTrigger, PopoverContent } from '@/ui/popover';

export interface HelpTipProps {
  /** The help text (plain). */
  text: string;
  /** Optional "learn more" link target (http/https). */
  link?: string;
  /** Optional example code/config shown in a code block. */
  code?: string;
  /** Accessible label for the trigger button. */
  label?: string;
  className?: string;
}

const TriggerButton = React.forwardRef<
  HTMLButtonElement,
  { label: string; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ label, className, ...rest }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-label={label}
    className={cn(
      'inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors',
      'hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      className,
    )}
    {...rest}
  >
    <HelpCircle className="h-3.5 w-3.5" aria-hidden />
  </button>
));
TriggerButton.displayName = 'HelpTipTrigger';

export function HelpTip({ text, link, code, label = 'More information', className }: HelpTipProps) {
  const usePopover = Boolean(link || code || (text && text.length > 80));

  if (!usePopover) {
    // Self-contained TooltipProvider so HelpTip works anywhere (some Settings
    // surfaces are not wrapped in a page-level TooltipProvider).
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <TriggerButton label={label} className={className} />
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs leading-relaxed">{text}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <TriggerButton label={label} className={className} />
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 text-xs leading-relaxed" align="start">
        <p className="text-muted-foreground">{text}</p>
        {code ? (
          <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] text-foreground">
            {code}
          </pre>
        ) : null}
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-medium text-primary underline-offset-2 hover:underline"
          >
            Learn more
          </a>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

export default HelpTip;
