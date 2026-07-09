/**
 * TabTransition — the CaseDetail tab-body motion (webui-motion §5.5).
 *
 * The 6 CaseDetail tabs stay as real Radix `<TabsContent>` (they carry the
 * `role="tabpanel"` + `aria-labelledby` wiring AND the lazy per-tab data fetch, both of
 * which we must NOT regress — so we do NOT `forceMount` all six). Radix mounts only the
 * ACTIVE panel and unmounts the previous one instantly.
 *
 * HONEST SCOPE (motion #2): this is an ENTER-ONLY transition, NOT a cross-fade. Because
 * only one panel is ever mounted at a time (no outgoing panel is co-rendered), the two
 * panels cannot dissolve into each other, and there is no `AnimatePresence`/`exit` here —
 * a JS animation layer can't cross-fade a panel that Radix has already unmounted. It also
 * does NOT smooth the tab-to-tab height change (no `layout`/height animation). What it
 * DOES do is replace the old enter-only `animate-fade-in` CSS class with a tasteful
 * "the tab landed" fade+rise on each panel mount, using the shared `tabVariants` timing.
 * Reduced motion (via `MotionConfig reducedMotion="user"`) keeps only the fade.
 */
import * as React from 'react';
import { m } from 'motion/react';
import { tabVariants } from './variants';

export interface TabPanelMotionProps {
  className?: string;
  children: React.ReactNode;
}

/** A single tab body wrapper: an enter-only fade+rise each time Radix mounts the active panel. */
export function TabPanelMotion({ className, children }: TabPanelMotionProps): React.ReactElement {
  return (
    <m.div className={className} variants={tabVariants} initial="hidden" animate="show">
      {children}
    </m.div>
  );
}

export default TabPanelMotion;
