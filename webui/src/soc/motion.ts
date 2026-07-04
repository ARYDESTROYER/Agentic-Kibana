/**
 * motion.ts — Round-7 W0.1 motion constants + the recharts animation helper.
 *
 * ONE place for the app's motion tempo + easing so JS-driven animation (count-up,
 * recharts draw-in) reads the same numbers the CSS `--motion-*` tokens use. Durations
 * are in milliseconds; the easing strings mirror the CSS tokens (`--motion-ease-*`).
 *
 * `chartAnimation(reduced)` returns the recharts animation props for a chart series.
 * recharts only accepts a fixed set of easing keywords (NOT cubic-bezier), so this
 * maps our "premium" curve onto the closest keyword (`ease-out`). Pass the result of
 * `usePrefersReducedMotion()` so charts draw instantly (no animation) when the user
 * has asked for reduced motion.
 *
 * NO recharts import here — the return type is a plain object literal, so importing
 * this module never drags recharts onto the first-paint graph.
 */

/** App-wide motion tempo (ms) + easing curves. Mirrors the `--motion-*` CSS tokens. */
export const MOTION = {
  /** hover/press/focus, toasts, chips (matches --motion-fast). */
  fast: 120,
  /** popover/tooltip/tab-switch/row-expand (matches --motion-base). */
  base: 200,
  /** Sheet/Dialog/drawer enter (matches --motion-slow). */
  slow: 280,
  /** Count-up tween duration — long enough to read the roll, short enough to feel snappy. */
  countUp: 500,
  /** The calm UI easing (matches --motion-ease-standard). */
  easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** The confident entrance curve (matches --motion-ease-premium). */
  easePremium: 'cubic-bezier(0.16, 1, 0.3, 1)',
} as const;

/** The subset of easing keywords recharts understands. */
export type RechartsEasing = 'ease' | 'ease-in' | 'ease-out' | 'ease-in-out' | 'linear';

/** The exact prop shape recharts series accept for animation control. */
export interface ChartAnimationProps {
  isAnimationActive: boolean;
  animationDuration: number;
  animationEasing: RechartsEasing;
}

/**
 * Recharts animation props for a series.
 *
 * @param reduced pass `usePrefersReducedMotion()` — when true the chart snaps to its
 *   final state (no draw-in) and the duration is 0.
 */
export function chartAnimation(reduced: boolean): ChartAnimationProps {
  if (reduced) {
    return { isAnimationActive: false, animationDuration: 0, animationEasing: 'linear' };
  }
  return { isAnimationActive: true, animationDuration: MOTION.base, animationEasing: 'ease-out' };
}
