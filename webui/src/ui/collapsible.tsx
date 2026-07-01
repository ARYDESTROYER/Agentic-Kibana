/**
 * Collapsible — thin vendor of `@radix-ui/react-collapsible` (already an installed
 * dep). Used by named dashboard widget groups (`<DashboardGroup>`) and any
 * show/hide region with a persisted open state (DESIGN_STANDARD §5.2).
 *
 * Exports mirror the shadcn barrel shape:
 *   <Collapsible open onOpenChange>  — Radix Root (controlled or uncontrolled)
 *   <CollapsibleTrigger>             — toggles open state (`data-state` on it)
 *   <CollapsibleContent>            — the collapsible region
 *
 * The content fades on open/close and always `overflow-hidden`s so a mid-toggle
 * clip never leaks. (We avoid a height keyframe here because Radix Collapsible
 * exposes `--radix-collapsible-content-height`, which the shared accordion
 * keyframe does not read.) Motion is dropped globally under
 * `prefers-reduced-motion`.
 */
import * as React from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { cn } from '@/lib/cn';

const Collapsible = CollapsiblePrimitive.Root;

const CollapsibleTrigger = CollapsiblePrimitive.CollapsibleTrigger;

const CollapsibleContent = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.CollapsibleContent>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.CollapsibleContent>
>(({ className, ...props }, ref) => (
  <CollapsiblePrimitive.CollapsibleContent
    ref={ref}
    className={cn(
      'overflow-hidden data-[state=open]:animate-in data-[state=closed]:animate-out ' +
        'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0',
      className,
    )}
    {...props}
  />
));
CollapsibleContent.displayName = CollapsiblePrimitive.CollapsibleContent.displayName;

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
