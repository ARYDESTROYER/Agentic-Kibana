/**
 * RouteMotion — the shell-level route/page transition, bundled with its OWN
 * `MotionProvider` so it can be reached purely through AppShell's DYNAMIC `import()`
 * (progressive enhancement) and therefore never rides onto the eager first-paint graph.
 *
 * AppShell lazy-imports this and mounts it around the routed content only AFTER the first
 * navigation (so the initial landing page never remounts / double-fetches — it keeps its
 * cheap CSS `animate-fade-in`). From the first navigation onward, `PageTransition`'s
 * `AnimatePresence mode="wait"` cross-fades page → page.
 *
 * The lazy pages (CaseDetail, Cases) mount their OWN `MotionProvider` (part of their lazy
 * chunk) so their in-page motion works immediately even on a deep-link/landing — this
 * shell provider governs only the route-swap wrapper. Nested LazyMotion is supported.
 */
import * as React from 'react';
import { MotionProvider } from './provider';
import { PageTransition } from './PageTransition';

export interface RouteMotionProps {
  /** Stable unique key per route (the page id). */
  routeKey: string;
  /** Layout classes for the animated content wrapper (the shell's content inset). */
  className?: string;
  children: React.ReactNode;
}

export function RouteMotion({
  routeKey,
  className,
  children,
}: RouteMotionProps): React.ReactElement {
  return (
    <MotionProvider>
      <PageTransition routeKey={routeKey} className={className}>
        {children}
      </PageTransition>
    </MotionProvider>
  );
}

export default RouteMotion;
