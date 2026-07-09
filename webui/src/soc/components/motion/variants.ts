/**
 * variants.ts — the ONE source of truth for the motion.dev animation layer's timing,
 * built FROM the existing `soc/motion.ts` `MOTION` tokens so the JS-driven (motion.dev)
 * system and the CSS-keyframe system read the SAME numbers. `MOTION` durations are in
 * milliseconds (mirroring the `--motion-*` CSS tokens); motion.dev transitions want
 * SECONDS, so everything here is converted once via `s()`.
 *
 * Distances stay tiny (4–16px) and we only ever animate `transform` + `opacity`
 * (GPU-composited, 60fps) — per the SOC motion house-style (restraint reads as premium).
 * `MotionConfig reducedMotion="user"` (see provider.tsx) auto-neutralises the transform
 * side of these under OS "Reduce Motion", keeping only the opacity cross-fade.
 */
import type { Transition, Variants } from 'motion/react';
import { MOTION } from '@/soc/motion';

/** ms → s (motion.dev transitions are in seconds; MOTION tokens are in ms). */
const s = (ms: number): number => ms / 1000;

/** cubic-bezier arrays mirroring the CSS `--motion-ease-*` tokens (see soc/motion.ts). */
export const EASE_STANDARD: [number, number, number, number] = [0.2, 0, 0, 1];
export const EASE_PREMIUM: [number, number, number, number] = [0.16, 1, 0.3, 1];

/** The app-wide default transition applied by `<MotionConfig>` (calm base tween). */
export const HOUSE_TRANSITION: Transition = { duration: s(MOTION.base), ease: EASE_PREMIUM };

/** The house spring for interactive / "lands" motion (velocity-aware, low bounce). */
export const HOUSE_SPRING: Transition = { type: 'spring', stiffness: 320, damping: 30, mass: 1 };

/**
 * Route/page transition: content rises 8px + fades in; lifts 8px + fades on exit.
 * Paired with `<AnimatePresence mode="wait">` so the outgoing page finishes before the
 * incoming one enters (the classic route-swap sequence CSS `animate-fade-in` can't do —
 * it is enter-only, no exit).
 */
export const pageVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: s(MOTION.base), ease: EASE_PREMIUM } },
  exit: { opacity: 0, y: -8, transition: { duration: s(MOTION.fast), ease: EASE_STANDARD } },
};

/** CaseDetail tab body: a smaller (6px), faster fade+rise on each tab switch. */
export const tabVariants: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: s(MOTION.base), ease: EASE_PREMIUM } },
  exit: { opacity: 0, y: -6, transition: { duration: s(MOTION.fast), ease: EASE_STANDARD } },
};

/**
 * Cases bulk-action bar: springs up from below on select; slides back down + fades on
 * exit (today it just VANISHES with no exit — the exact gap `AnimatePresence` fills).
 */
export const bulkBarVariants: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0, transition: HOUSE_SPRING },
  exit: { opacity: 0, y: 16, transition: { duration: s(MOTION.base), ease: EASE_STANDARD } },
};

/**
 * The DecisionCard "verdict lands" one-shot: a restrained scale-settle that reinforces
 * the #3 trust story — the deterministic decision is COMPUTED, not guessed. One-shot on
 * mount only (never a loop); reduced motion drops the scale, keeps the fade.
 */
export const verdictLandVariants: Variants = {
  hidden: { opacity: 0, scale: 0.94 },
  show: { opacity: 1, scale: 1, transition: HOUSE_SPRING },
};
