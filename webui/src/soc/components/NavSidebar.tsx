/**
 * NavSidebar — the SOC console's single left navigation surface (Round-3 Stage 2).
 *
 * ONE sidebar with TWO width states, toggled by the shell's hamburger button (and
 * Cmd/Ctrl+B):
 *   - EXPANDED (~248px): a labelled drawer. A top-level item WITH children renders
 *     as a WAI-ARIA DISCLOSURE — a `<button aria-expanded aria-controls>` with a
 *     rotating ChevronRight that expands/collapses a `<ul>` of child links. Tapping
 *     the parent label itself navigates to the host page (its primary destination)
 *     AND opens the group; the chevron is a separate toggle so the destination is
 *     never hidden behind the disclosure. An item WITHOUT children is a direct link.
 *   - COLLAPSED (64px): an icon rail. A childless item is a tooltip'd icon button; an
 *     item WITH children opens an INLINE fly-out (shown on pointer hover OR keyboard
 *     focus-within, via CSS group state) listing the children so the destinations are
 *     never hidden AND stay keyboard-reachable (Tab moves from the rail button into the
 *     in-flow child links — a portaled HoverCard would drop them from the tab order).
 *     The active trail is marked on the collapsed parent (a primary side-bar + tint),
 *     and `aria-current="page"` rides the active leaf both in the rail and inside the
 *     fly-out.
 *
 * We deliberately use the DISCLOSURE pattern (button + aria-expanded), NOT
 * role="tree": these are page links, not a hierarchical data tree, so disclosure is
 * the correct, lower-friction a11y model.
 *
 * RBAC: items + children carry an optional `perm`; they are filtered out for users
 * lacking the grant (with auth/RBAC off, `hasPermission()` is always true → full nav).
 *
 * SECURITY: every label is a STATIC, in-repo string (nav.ts) — not user data — so
 * there is no #9 surface here; we still render everything as plain text.
 *
 * PERSISTENCE: the `{nav_collapsed, nav_open_groups}` state lives in the shell via
 * `useNavPrefs` (exported here): it hydrates SYNCHRONOUSLY from a localStorage mirror
 * (mirroring the theme pre-hydration approach to avoid a collapse flash on first
 * paint), then reconciles with the server-side UserPrefs.misc on mount and persists
 * every change to both localStorage and PUT /api/prefs/user.
 */
import * as React from 'react';
import { ChevronRight, Shield, type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { Separator } from '@/ui/separator';
import { cn } from '@/lib/cn';
import { api } from '@/lib/api';
import { useAuth } from '../auth';
import { usePrefs } from '../prefs';
import {
  NAV_GROUPS,
  navParentOf,
  type NavChild,
  type NavGroup,
  type NavItem,
  type PageId,
} from '../nav';
import type { Navigate } from '../router';

/* -------------------------------------------------------------------------- */
/* Persistence: nav collapse + open-group state (shell-owned, exported hook).  */
/* -------------------------------------------------------------------------- */

const LS_COLLAPSED = 'soc.nav.collapsed';
const LS_OPEN_GROUPS = 'soc.nav.openGroups';
/** UserPrefs.misc keys the server mirror writes/reads (Round-3). */
const MISC_COLLAPSED = 'nav_collapsed';
const MISC_OPEN_GROUPS = 'nav_open_groups';

function readBool(key: string): boolean {
  try {
    return window.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

function readStringList(key: string): string[] {
  try {
    const raw = window.localStorage?.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeMirror(key: string, value: string): void {
  try {
    window.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export interface NavPrefsValue {
  collapsed: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (v: boolean) => void;
  /** The set of currently-expanded disclosure-group ids (by host PageId). */
  openGroups: Set<string>;
  toggleGroup: (id: string) => void;
  /** Open a group without toggling (used when navigating into a child). */
  openGroup: (id: string) => void;
}

/**
 * Shell-owned nav collapse + open-group state. Reads the localStorage mirror
 * SYNCHRONOUSLY in the initializers (no first-paint flash), then — once the
 * effective prefs have hydrated — reconciles from the server `misc` bucket. Every
 * mutation writes BOTH the localStorage mirror and PUT /api/prefs/user (best-effort).
 */
export function useNavPrefs(): NavPrefsValue {
  const { prefs, ready } = usePrefs();
  const [collapsed, setCollapsedState] = React.useState<boolean>(() => readBool(LS_COLLAPSED));
  const [openGroups, setOpenGroups] = React.useState<Set<string>>(
    () => new Set(readStringList(LS_OPEN_GROUPS)),
  );
  // Reconcile from the server exactly once, after the cascade hydrates. The local
  // mirror is authoritative for the FIRST paint; the server value (if present) wins
  // once known, so the choice follows the user across devices — EXCEPT a key the user
  // deliberately toggled before hydration finished. Such an in-window toggle was ALSO
  // PUT to the server, so it is the value a later device load reconciles to anyway;
  // honouring it here just avoids snapping the local UI back to a stale snapshot.
  const reconciled = React.useRef(false);
  const touched = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!ready || reconciled.current) return;
    reconciled.current = true;
    const misc = (prefs.misc ?? {}) as Record<string, unknown>;
    if (!touched.current.has(MISC_COLLAPSED) && typeof misc[MISC_COLLAPSED] === 'boolean') {
      setCollapsedState(misc[MISC_COLLAPSED] as boolean);
    }
    if (!touched.current.has(MISC_OPEN_GROUPS)) {
      const groups = misc[MISC_OPEN_GROUPS];
      if (Array.isArray(groups)) {
        setOpenGroups(new Set(groups.filter((g): g is string => typeof g === 'string')));
      }
    }
  }, [ready, prefs.misc]);

  const persistMisc = React.useCallback((patch: Record<string, unknown>) => {
    void api.prefs
      .putUser({ misc: patch })
      .catch(() => undefined);
  }, []);

  const setCollapsed = React.useCallback(
    (v: boolean) => {
      touched.current.add(MISC_COLLAPSED);
      setCollapsedState(v);
      writeMirror(LS_COLLAPSED, v ? '1' : '0');
      persistMisc({ [MISC_COLLAPSED]: v });
    },
    [persistMisc],
  );

  const toggleCollapsed = React.useCallback(() => {
    touched.current.add(MISC_COLLAPSED);
    setCollapsedState((prev) => {
      const next = !prev;
      writeMirror(LS_COLLAPSED, next ? '1' : '0');
      persistMisc({ [MISC_COLLAPSED]: next });
      return next;
    });
  }, [persistMisc]);

  const commitGroups = React.useCallback(
    (next: Set<string>) => {
      touched.current.add(MISC_OPEN_GROUPS);
      const list = Array.from(next);
      writeMirror(LS_OPEN_GROUPS, JSON.stringify(list));
      persistMisc({ [MISC_OPEN_GROUPS]: list });
    },
    [persistMisc],
  );

  const toggleGroup = React.useCallback(
    (id: string) => {
      setOpenGroups((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        commitGroups(next);
        return next;
      });
    },
    [commitGroups],
  );

  const openGroup = React.useCallback(
    (id: string) => {
      setOpenGroups((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        commitGroups(next);
        return next;
      });
    },
    [commitGroups],
  );

  return React.useMemo<NavPrefsValue>(
    () => ({ collapsed, toggleCollapsed, setCollapsed, openGroups, toggleGroup, openGroup }),
    [collapsed, toggleCollapsed, setCollapsed, openGroups, toggleGroup, openGroup],
  );
}

/* -------------------------------------------------------------------------- */
/* RBAC filtering.                                                            */
/* -------------------------------------------------------------------------- */

type HasPerm = (resource: string, action: string) => boolean;

/** Filter a group's items + their children by the caller's grants; drop empties. */
function filterGroups(groups: NavGroup[], has: HasPerm): NavGroup[] {
  return groups
    .map((g) => ({
      ...g,
      items: g.items
        .filter((it) => !it.perm || has(it.perm.resource, it.perm.action))
        .map((it) => ({
          ...it,
          children: (it.children ?? []).filter(
            (c) => !c.perm || has(c.perm.resource, c.perm.action),
          ),
        })),
    }))
    .filter((g) => g.items.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Leaf link primitives.                                                      */
/* -------------------------------------------------------------------------- */

/** A child row inside an expanded disclosure group. */
const ChildLink: React.FC<{
  child: NavChild;
  active: boolean;
  onSelect: () => void;
}> = ({ child, active, onSelect }) => {
  const Icon = child.icon;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        data-testid={`nav-${child.id}`}
        className={cn(
          // min-h-8 (32px) keeps the leaf row ≥24px for WCAG 2.2 §2.5.8 (target size).
          'flex min-h-8 w-full items-center gap-2.5 rounded-md py-1.5 pl-9 pr-2 text-left text-sm transition-colors',
          // scroll-my-1 keeps a focused row off the scroll-container edge so its focus
          // ring is never clipped when keyboard focus scrolls it into view (§2.4.11).
          'scroll-my-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active
            ? 'bg-primary/10 font-medium text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        )}
      >
        {Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
        <span className="truncate">{child.label}</span>
      </button>
    </li>
  );
};

/* -------------------------------------------------------------------------- */
/* Expanded (labelled) rendering.                                            */
/* -------------------------------------------------------------------------- */

const ExpandedItem: React.FC<{
  item: NavItem;
  page: PageId;
  open: boolean;
  onNavigate: (id: PageId) => void;
  onToggleGroup: (id: string) => void;
}> = ({ item, page, open, onNavigate, onToggleGroup }) => {
  const Icon = item.icon as LucideIcon;
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  // Active when this item or any of its children is the current page.
  const childActive = children.some((c) => c.id === page);
  const selfActive = page === item.id;
  const trailActive = selfActive || childActive;
  // A host whose OWN id is ALSO one of its children (chat/metrics/inbox) renders the
  // shared-id child link as the single canonical `aria-current="page"` marker, so the
  // parent button must NOT also claim it (a nav landmark must have exactly one current
  // page). The open child <ul> always carries the marker, so active state is never lost.
  const idIsAlsoChild = children.some((c) => c.id === item.id);
  const panelId = `nav-group-${item.id}`;

  if (!hasChildren) {
    return (
      <li>
        <button
          type="button"
          onClick={() => onNavigate(item.id)}
          aria-current={selfActive ? 'page' : undefined}
          data-testid={`nav-${item.id}`}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
            // scroll-my-1: keep a focused leaf off the scroll edge (§2.4.11).
            'scroll-my-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            selfActive
              ? 'bg-primary text-primary-foreground shadow-glow'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{item.label}</span>
        </button>
      </li>
    );
  }

  return (
    <li>
      <div
        className={cn(
          'flex items-center rounded-md transition-colors',
          trailActive && !open ? 'bg-primary/[0.06]' : '',
        )}
      >
        {/* Primary destination — navigating ALSO opens the group (destinations are
            never hidden behind the disclosure). */}
        <button
          type="button"
          onClick={() => onNavigate(item.id)}
          aria-current={selfActive && !idIsAlsoChild ? 'page' : undefined}
          data-testid={`nav-${item.id}`}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
            'scroll-my-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            trailActive
              ? 'font-medium text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon
            className={cn('h-4 w-4 shrink-0', trailActive ? 'text-primary' : '')}
            aria-hidden
          />
          <span className="truncate">{item.label}</span>
        </button>
        {/* Disclosure toggle (WAI-ARIA): aria-expanded + aria-controls + rotating chevron. */}
        <button
          type="button"
          onClick={() => onToggleGroup(item.id)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${item.label}`}
          className={cn(
            'mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
            'hover:bg-muted hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          )}
        >
          <ChevronRight
            className={cn(
              'h-4 w-4 transition-transform duration-200 motion-reduce:transition-none',
              open ? 'rotate-90' : '',
            )}
            aria-hidden
          />
        </button>
      </div>
      {open ? (
        <ul id={panelId} className="mt-0.5 space-y-0.5">
          {children.map((c) => (
            <ChildLink
              key={`${item.id}-${c.id}`}
              child={c}
              active={page === c.id}
              onSelect={() => onNavigate(c.id)}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
};

/* -------------------------------------------------------------------------- */
/* Collapsed (icon-rail) rendering.                                          */
/* -------------------------------------------------------------------------- */

const CollapsedItem: React.FC<{
  item: NavItem;
  page: PageId;
  onNavigate: (id: PageId) => void;
}> = ({ item, page, onNavigate }) => {
  const Icon = item.icon as LucideIcon;
  const children = item.children ?? [];
  const hasChildren = children.length > 0;
  const childActive = children.some((c) => c.id === page);
  const selfActive = page === item.id;
  const trailActive = selfActive || childActive;
  // Same shared-id host case as the expanded rail: the fly-out child carries the
  // canonical aria-current, so the rail button must not double it (the active trail is
  // still shown visually via the selfActive/trailActive className branch).
  const idIsAlsoChild = children.some((c) => c.id === item.id);

  const railButton = (
    <button
      type="button"
      onClick={() => onNavigate(item.id)}
      aria-label={item.label}
      aria-current={selfActive && !idIsAlsoChild ? 'page' : undefined}
      data-testid={`nav-${item.id}`}
      className={cn(
        'relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        selfActive
          ? 'bg-primary text-primary-foreground shadow-glow'
          : trailActive
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <Icon className="h-5 w-5" aria-hidden />
      {/* Active-trail indicator for a collapsed PARENT whose child is current. */}
      {trailActive && !selfActive ? (
        <span
          className="absolute -left-2 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-primary"
          aria-hidden
        />
      ) : null}
    </button>
  );

  // Childless item → a simple tooltip'd icon button.
  if (!hasChildren) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{railButton}</TooltipTrigger>
        <TooltipContent side="right">{item.label}</TooltipContent>
      </Tooltip>
    );
  }

  // Item with children → a fly-out listing the destinations. We render the fly-out
  // INLINE (not in a portal) inside a `group` so it appears on pointer HOVER *and*
  // on keyboard FOCUS-WITHIN (#8 — WCAG 2.1.1): the child links are real, in-flow
  // buttons, so Tab from the rail button moves straight into them — the previous
  // Radix HoverCard portaled the content out of the tab order, leaving the
  // destinations keyboard-unreachable in the collapsed rail. A HoverCard is no
  // longer used here; visibility is driven purely by CSS group state.
  const panelId = `nav-fly-${item.id}`;
  return (
    <div className="group relative">
      {railButton}
      <div
        id={panelId}
        // Hidden by default; revealed on hover OR when any descendant has focus.
        // `pointer-events-none` + `opacity-0` keep it out of the way until shown, but
        // it stays in the DOM/tab order so focus can enter it (focus-within then makes
        // it interactive). `motion-reduce` drops the fade for reduced-motion users.
        className={cn(
          'absolute left-full top-0 z-50 ml-2.5 w-52 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-elev2',
          'pointer-events-none opacity-0 transition-opacity duration-100 motion-reduce:transition-none',
          'group-hover:pointer-events-auto group-hover:opacity-100',
          'group-focus-within:pointer-events-auto group-focus-within:opacity-100',
        )}
      >
        <p className="px-2 py-1 text-xs font-semibold text-muted-foreground">{item.label}</p>
        <Separator className="my-1" />
        <ul className="space-y-0.5">
          {children.map((c) => {
            const CIcon = c.icon;
            const active = page === c.id;
            return (
              <li key={`fly-${item.id}-${c.id}`}>
                <button
                  type="button"
                  onClick={() => onNavigate(c.id)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    active
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {CIcon ? <CIcon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
                  <span className="truncate">{c.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
};

/* -------------------------------------------------------------------------- */
/* The sidebar.                                                              */
/* -------------------------------------------------------------------------- */

export interface NavSidebarProps {
  /** The current page id (drives the active trail + leaf highlight). */
  page: PageId;
  /** Navigate to a page (child or parent). */
  onNavigate: Navigate;
  /** Whether the rail is in the 64px icon state (true) or the 248px drawer. */
  collapsed: boolean;
  /** The expanded disclosure-group ids (host PageIds), shell-owned. */
  openGroups: Set<string>;
  /** Toggle one disclosure group's expanded state. */
  onToggleGroup: (id: string) => void;
  /** Ensure a group is expanded (called when navigating into one of its children). */
  onOpenGroup: (id: string) => void;
  /** A logo data: URL (trusted branding) for the brand mark; falls back to a shield. */
  logoUrl?: string;
  /** The product name (plain text) shown next to the mark when expanded. */
  productName?: string;
  /** A header slot for the hamburger toggle (the shell renders the button). */
  toggleSlot?: React.ReactNode;
}

/**
 * The single navigation surface. The shell owns `collapsed` + `openGroups` (so the
 * Cmd/Ctrl+B shortcut and persistence live in one place); this component is the
 * pure presentation of those states.
 */
export function NavSidebar({
  page,
  onNavigate,
  collapsed,
  openGroups,
  onToggleGroup,
  onOpenGroup,
  logoUrl,
  productName,
  toggleSlot,
}: NavSidebarProps) {
  const { hasPermission } = useAuth();
  const groups = React.useMemo(
    () => filterGroups(NAV_GROUPS, hasPermission),
    [hasPermission],
  );

  // Navigating ALSO opens the owning disclosure group — both when navigating into a
  // child (keep the trail visible) AND when tapping a parent host label itself (the
  // documented contract: "the parent label navigates to the host page AND opens the
  // group"). onOpenGroup is idempotent and only ever ADDS to the open set, so it never
  // collapses an already-open group — the chevron stays the sole explicit collapse.
  const navigate = React.useCallback(
    (id: PageId) => {
      const parent = navParentOf(id);
      if (parent && (parent.children?.length ?? 0) > 0) onOpenGroup(parent.id);
      onNavigate(id);
    },
    [onNavigate, onOpenGroup],
  );

  return (
    <aside
      className={cn(
        'sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-200 motion-reduce:transition-none',
        collapsed ? 'w-16 items-center' : 'w-60',
      )}
      aria-label="Primary navigation"
    >
      {/* Brand + hamburger header. */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center border-b border-border',
          collapsed ? 'w-full justify-center px-2' : 'gap-2 px-3',
        )}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {logoUrl ? (
            <img src={logoUrl} alt="" className="h-6 w-6 rounded object-contain" />
          ) : (
            <Shield className="h-5 w-5" aria-hidden />
          )}
        </span>
        {!collapsed ? (
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {productName || 'Agentic SOC'}
          </span>
        ) : null}
        {!collapsed ? toggleSlot : null}
      </div>

      {/* When collapsed, the hamburger sits just under the brand mark. */}
      {collapsed && toggleSlot ? (
        <div className="flex w-full justify-center py-2">{toggleSlot}</div>
      ) : null}

      <nav
        className={cn(
          'flex flex-1 flex-col overflow-y-auto overflow-x-hidden py-3',
          collapsed ? 'items-center gap-1' : 'gap-3 px-2',
        )}
      >
        {groups.map((group, gi) =>
          collapsed ? (
            <React.Fragment key={group.id}>
              {gi > 0 ? <Separator className="my-1 w-6" /> : null}
              {group.items.map((item) => (
                <CollapsedItem
                  key={item.id}
                  item={item}
                  page={page}
                  onNavigate={navigate}
                />
              ))}
            </React.Fragment>
          ) : (
            <div key={group.id} className="space-y-0.5">
              <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => (
                  <ExpandedItem
                    key={item.id}
                    item={item}
                    page={page}
                    open={openGroups.has(item.id)}
                    onNavigate={navigate}
                    onToggleGroup={onToggleGroup}
                  />
                ))}
              </ul>
            </div>
          ),
        )}
      </nav>
    </aside>
  );
}

export default NavSidebar;
