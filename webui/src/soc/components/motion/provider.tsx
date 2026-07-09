/**
 * provider.tsx — the ONE motion.dev provider for the SOC console.
 *
 * `LazyMotion features={domAnimation} strict` caps the loaded feature-set to
 * ~4.6kb (`m` component) + ~15kb (`domAnimation`: animations, variants, exit,
 * hover/tap/focus) instead of the full ~34kb eager `motion` component — and `strict`
 * THROWS if anyone renders the eager `motion` component under here, which keeps the
 * LazyMotion win intact. App code only ever touches the lightweight `m` (re-exported as
 * `motion` from index.ts), so it always satisfies `strict`. `domAnimation` (NOT `domMax`)
 * is deliberate: we don't use drag/pan or FLIP `layout`/`layoutId` (the smaller bundle).
 *
 * `<MotionConfig reducedMotion="user">` honours the OS "Reduce Motion" setting globally
 * (WCAG-AA): when on, motion.dev auto-disables transform + layout animations but STILL
 * cross-fades `opacity` (motion-sickness-safe, not a jarring instant cut). The existing
 * global CSS `prefers-reduced-motion` reset (styles/theme.css) stays as defense-in-depth
 * for the CSS-keyframe system this provider does not cover.
 *
 * IMPORTANT (bundle budget): this module statically imports `motion/react`, so it must be
 * reached ONLY from lazy chunks (lazy pages that wrap themselves, or AppShell's dynamic
 * `import()` of RouteMotion) — NEVER from the eager App/Login/Wizard/AppShell/NavSidebar
 * import graph, or motion.dev rides onto first paint. See bundle-first-paint.test.ts.
 */
import * as React from 'react';
import { LazyMotion, domAnimation, MotionConfig } from 'motion/react';
import { HOUSE_TRANSITION } from './variants';

export interface MotionProviderProps {
  children: React.ReactNode;
}

/** LazyMotion(domAnimation, strict) + MotionConfig(reducedMotion="user"). */
export function MotionProvider({ children }: MotionProviderProps): React.ReactElement {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user" transition={HOUSE_TRANSITION}>
        {children}
      </MotionConfig>
    </LazyMotion>
  );
}

export default MotionProvider;
