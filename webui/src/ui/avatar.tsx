import * as React from 'react';
import * as AvatarPrimitive from '@radix-ui/react-avatar';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * `size` scale (DESIGN_STANDARD §5.2). The default (`md`) is byte-identical to the
 * pre-Round-5 `h-9 w-9`; `sm`/`lg`/`xl` add the common step sizes so consumers can
 * stop hand-writing `h-7 w-7` / `h-8 w-8` overrides. A `size` prop on the root
 * cascades to the fallback's text size via context.
 */
type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

const avatarVariants = cva('relative flex shrink-0 overflow-hidden rounded-full', {
  variants: {
    size: {
      sm: 'h-7 w-7',
      md: 'h-9 w-9',
      lg: 'h-12 w-12',
      xl: 'h-16 w-16',
    },
  },
  defaultVariants: { size: 'md' },
});

const FALLBACK_TEXT: Record<AvatarSize, string> = {
  sm: 'text-[10px]',
  md: 'text-xs',
  lg: 'text-sm',
  xl: 'text-base',
};

const AvatarSizeContext = React.createContext<AvatarSize>('md');

export interface AvatarProps
  extends React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Root>,
    VariantProps<typeof avatarVariants> {}

const Avatar = React.forwardRef<React.ElementRef<typeof AvatarPrimitive.Root>, AvatarProps>(
  ({ className, size = 'md', ...props }, ref) => (
    <AvatarSizeContext.Provider value={(size ?? 'md') as AvatarSize}>
      <AvatarPrimitive.Root ref={ref} className={cn(avatarVariants({ size }), className)} {...props} />
    </AvatarSizeContext.Provider>
  ),
);
Avatar.displayName = AvatarPrimitive.Root.displayName;

const AvatarImage = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Image>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Image>
>(({ className, ...props }, ref) => (
  <AvatarPrimitive.Image ref={ref} className={cn('aspect-square h-full w-full', className)} {...props} />
));
AvatarImage.displayName = AvatarPrimitive.Image.displayName;

const AvatarFallback = React.forwardRef<
  React.ElementRef<typeof AvatarPrimitive.Fallback>,
  React.ComponentPropsWithoutRef<typeof AvatarPrimitive.Fallback>
>(({ className, ...props }, ref) => {
  const size = React.useContext(AvatarSizeContext);
  return (
    <AvatarPrimitive.Fallback
      ref={ref}
      className={cn(
        'flex h-full w-full items-center justify-center rounded-full bg-muted font-medium text-muted-foreground',
        FALLBACK_TEXT[size],
        className,
      )}
      {...props}
    />
  );
});
AvatarFallback.displayName = AvatarPrimitive.Fallback.displayName;

export { Avatar, AvatarImage, AvatarFallback };
