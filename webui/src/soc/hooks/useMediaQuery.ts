/**
 * useMediaQuery — SSR-safe subscription to a single CSS media query.
 *
 * Round-5 W0-B B5: the reactive counterpart to the one-shot `matchMedia` reads scattered
 * across the app. Uses `useSyncExternalStore` so the value is correct on the first paint
 * (no post-mount flash), stays in sync as the viewport / preference changes, and returns
 * a stable server snapshot (`false`) under SSR / jsdom without `matchMedia`.
 *
 * `useIsMobile()` is the shared breakpoint helper: true below the Tailwind `md` breakpoint
 * (<768px), i.e. `(max-width: 767.98px)`.
 */
import { useCallback, useSyncExternalStore } from 'react';

/** Tailwind `md` breakpoint minus a hair, so it flips at exactly <768px. */
export const MOBILE_QUERY = '(max-width: 767.98px)';

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {};
      const mql = window.matchMedia(query);
      // `addEventListener` is the modern API; guard for older engines that only expose
      // the deprecated `addListener`.
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        return () => mql.removeEventListener('change', onChange);
      }
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    },
    [query],
  );

  const getSnapshot = useCallback(
    () => (hasMatchMedia() ? window.matchMedia(query).matches : false),
    [query],
  );

  // Server / no-matchMedia: default to the "not matching" snapshot.
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** True below the Tailwind `md` breakpoint (viewport < 768px). */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}
