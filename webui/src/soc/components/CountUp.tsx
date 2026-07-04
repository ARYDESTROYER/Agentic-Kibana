/**
 * CountUp — Round-7 W0.1. Renders an integer that rolls from its previous value to a
 * new value on change (via `useCountUp`). Static on first mount; snaps under reduced
 * motion / hidden tab. INTEGERS ONLY — do not use for money or percentages.
 *
 * All output is plain text (the number run through `format`), so it is UNTRUSTED-safe
 * by construction (#9) — though in practice these are deterministic engine counts.
 */
import * as React from 'react';
import { useCountUp } from '../hooks/useCountUp';

export interface CountUpProps {
  /** The integer target value. */
  value: number;
  /** Formatter for the displayed integer (default `String`). */
  format?: (n: number) => string;
  /** Tween duration in ms (default `MOTION.countUp`). */
  duration?: number;
  className?: string;
  /** Element to render as (default `span`). */
  as?: 'span' | 'div' | 'strong' | 'p';
}

export function CountUp({ value, format, duration, className, as = 'span' }: CountUpProps) {
  const display = useCountUp(value, { format, duration });
  // React.createElement (like Stagger) — avoids the union-tag JSX typing pitfall.
  return React.createElement(as, { className, 'data-testid': 'count-up' }, display);
}

export default CountUp;
