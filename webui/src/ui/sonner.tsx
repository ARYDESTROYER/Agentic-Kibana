import * as React from 'react';
import { Toaster as SonnerToaster } from 'sonner';

type ToasterProps = React.ComponentProps<typeof SonnerToaster>;

/**
 * Pre-themed sonner Toaster. Drives toast colors from our CSS-var tokens so it
 * matches both light and dark themes automatically (theme is controlled by the
 * `.dark` class on <html>, so `theme="system"` here just defers to our tokens).
 * Import `toast` directly from 'sonner' to fire toasts.
 */
function Toaster({ ...props }: ToasterProps) {
  return (
    <SonnerToaster
      theme="system"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-card group-[.toaster]:text-foreground ' +
            'group-[.toaster]:border group-[.toaster]:border-border group-[.toaster]:shadow-elev2',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
          error:
            'group-[.toaster]:!border-critical/40 group-[.toaster]:!text-critical',
          success:
            'group-[.toaster]:!border-success/40 group-[.toaster]:!text-success',
          warning:
            'group-[.toaster]:!border-warning/40 group-[.toaster]:!text-warning',
          info: 'group-[.toaster]:!border-info/40 group-[.toaster]:!text-info',
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
