/**
 * NavSidebar + useNavPrefs coverage (Round-3 Stage 2, Group 1 — shell/nav).
 *
 * Pins the two load-bearing behaviours of the expandable hamburger nav:
 *
 *   1. WAI-ARIA DISCLOSURE semantics — an item WITH children renders a toggle button
 *      carrying `aria-expanded` + `aria-controls` pointing at a child `<ul>` that
 *      appears only when expanded; the active leaf carries `aria-current="page"`.
 *      (We deliberately do NOT use role="tree" — disclosure is the correct model.)
 *
 *   2. COLLAPSE PERSISTENCE — `useNavPrefs` hydrates the collapsed flag + open-group
 *      set SYNCHRONOUSLY from a localStorage mirror (so there is no first-paint
 *      flash), and every toggle writes BOTH the localStorage mirror AND PUT
 *      /api/prefs/user (so the choice follows the user across devices).
 *
 * The auth + prefs contexts and the low-level api module are mocked so the test is a
 * pure unit of the sidebar + the persistence hook.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

/* ---- Mocks ---------------------------------------------------------------- */

// RBAC: grant everything (mirrors auth/RBAC OFF — the full nav shows).
vi.mock('../../auth', () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

// Prefs: a settled, empty cascade (no server-side misc overrides) by default. The
// `misc` field is read by useNavPrefs to reconcile the persisted collapse state.
const prefsState = { ready: true, misc: {} as Record<string, unknown> };
vi.mock('../../prefs', () => ({
  usePrefs: () => ({ prefs: { misc: prefsState.misc }, ready: prefsState.ready }),
}));

// Low-level api — capture the persistence PUTs.
const putUser = vi.fn(() => Promise.resolve({}));
vi.mock('@/lib/api', () => ({
  api: { prefs: { putUser: (...a: unknown[]) => putUser(...a) } },
}));

import { NavSidebar, useNavPrefs } from '../NavSidebar';

/* ---- Helpers -------------------------------------------------------------- */

const noop = () => {};

function renderExpanded(
  overrides: Partial<React.ComponentProps<typeof NavSidebar>> = {},
) {
  const onNavigate = vi.fn();
  const onToggleGroup = vi.fn();
  const onOpenGroup = vi.fn();
  const utils = render(
    <TooltipProvider>
      <NavSidebar
        page="overview"
        onNavigate={onNavigate}
        collapsed={false}
        openGroups={new Set<string>()}
        onToggleGroup={onToggleGroup}
        onOpenGroup={onOpenGroup}
        {...overrides}
      />
    </TooltipProvider>,
  );
  return { onNavigate, onToggleGroup, onOpenGroup, ...utils };
}

beforeEach(() => {
  localStorage.clear();
  putUser.mockClear();
  prefsState.ready = true;
  prefsState.misc = {};
});

/* ---- Disclosure semantics ------------------------------------------------- */

describe('NavSidebar — WAI-ARIA disclosure', () => {
  it('renders a parent with children as a collapsed disclosure (aria-expanded=false, no panel)', () => {
    renderExpanded();
    // The Overview host has children {Dashboard, Standup}; its disclosure toggle.
    const toggle = screen.getByRole('button', { name: /expand overview/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const panelId = toggle.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    // Closed → the controlled panel is not in the DOM, so children are absent.
    expect(document.getElementById(panelId as string)).toBeNull();
  });

  it('reveals the child list (the aria-controls panel) when the group is open', () => {
    renderExpanded({ openGroups: new Set(['overview']) });
    const toggle = screen.getByRole('button', { name: /collapse overview/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panelId = toggle.getAttribute('aria-controls') as string;
    const panel = document.getElementById(panelId);
    expect(panel).not.toBeNull();
    // The disclosed panel lists the child destinations.
    expect(screen.getByRole('button', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Standup' })).toBeInTheDocument();
  });

  it('toggling the disclosure chevron calls onToggleGroup (does not navigate)', () => {
    const { onToggleGroup, onNavigate } = renderExpanded();
    fireEvent.click(screen.getByRole('button', { name: /expand overview/i }));
    expect(onToggleGroup).toHaveBeenCalledWith('overview');
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('marks the active leaf with aria-current=page and auto-opens its group', () => {
    // When the current page is a CHILD (standup), that group is open + the child is current.
    const { onOpenGroup } = renderExpanded({
      page: 'standup',
      openGroups: new Set(['overview']),
    });
    const child = screen.getByRole('button', { name: 'Standup' });
    expect(child).toHaveAttribute('aria-current', 'page');
    // Navigating into a sibling child auto-opens the owning group.
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(onOpenGroup).toHaveBeenCalledWith('overview');
  });

  it('renders a childless item as a direct link with no disclosure toggle', () => {
    renderExpanded();
    // Cases has no children → a single nav button, no expand/collapse control.
    expect(screen.getByRole('button', { name: 'Cases' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /expand cases/i })).toBeNull();
  });

  // A nav landmark must mark exactly ONE current page. For a host whose OWN id is
  // ALSO one of its children (Analytics→metrics, Workspace→chat, Notifications→inbox),
  // the open child leaf is the single canonical aria-current marker — the parent host
  // button must NOT also claim it. The earlier tests only used overview/standup where
  // host id != child id, so they never caught this duplicate.
  it('emits exactly one aria-current=page for a host whose id equals a child id (Analytics→Metrics)', () => {
    renderExpanded({ page: 'metrics', openGroups: new Set(['metrics']) });
    // Exactly one current-page marker in the whole landmark.
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    // …and it rides the CHILD leaf, not the parent host label.
    expect(screen.getByRole('button', { name: 'Metrics' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Analytics' })).not.toHaveAttribute('aria-current');
  });

  it('emits exactly one aria-current=page for Workspace→Chat (shared id)', () => {
    renderExpanded({ page: 'chat', openGroups: new Set(['chat']) });
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Chat' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Workspace' })).not.toHaveAttribute('aria-current');
  });

  it('clicking the parent label navigates AND opens its group (per the documented contract)', () => {
    // Overview host group is closed (default openGroups=empty). Click the parent LABEL
    // (the first 'Overview' button — the primary destination), not the chevron.
    const { onNavigate, onOpenGroup } = renderExpanded();
    const labels = screen.getAllByRole('button', { name: 'Overview' });
    const parentLabel = labels[0];
    fireEvent.click(parentLabel);
    expect(onNavigate).toHaveBeenCalledWith('overview');
    expect(onOpenGroup).toHaveBeenCalledWith('overview');
  });
});

/* ---- Collapsed icon-rail --------------------------------------------------- */

describe('NavSidebar — collapsed icon rail', () => {
  it('keeps child destinations reachable via a fly-out (no aria-controls panel inline)', () => {
    renderExpanded({ collapsed: true, page: 'standup' });
    // The collapsed parent icon-button is labelled but has no expand/collapse toggle.
    expect(screen.getByRole('button', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /expand overview/i })).toBeNull();
  });
});

/* ---- useNavPrefs persistence ---------------------------------------------- */

/** Mounts the hook and surfaces its state + actions through buttons/markers. */
const PrefsHarness: React.FC = () => {
  const { collapsed, toggleCollapsed, openGroups, toggleGroup } = useNavPrefs();
  return (
    <div>
      <span data-testid="collapsed">{String(collapsed)}</span>
      <span data-testid="open">{Array.from(openGroups).join(',')}</span>
      <button onClick={toggleCollapsed}>toggle-collapsed</button>
      <button onClick={() => toggleGroup('overview')}>toggle-overview</button>
    </div>
  );
};

describe('useNavPrefs — synchronous hydration + dual persistence', () => {
  it('hydrates the collapsed flag synchronously from the localStorage mirror (no flash)', () => {
    localStorage.setItem('soc.nav.collapsed', '1');
    render(<PrefsHarness />);
    // The very first render already reflects the mirror — no false→true flicker.
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
  });

  it('hydrates the open-group set synchronously from the mirror', () => {
    localStorage.setItem('soc.nav.openGroups', JSON.stringify(['overview', 'settings']));
    render(<PrefsHarness />);
    expect(screen.getByTestId('open').textContent).toBe('overview,settings');
  });

  it('persists a collapse toggle to BOTH localStorage and PUT /api/prefs/user', () => {
    render(<PrefsHarness />);
    act(() => {
      fireEvent.click(screen.getByText('toggle-collapsed'));
    });
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
    expect(localStorage.getItem('soc.nav.collapsed')).toBe('1');
    expect(putUser).toHaveBeenCalledWith({ misc: { nav_collapsed: true } });
  });

  it('persists an open-group toggle to BOTH localStorage and the server', () => {
    render(<PrefsHarness />);
    act(() => {
      fireEvent.click(screen.getByText('toggle-overview'));
    });
    expect(screen.getByTestId('open').textContent).toBe('overview');
    expect(JSON.parse(localStorage.getItem('soc.nav.openGroups') as string)).toEqual([
      'overview',
    ]);
    expect(putUser).toHaveBeenCalledWith({ misc: { nav_open_groups: ['overview'] } });
  });

  it('reconciles from the server misc bucket once prefs hydrate', () => {
    // No local mirror; the server says collapsed + a group open.
    prefsState.misc = { nav_collapsed: true, nav_open_groups: ['settings'] };
    render(<PrefsHarness />);
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
    expect(screen.getByTestId('open').textContent).toBe('settings');
  });

  it('does not clobber a collapse toggle made before the prefs cascade hydrates', () => {
    prefsState.ready = false; // hydration still in flight
    prefsState.misc = { nav_collapsed: false }; // server snapshot says expanded
    const { rerender } = render(<PrefsHarness />);
    expect(screen.getByTestId('collapsed').textContent).toBe('false');
    act(() => {
      fireEvent.click(screen.getByText('toggle-collapsed'));
    }); // user collapses during the window
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
    expect(putUser).toHaveBeenCalledWith({ misc: { nav_collapsed: true } });
    // Cascade now settles with the (stale) server value still false → reconcile fires.
    prefsState.ready = true;
    act(() => {
      rerender(<PrefsHarness />);
    });
    // The just-made toggle must NOT be reverted by the reconcile.
    expect(screen.getByTestId('collapsed').textContent).toBe('true');
  });

  it('does not clobber an open-group toggle made before the cascade hydrates', () => {
    prefsState.ready = false;
    prefsState.misc = { nav_open_groups: ['settings'] }; // server holds a different set
    const { rerender } = render(<PrefsHarness />);
    expect(screen.getByTestId('open').textContent).toBe('');
    act(() => {
      fireEvent.click(screen.getByText('toggle-overview'));
    });
    expect(screen.getByTestId('open').textContent).toBe('overview');
    prefsState.ready = true;
    act(() => {
      rerender(<PrefsHarness />);
    });
    // The user's in-window open survives; the stale server set does not overwrite it.
    expect(screen.getByTestId('open').textContent).toBe('overview');
  });
});
