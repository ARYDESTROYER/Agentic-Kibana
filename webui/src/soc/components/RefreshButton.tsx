/**
 * RefreshButton — the canonical manual-reload action for Console pages.
 *
 * The glyph and label remain mounted while a request is in flight, so entering the
 * busy state cannot resize a toolbar or shift neighbouring controls.  `aria-busy`
 * communicates progress, and disabling the button prevents accidental duplicate
 * requests while preserving the page's last usable data.
 */
import * as React from 'react';
import { RefreshCw } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Button, type ButtonProps } from '@/ui/button';

export interface RefreshButtonProps
  extends Omit<ButtonProps, 'asChild' | 'children' | 'type'> {
  /** True while the reload request is in flight. */
  refreshing?: boolean;
  /** Visible and accessible action name. */
  label?: string;
}

export const RefreshButton = React.forwardRef<HTMLButtonElement, RefreshButtonProps>(
  (
    {
      refreshing = false,
      label = 'Refresh',
      disabled = false,
      variant = 'outline',
      size = 'sm',
      ...props
    },
    ref,
  ) => (
    <Button
      {...props}
      ref={ref}
      type="button"
      variant={variant}
      size={size}
      aria-busy={refreshing}
      disabled={disabled || refreshing}
    >
      <span
        className="inline-flex size-4 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <RefreshCw
          className={cn(
            'size-4',
            refreshing && 'animate-spin motion-reduce:animate-none',
          )}
        />
      </span>
      <span>{label}</span>
    </Button>
  ),
);
RefreshButton.displayName = 'RefreshButton';
