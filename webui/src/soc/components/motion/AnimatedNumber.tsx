/**
 * AnimatedNumber — the free `useSpring` + `useTransform` count-up (NOT the paid Motion+
 * `AnimateNumber`). A spring-driven number roll for KPI / count figures that says "the
 * metric is live" (webui-motion §5.5 / research §e).
 *
 * The spring is initialised AT the first value (never a 0 → N roll on mount, matching the
 * existing `useCountUp` contract); a later `value` change animates via `spring.set`. The
 * display updates the DOM text node directly through a MotionValue — no React re-render
 * per frame.
 *
 * ACCESSIBILITY: under OS "Reduce Motion" (`useReducedMotion()`), it renders the plain
 * formatted value with NO roll (snaps) — `MotionConfig reducedMotion="user"` alone can't
 * neutralise a JS-driven MotionValue tween, so we branch explicitly (same reasoning as
 * the CSS-reset-can't-reach-rAF guard in `useCountUp`).
 */
import * as React from 'react';
import { useReducedMotion, useSpring, useTransform, m } from 'motion/react';

export interface AnimatedNumberProps {
  /** The target integer to roll to. Non-finite values are treated as 0. */
  value: number;
  /** Formats the (rounded, integer) display value. Default: `toLocaleString()`. */
  format?: (n: number) => string;
  className?: string;
}

const defaultFormat = (n: number): string => n.toLocaleString();

export function AnimatedNumber({
  value,
  format = defaultFormat,
  className,
}: AnimatedNumberProps): React.ReactElement {
  const reduce = useReducedMotion();
  const target = Number.isFinite(value) ? value : 0;
  // Initialised AT the target → no 0 → N roll on first mount; a later change animates.
  const spring = useSpring(target, { mass: 0.8, stiffness: 75, damping: 15 });
  const display = useTransform(spring, (v) => format(Math.round(v)));

  React.useEffect(() => {
    spring.set(target);
  }, [spring, target]);

  // Reduced motion: snap to the final formatted value, no roll.
  if (reduce) {
    return <span className={className}>{format(Math.round(target))}</span>;
  }
  return <m.span className={className}>{display}</m.span>;
}

export default AnimatedNumber;
