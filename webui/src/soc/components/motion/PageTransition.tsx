/**
 * PageTransition — the route/page swap wrapper (webui-motion §5.2, the highest-value gap).
 *
 * Today the shell swaps routed content instantly + replays an enter-only
 * `animate-fade-in` on the NEW content; the OUTGOING page just vanishes (CSS cannot play
 * an exit on content that is about to unmount). `AnimatePresence mode="wait"` fills
 * exactly that gap: the outgoing page finishes its exit, THEN the incoming one enters.
 *
 * `key={routeKey}` (the page id) is what tells AnimatePresence the child changed — every
 * direct child of AnimatePresence MUST carry a stable unique key or the exit silently
 * no-ops. Timing/distance come from `pageVariants` (built from the shared MOTION tokens).
 */
import * as React from 'react';
import { AnimatePresence, m } from 'motion/react';
import { pageVariants } from './variants';

export interface PageTransitionProps {
  /** A stable, unique key per route (the page id) — drives the enter/exit swap. */
  routeKey: string;
  /** Layout classes for the animated content wrapper. */
  className?: string;
  children: React.ReactNode;
}

export function PageTransition({
  routeKey,
  className,
  children,
}: PageTransitionProps): React.ReactElement {
  return (
    <AnimatePresence mode="wait">
      <m.div
        key={routeKey}
        className={className}
        variants={pageVariants}
        initial="hidden"
        animate="show"
        exit="exit"
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}

export default PageTransition;
