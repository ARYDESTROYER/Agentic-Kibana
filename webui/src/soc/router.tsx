/**
 * Tiny hash router for the SOC console.
 *
 * Routes are `#/<pageid>`; an unknown/empty hash resolves to `overview`. Navigation
 * options (`{ caseId?, status?, ... }`) are kept in React state next to the page
 * id — they are intentionally NOT serialized into the URL so deep-links stay
 * clean, but they survive an in-app `navigate(page, opts)` call (e.g. a KPI
 * drill-through that pre-seeds a status filter on Cases). A `hashchange` listener
 * keeps back/forward + direct deep-links in sync.
 *
 * Usage:
 *   <RouterProvider><AppShell/></RouterProvider>
 *   const { page, opts, navigate } = useRoute();
 *   navigate('cases', { status: 'open' });
 */
import * as React from 'react';
import { isPageId, type PageId } from './nav';
import type { NavOpts } from '@/lib/types';

export type { PageId } from './nav';

/** Navigation function: switch page, optionally pre-seeding destination state. */
export type Navigate = (page: PageId, opts?: NavOpts) => void;

interface RouteState {
  page: PageId;
  opts?: NavOpts;
  navigate: Navigate;
}

const RouteContext = React.createContext<RouteState | null>(null);

/** Parse `#/<pageid>` from the location hash; unknown/empty → 'overview'. */
export function pageFromHash(): PageId {
  try {
    const raw = (window.location.hash || '').replace(/^#\/?/, '').split(/[?&/]/)[0];
    return isPageId(raw) ? raw : 'overview';
  } catch {
    return 'overview';
  }
}

export const RouterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [page, setPage] = React.useState<PageId>(() => pageFromHash());
  const [opts, setOpts] = React.useState<NavOpts | undefined>(undefined);

  const navigate = React.useCallback<Navigate>((next, nextOpts) => {
    setPage(next);
    setOpts(nextOpts);
    const target = '#/' + next;
    if (window.location.hash !== target) window.location.hash = target;
  }, []);

  React.useEffect(() => {
    const onHashChange = () => {
      const next = pageFromHash();
      setPage((prev) => {
        if (prev === next) return prev;
        // A URL-driven (back/forward/deep-link) navigation has no in-app opts.
        setOpts(undefined);
        return next;
      });
    };
    window.addEventListener('hashchange', onHashChange);
    // Normalise the initial hash so a bare `#` or unknown id reflects the page.
    const initial = '#/' + page;
    if (window.location.hash !== initial) window.location.hash = initial;
    return () => window.removeEventListener('hashchange', onHashChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = React.useMemo<RouteState>(
    () => ({ page, opts, navigate }),
    [page, opts, navigate],
  );

  return <RouteContext.Provider value={value}>{children}</RouteContext.Provider>;
};

/** Access the current route (page + opts) and the navigate function. */
export function useRoute(): RouteState {
  const ctx = React.useContext(RouteContext);
  if (!ctx) {
    throw new Error('useRoute must be used within a <RouterProvider>');
  }
  return ctx;
}

/** Convenience hook returning just the navigate function. */
export function useNavigate(): Navigate {
  return useRoute().navigate;
}
