/**
 * The public motion.dev surface for the SOC console (webui-motion §6.2).
 *
 * App code imports from HERE — never from `motion/react` directly — so:
 *   - it always uses the lightweight `m` component (re-exported as `motion`), satisfying
 *     the provider's `LazyMotion … strict`, and
 *   - every import site is one that a grep can audit for the "no motion on the eager
 *     first-paint chain" invariant (bundle-first-paint.test.ts).
 *
 * Only LAZY chunks (lazy pages that wrap themselves in `<MotionProvider>`, plus AppShell's
 * dynamic `import()` of RouteMotion) may import this module — importing it statically from
 * the eager App/Login/Wizard/AppShell/NavSidebar graph would drag motion.dev onto first
 * paint.
 */
export {
  m as motion,
  AnimatePresence,
  useReducedMotion,
  useSpring,
  useTransform,
  useMotionValue,
  useInView,
} from 'motion/react';

export { MotionProvider } from './provider';
export { PageTransition } from './PageTransition';
export { RouteMotion } from './RouteMotion';
export { TabPanelMotion } from './TabTransition';
export { AnimatedNumber } from './AnimatedNumber';
export * from './variants';
