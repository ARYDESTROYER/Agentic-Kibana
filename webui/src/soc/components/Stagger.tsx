/**
 * Stagger — reveal a list of children with a cascading rise-in.
 *
 * Each direct child is wrapped and given an incremental `animation-delay`, using
 * the shared `animate-rise-in` keyframes. Reduced-motion is honored globally by
 * the app CSS (it neutralises the animation), so we don't branch on it here.
 */
import * as React from 'react';
import { cn } from '@/lib/cn';

export interface StaggerProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Per-item delay step, in milliseconds. */
  step?: number;
  /** Initial delay before the first item, in milliseconds. */
  initialDelay?: number;
  /** Cap the cumulative delay so long lists don't lag (ms). */
  maxDelay?: number;
  /** Render as a different element (e.g. 'ul'). Defaults to 'div'. */
  as?: 'div' | 'ul' | 'ol' | 'section';
  /** Wrapper element for each item. Defaults to 'div'. */
  itemAs?: 'div' | 'li';
  /** Extra classes on each item wrapper (e.g. `h-full` for equal-height grids). */
  itemClassName?: string;
  children?: React.ReactNode;
}

export const Stagger = React.forwardRef<HTMLDivElement, StaggerProps>(
  (
    {
      className,
      step = 60,
      initialDelay = 0,
      maxDelay = 600,
      as: As = 'div',
      itemAs: ItemAs = 'div',
      itemClassName,
      children,
      ...props
    },
    ref,
  ) => {
    const items = React.Children.toArray(children);
    const wrapped = items.map((child, i) => {
      const delay = Math.min(initialDelay + i * step, maxDelay);
      const key = (React.isValidElement(child) && child.key != null ? child.key : i) as React.Key;
      return React.createElement(
        ItemAs,
        {
          key,
          className: cn('animate-rise-in', itemClassName),
          style: { animationDelay: `${delay}ms` },
        },
        child,
      );
    });
    return React.createElement(As, { ref, className, ...props }, wrapped);
  },
);
Stagger.displayName = 'Stagger';
