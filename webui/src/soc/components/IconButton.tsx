/**
 * IconButton — an icon-only button with a WCAG 2.5.8 ≥24×24 hit target
 * (DESIGN_STANDARD §5.2 / §6.2). Row action icons, toolbar icons, close-X, chart
 * legend toggles etc. all route through this so the glyph can stay 16px while the
 * TARGET stays ≥24px, and so every icon-only control carries an accessible name.
 *
 * a11y contract:
 *  - `label` is REQUIRED and becomes both `aria-label` and (when `tooltip`) the
 *    tooltip content — an icon-only control must never be nameless.
 *  - `min-h-6 min-w-6` (24px) target regardless of the glyph size.
 *  - `focusRing` recipe; `type="button"` default (never accidental form submit).
 *
 * Tooltip: pass `tooltip` to wrap in the shared Tooltip (the app provides ONE
 * root `TooltipProvider`, so we do NOT nest one here). Omit `tooltip` for a bare
 * button (still labelled). Children = the Lucide icon.
 */
import * as React from 'react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/ui/tooltip';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export type IconButtonVariant = 'ghost' | 'outline' | 'subtle';
export type IconButtonSize = 'sm' | 'md';

const VARIANTS: Record<IconButtonVariant, string> = {
  ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
  subtle: 'bg-muted/60 text-foreground hover:bg-muted',
  outline: 'border border-border bg-card text-foreground hover:bg-muted',
};

const SIZES: Record<IconButtonSize, string> = {
  sm: 'h-6 w-6 [&_svg]:size-3.5', // 24px target, 14px glyph
  md: 'h-8 w-8 [&_svg]:size-4', // 32px target, 16px glyph
};

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** REQUIRED accessible name (aria-label + tooltip content). */
  label: string;
  /** Wrap in the shared Tooltip (default true). */
  tooltip?: boolean;
  /** Tooltip side. Default "top". */
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  variant?: IconButtonVariant;
  size?: IconButtonSize;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ label, tooltip = true, tooltipSide = 'top', variant = 'ghost', size = 'md', className, children, ...rest }, ref) => {
    const btn = (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          'inline-flex min-h-6 min-w-6 shrink-0 items-center justify-center rounded-md transition-colors',
          '[&_svg]:pointer-events-none [&_svg]:shrink-0 disabled:pointer-events-none disabled:opacity-50',
          VARIANTS[variant],
          SIZES[size],
          focusRing,
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );

    if (!tooltip) return btn;

    return (
      <Tooltip>
        <TooltipTrigger asChild>{btn}</TooltipTrigger>
        <TooltipContent side={tooltipSide}>{label}</TooltipContent>
      </Tooltip>
    );
  },
);
IconButton.displayName = 'IconButton';
