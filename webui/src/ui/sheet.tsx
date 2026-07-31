import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { focusRing, modalOverlay } from '@/lib/ui-recipes';

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    ref={ref}
    className={cn(modalOverlay, className)}
    {...props}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  cn(
    'fixed z-50 flex flex-col gap-4 bg-card text-foreground shadow-elev2 border-border',
    'data-[state=open]:animate-in data-[state=closed]:animate-out',
    'data-[state=closed]:duration-200 data-[state=open]:duration-300',
  ),
  {
    variants: {
      side: {
        top: 'inset-x-0 top-0 border-b data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top',
        bottom:
          'inset-x-0 bottom-0 border-t data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
        left: 'inset-y-0 left-0 h-dvh border-r data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
        right:
          'inset-y-0 right-0 h-dvh border-l data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
      },
      size: {
        sm: '',
        default: '',
        lg: '',
        xl: '',
        full: '',
      },
    },
    compoundVariants: [
      // horizontal panels (left/right) → width-bound
      { side: 'right', size: 'sm', class: 'w-full max-w-sm' },
      { side: 'right', size: 'default', class: 'w-full max-w-md' },
      { side: 'right', size: 'lg', class: 'w-full max-w-2xl' },
      { side: 'right', size: 'xl', class: 'w-full max-w-[56rem]' },
      { side: 'right', size: 'full', class: 'w-full max-w-full' },
      { side: 'left', size: 'sm', class: 'w-full max-w-sm' },
      { side: 'left', size: 'default', class: 'w-full max-w-md' },
      { side: 'left', size: 'lg', class: 'w-full max-w-2xl' },
      { side: 'left', size: 'xl', class: 'w-full max-w-[56rem]' },
      { side: 'left', size: 'full', class: 'w-full max-w-full' },
      // vertical panels (top/bottom) → height-bound
      { side: 'top', size: 'sm', class: 'max-h-[25dvh]' },
      { side: 'top', size: 'default', class: 'max-h-[40dvh]' },
      { side: 'top', size: 'lg', class: 'max-h-[60dvh]' },
      { side: 'top', size: 'xl', class: 'max-h-[80dvh]' },
      { side: 'top', size: 'full', class: 'h-dvh max-h-dvh' },
      { side: 'bottom', size: 'sm', class: 'max-h-[25dvh]' },
      { side: 'bottom', size: 'default', class: 'max-h-[40dvh]' },
      { side: 'bottom', size: 'lg', class: 'max-h-[60dvh]' },
      { side: 'bottom', size: 'xl', class: 'max-h-[80dvh]' },
      { side: 'bottom', size: 'full', class: 'h-dvh max-h-dvh' },
    ],
    defaultVariants: {
      side: 'right',
      size: 'default',
    },
  },
);

export interface SheetContentProps
  extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(({ side = 'right', size = 'default', className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <SheetPrimitive.Content
      ref={ref}
      className={cn(sheetVariants({ side, size }), className)}
      {...props}
    >
      {children}
      <SheetPrimitive.Close
        aria-label="Close"
        className={cn(
          'absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded-md',
          'text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          focusRing,
          'disabled:pointer-events-none',
        )}
      >
        <X className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPortal>
));
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    // `pr-14` reserves room for the built-in close (X) pinned at `right-4` (28px box)
    // so a long title never slides underneath it — no per-consumer `pr-8`/`truncate`.
    className={cn('flex flex-col gap-1.5 border-b border-border p-6 pr-14 text-left', className)}
    {...props}
  />
);
SheetHeader.displayName = 'SheetHeader';

const SheetFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      'flex flex-col-reverse gap-2 border-t border-border p-6 sm:flex-row sm:justify-end',
      className,
    )}
    {...props}
  />
);
SheetFooter.displayName = 'SheetFooter';

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold tracking-tight text-foreground', className)}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetPortal,
  SheetOverlay,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
  sheetVariants,
};
