/**
 * useCountUp — Round-7 W0.1. A tiny rAF hook that rolls an integer from its PREVIOUS
 * value up (or down) to a new value on change.
 *
 * Design rules (DESIGN_DIRECTION §Motion):
 *   - Tween PREV → NEW, never 0 → N. The first mount renders the value STATICALLY
 *     (no tween) so a page-load isn't a wall of rolling numbers; only a real change
 *     afterwards animates. The change is detected via a ref (not state), so a re-render
 *     with the same value never replays.
 *   - INTEGERS ONLY. The caller must pass an integer metric (counts) — money / % are
 *     excluded from count-up. Each frame is rounded, and the value passed to `format`
 *     is always an integer.
 *   - Skips the tween (snaps) when the tab is hidden (`document.hidden`), so a
 *     background poll doesn't burn rAF frames animating off-screen.
 *   - Its OWN reduced-motion guard: `usePrefersReducedMotion()` AND a `window.matchMedia`
 *     presence check (the hook returns `false` when matchMedia is absent, so we also
 *     require matchMedia to exist before animating). The global CSS reduced-motion reset
 *     does NOT cover JS tweens, hence this explicit branch.
 *
 * Returns the CURRENT value already run through `format` (default `String`).
 */
import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from './usePrefersReducedMotion';
import { MOTION } from '../motion';

export interface UseCountUpOptions {
  /** Tween duration in ms (default `MOTION.countUp` = 500). */
  duration?: number;
  /** Formatter for the displayed integer (default `String`). */
  format?: (n: number) => string;
}

const defaultFormat = (n: number): string => String(n);

/** easeOutCubic — decelerating, matches the "premium" feel without a keyframe. */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

export function useCountUp(value: number, options: UseCountUpOptions = {}): string {
  const { duration = MOTION.countUp, format = defaultFormat } = options;
  const reduced = usePrefersReducedMotion();

  // The target is always a finite integer.
  const target = Number.isFinite(value) ? Math.round(value) : 0;

  const settledRef = useRef(target); // the last value we tweened TO (start of the next tween)
  const mountedRef = useRef(false); // first mount renders static
  const rafRef = useRef<number | null>(null);
  const [display, setDisplay] = useState(target);

  useEffect(() => {
    // First mount: render statically, seed the ref, never tween 0 → N.
    if (!mountedRef.current) {
      mountedRef.current = true;
      settledRef.current = target;
      setDisplay(target);
      return;
    }

    const from = settledRef.current;
    const to = target;
    settledRef.current = to;

    // No real change → nothing to animate (guards against a same-value re-render).
    if (from === to) {
      setDisplay(to);
      return;
    }

    // Snap (no tween) under reduced motion, no matchMedia, a hidden tab, or no rAF.
    const motionOff = reduced || !hasMatchMedia();
    const hidden = typeof document !== 'undefined' && document.hidden;
    const noRaf =
      typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function';
    if (motionOff || hidden || noRaf) {
      setDisplay(to);
      return;
    }

    let start: number | null = null;
    const tick = (ts: number) => {
      if (start === null) start = ts;
      const t = duration <= 0 ? 1 : Math.min(1, (ts - start) / duration);
      const current = Math.round(from + (to - from) * easeOutCubic(t));
      setDisplay(current);
      if (t < 1) {
        rafRef.current = window.requestAnimationFrame(tick);
      } else {
        setDisplay(to);
        rafRef.current = null;
      }
    };
    rafRef.current = window.requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [target, duration, reduced]);

  return format(display);
}
