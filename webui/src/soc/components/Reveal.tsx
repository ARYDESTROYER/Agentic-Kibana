/**
 * Reveal — Round-7 W0.1. A one-shot enter animation wrapper.
 *
 * Wraps its children in an element carrying one of the shared `animate-*` keyframes
 * (`fade` → animate-fade-in, `rise` → animate-rise-in, `scale` → animate-scale-in) and
 * an optional `animationDelay`. It is PURE CSS — reduced motion is handled globally by
 * the theme.css reset (which collapses every animation to ~0ms), so there is no JS
 * reduced-motion branch here (unlike `useCountUp`, whose JS tween the reset can't touch).
 *
 * Use for a single element's entrance; use `<Stagger>` when you want a list to cascade.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

export type RevealVariant = 'fade' | 'rise' | 'scale';

export interface RevealProps extends React.HTMLAttributes<HTMLElement> {
  /** Which enter keyframe to play (default `fade`). */
  variant?: RevealVariant;
  /** Delay before the animation starts, in ms. */
  delay?: number;
  /** Element to render as (default `div`). */
  as?: 'div' | 'span' | 'section' | 'li';
  children?: React.ReactNode;
}

const VARIANT_CLASS: Record<RevealVariant, string> = {
  fade: 'animate-fade-in',
  rise: 'animate-rise-in',
  scale: 'animate-scale-in',
};

export function Reveal({
  variant = 'fade',
  delay,
  as = 'div',
  className,
  style,
  children,
  ...rest
}: RevealProps) {
  // React.createElement (like Stagger) — avoids the union-tag JSX typing pitfall.
  return React.createElement(
    as,
    {
      className: cn(VARIANT_CLASS[variant], className),
      style: delay ? { animationDelay: `${delay}ms`, ...style } : style,
      ...rest,
    },
    children,
  );
}

export default Reveal;
