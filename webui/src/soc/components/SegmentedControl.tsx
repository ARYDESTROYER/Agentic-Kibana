/**
 * SegmentedControl — a Radix Tabs primitive styled as a segmented switch
 * (DESIGN_STANDARD §5.2). Replaces the hand-rolled toggle strips (Chat/Investigate,
 * density, stack-by, time-window). It is a VALUE selector, not a page-tab surface —
 * it emits `onValueChange`; render the panels yourself.
 *
 * a11y: Radix Tabs gives arrow-key roving + `role="tab"`/`aria-selected` for free.
 * Pass `aria-label` describing what the control selects. Icons inside options are
 * decorative (`aria-hidden`); the text label carries meaning.
 *
 * Sizing: `sm` (h-8) for toolbars, `md` (h-9) default. Options are equal-width when
 * `fitted`, otherwise sized to content.
 */
import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';
import { focusRing } from '@/lib/ui-recipes';

export interface SegmentOption<T extends string = string> {
  value: T;
  label: React.ReactNode;
  /** Optional leading icon (decorative). */
  icon?: React.ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  /** Options in display order. */
  options: SegmentOption<T>[];
  /** Selected value (controlled). */
  value: T;
  onValueChange: (value: T) => void;
  /** Accessible name for the group. */
  'aria-label'?: string;
  size?: 'sm' | 'md';
  /** Equal-width segments filling the container. Default false. */
  fitted?: boolean;
  disabled?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string = string>({
  options,
  value,
  onValueChange,
  size = 'md',
  fitted = false,
  disabled,
  className,
  ...rest
}: SegmentedControlProps<T>) {
  return (
    <TabsPrimitive.Root
      value={value}
      onValueChange={(v) => onValueChange(v as T)}
      className={cn('inline-block', fitted && 'w-full', className)}
    >
      <TabsPrimitive.List
        aria-label={rest['aria-label']}
        className={cn(
          'inline-flex items-center gap-1 rounded-lg border border-border bg-muted/60 p-1 text-muted-foreground',
          size === 'sm' ? 'h-8' : 'h-9',
          fitted && 'flex w-full',
        )}
      >
        {options.map((opt) => (
          <TabsPrimitive.Trigger
            key={opt.value}
            value={opt.value}
            disabled={disabled || opt.disabled}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors',
              size === 'sm' ? 'h-6 px-2.5 text-xs' : 'h-7 px-3 text-sm',
              fitted && 'flex-1',
              'text-muted-foreground hover:text-foreground',
              'data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm',
              'disabled:pointer-events-none disabled:opacity-50',
              focusRing,
            )}
          >
            {opt.icon ? (
              <span className="[&_svg]:size-3.5 [&_svg]:shrink-0" aria-hidden="true">
                {opt.icon}
              </span>
            ) : null}
            {opt.label}
          </TabsPrimitive.Trigger>
        ))}
      </TabsPrimitive.List>
    </TabsPrimitive.Root>
  );
}
SegmentedControl.displayName = 'SegmentedControl';
