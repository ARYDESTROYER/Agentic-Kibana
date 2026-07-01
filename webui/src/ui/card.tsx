/**
 * Card — the ONE card grammar (DESIGN_STANDARD §3.2 / §5.2).
 *
 * Additive props (all default to the pre-Round-5 look so existing consumers are
 * byte-identical until they opt in):
 *  - `padding`  'sm' | 'md' | 'lg'  → the sanctioned 8px rhythm (p-4 / p-6 / p-8).
 *               `sm` (16) for dense/nested cards; `md` (24) for top-level page /
 *               KPI cards. Replaces the off-grid `px-5` (20). When set on <Card>,
 *               it cascades to CardHeader/CardContent/CardFooter via context so the
 *               whole card shares one rhythm. When UNSET the legacy px-5/py-4/pb-5
 *               padding is preserved exactly.
 *  - `density`  'default' | 'compact'  → compact tightens header/content/footer for
 *               dense surfaces (only meaningful together with `padding`).
 *  - `elevation` 'none' | 'sm'  → 'none' drops the resting shadow (border-first,
 *               DESIGN_STANDARD §3.3); 'sm' keeps `shadow-elev1` (the default look).
 *  - `variant`  'default' | 'flat'  → 'flat' = no border + transparent surface
 *               (filter bars / toolbars that sit on the page, not a raised tile).
 *
 * `CardTitle` renders an `<h3>` and `CardDescription` a `<p>` (was `<div>`) so the
 * card is a real heading/paragraph pair (a11y). Both still accept `className`.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

type CardPadding = 'sm' | 'md' | 'lg';
type CardDensity = 'default' | 'compact';

/** The x/y padding utilities each sub-slot uses for a given padding scale. */
const PADDING_X: Record<CardPadding, string> = { sm: 'px-4', md: 'px-6', lg: 'px-8' };

interface CardContextValue {
  padding?: CardPadding;
  density: CardDensity;
}
const CardContext = React.createContext<CardContextValue>({ padding: undefined, density: 'default' });

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  padding?: CardPadding;
  density?: CardDensity;
  elevation?: 'none' | 'sm';
  variant?: 'default' | 'flat';
}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, padding, density = 'default', elevation = 'sm', variant = 'default', ...props }, ref) => (
    <CardContext.Provider value={{ padding, density }}>
      <div
        ref={ref}
        className={cn(
          'rounded-lg text-card-foreground transition-colors',
          variant === 'flat' ? 'border-0 bg-transparent' : 'border border-border bg-card',
          variant === 'default' && elevation === 'sm' && 'shadow-elev1',
          className,
        )}
        {...props}
      />
    </CardContext.Provider>
  ),
);
Card.displayName = 'Card';

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { padding, density } = React.useContext(CardContext);
    // Legacy (padding unset): keep px-5 py-4 byte-identical.
    const cls = padding
      ? cn(PADDING_X[padding], density === 'compact' ? 'py-3' : 'py-4')
      : 'px-5 py-4';
    return (
      <div ref={ref} className={cn('flex flex-col space-y-1', cls, className)} {...props} />
    );
  },
);
CardHeader.displayName = 'CardHeader';

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, children, ...props }, ref) => {
    // Never emit an EMPTY heading (a11y: jsx-a11y/heading-has-content — an empty
    // <h3> is announced as a blank heading and clutters the AT heading list).
    // When there are no children the title collapses to nothing; callers always
    // pass a title, so this is behavior-identical for every real consumer.
    if (children == null || children === false || children === '') return null;
    return (
      <h3
        ref={ref}
        className={cn('text-base font-semibold leading-tight tracking-tight text-foreground', className)}
        {...props}
      >
        {children}
      </h3>
    );
  },
);
CardTitle.displayName = 'CardTitle';

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn('text-sm text-muted-foreground', className)}
    {...props}
  />
));
CardDescription.displayName = 'CardDescription';

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { padding, density } = React.useContext(CardContext);
    const cls = padding
      ? cn(PADDING_X[padding], density === 'compact' ? 'pb-4' : 'pb-6', 'pt-0')
      : 'px-5 pb-5 pt-0';
    return <div ref={ref} className={cn(cls, className)} {...props} />;
  },
);
CardContent.displayName = 'CardContent';

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => {
    const { padding, density } = React.useContext(CardContext);
    const cls = padding
      ? cn(PADDING_X[padding], density === 'compact' ? 'pb-4' : 'pb-6', 'pt-0')
      : 'px-5 pb-5 pt-0';
    return <div ref={ref} className={cn('flex items-center', cls, className)} {...props} />;
  },
);
CardFooter.displayName = 'CardFooter';

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
