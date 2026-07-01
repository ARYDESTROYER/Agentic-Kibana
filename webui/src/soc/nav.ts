/**
 * Navigation model for the SOC console.
 *
 * Round-2 W4 page consolidation: the rail is grouped into ≤5 top-level groups
 * (Overview / Triage / Intelligence / Analytics / Platform — Miller's 7±2) and a
 * batch of near-duplicate pages now live as tabbed sub-views of a host page rather
 * than as standalone rail items:
 *
 *   - `chat`         (Workspace)    hosts Chat | Investigate.
 *   - `metrics`      (Analytics)    hosts Dashboard | Cost.
 *   - `overview`     (Home)         hosts Dashboard | Standup.
 *   - `intelligence` (Intelligence) hosts Knowledge | Memory | Playbooks & Agents.
 *
 * The merged sub-pages keep their page ids in the union + the App.renderPage switch
 * (so old `#/cost`, `#/investigate`, … deep-links still resolve), but they are no
 * longer top-level rail items. Icons are lucide-react component types so the shell +
 * command palette can render them without a string→icon lookup table.
 */
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  ShieldAlert,
  MessageSquare,
  BarChart3,
  ScanLine,
  CheckCircle2,
  Library,
  Database,
  ScrollText,
  Settings,
  Bell,
  Gauge,
  CalendarDays,
  Search as SearchIcon,
  DollarSign,
  Cpu,
  BookOpen,
  Brain,
  Workflow,
  Inbox,
  Users as UsersIcon,
  ShieldCheck,
  KeyRound,
  MonitorSmartphone,
  List,
  Network,
  SlidersHorizontal,
  Layers,
  Activity,
} from 'lucide-react';

/** Stable page ids — the router validates the hash against these. */
export type PageId =
  | 'overview'
  | 'dashboard'
  | 'cases'
  | 'investigate'
  | 'chat'
  | 'intelligence'
  | 'metrics'
  | 'models'
  | 'scans'
  | 'standup'
  | 'catalog'
  | 'playbooks'
  | 'approvals'
  | 'knowledge'
  | 'memory'
  | 'sources'
  | 'cost'
  | 'inbox'
  | 'account'
  | 'sessions'
  | 'settings'
  | 'security'
  | 'roles'
  | 'users'
  | 'audit'
  | 'admin_sessions'
  | 'logs'
  | 'campaigns'
  | 'tuning'
  | 'batchjobs'
  | 'baseline';

export type NavGroupId =
  | 'overview'
  | 'triage'
  | 'intelligence'
  | 'analytics'
  | 'notifications'
  | 'platform';

/**
 * A permission requirement (`resource:action`) gating a nav item. When present,
 * the shell hides the item from users without the grant. Items without a `perm`
 * are always shown (back-compat: visible when auth/RBAC are off).
 */
export interface NavPerm {
  resource: string;
  action: string;
}

export interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
  group: NavGroupId;
  /** Optional RBAC gate; the item is hidden unless the user has this grant. */
  perm?: NavPerm;
  /**
   * Optional child destinations (Round-3 expandable hamburger nav). These are the
   * sub-pages a host page tabs between (and that were previously only reachable via
   * Cmd-K or in-page tabs); surfacing them here lets the labelled sidebar expand a
   * parent into a WAI-ARIA DISCLOSURE group and the collapsed icon-rail show them in
   * a Radix fly-out. A child never has its own `children`. Each child id MUST be a
   * routable PageId (registered in App.renderPage by the integrator).
   */
  children?: NavChild[];
}

/**
 * A sub-page under a top-level {@link NavItem}. It is a thin leaf — id + label
 * (+ optional icon / RBAC gate). Navigating to it routes to the host page's
 * relevant tab (the host page reads the page id / `tab` opt and selects the view).
 */
export interface NavChild {
  id: PageId;
  label: string;
  icon?: LucideIcon;
  /** Optional RBAC gate; hidden unless the user has this grant. */
  perm?: NavPerm;
}

export interface NavGroup {
  id: NavGroupId;
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      // Host page: hosts the posture Dashboard + the daily Standup as sub-tabs.
      // Expandable (Round-3): the disclosure surfaces those tabs as direct
      // destinations so they are reachable from the rail, not only via Cmd-K.
      {
        id: 'overview',
        label: 'Overview',
        icon: LayoutDashboard,
        group: 'overview',
        children: [
          { id: 'dashboard', label: 'Dashboard', icon: Gauge },
          { id: 'standup', label: 'Standup', icon: CalendarDays },
        ],
      },
    ],
  },
  {
    id: 'triage',
    label: 'Triage',
    items: [
      { id: 'cases', label: 'Cases', icon: ShieldAlert, group: 'triage' },
      { id: 'campaigns', label: 'Campaigns', icon: Network, group: 'triage', perm: { resource: 'cases', action: 'read' } },
      { id: 'logs', label: 'Logs', icon: List, group: 'triage', perm: { resource: 'sources', action: 'read' } },
      // Host page: Workspace = Chat | Investigate (ONE chat engine, CLAUDE.md).
      {
        id: 'chat',
        label: 'Workspace',
        icon: MessageSquare,
        group: 'triage',
        children: [
          { id: 'chat', label: 'Chat', icon: MessageSquare },
          { id: 'investigate', label: 'Investigate', icon: SearchIcon },
        ],
      },
      { id: 'scans', label: 'Automated scans', icon: ScanLine, group: 'triage' },
      { id: 'approvals', label: 'Approvals', icon: CheckCircle2, group: 'triage' },
    ],
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    items: [
      // Host page: Intelligence = Knowledge | Memory | Playbooks & Agents.
      {
        id: 'intelligence',
        label: 'Intelligence',
        icon: Library,
        group: 'intelligence',
        children: [
          { id: 'knowledge', label: 'Knowledge', icon: BookOpen },
          { id: 'memory', label: 'Memory', icon: Brain },
          { id: 'playbooks', label: 'Playbooks', icon: Workflow },
        ],
      },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      // Host page: Analytics = Dashboard (metrics) | Cost & usage | Models.
      {
        id: 'metrics',
        label: 'Analytics',
        icon: BarChart3,
        group: 'analytics',
        children: [
          { id: 'metrics', label: 'Metrics', icon: BarChart3 },
          { id: 'cost', label: 'Cost', icon: DollarSign },
          { id: 'models', label: 'Models', icon: Cpu },
          { id: 'baseline', label: 'Baseline', icon: Activity, perm: { resource: 'settings', action: 'read' } },
          { id: 'batchjobs', label: 'Batch jobs', icon: Layers, perm: { resource: 'models', action: 'read' } },
        ],
      },
    ],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    items: [
      // In-app notification inbox (Round-3): the bell in the top bar links here.
      {
        id: 'inbox',
        label: 'Notifications',
        icon: Bell,
        group: 'notifications',
        children: [{ id: 'inbox', label: 'Inbox', icon: Inbox }],
      },
    ],
  },
  {
    id: 'platform',
    label: 'Platform',
    items: [
      { id: 'sources', label: 'Sources', icon: Database, group: 'platform' },
      // Audit-log viewer (W7c): read-only over the append-only audit (#2), gated by
      // the `audit:view` grant (admin / auditor / soc_manager by default). Hidden for
      // users without the grant; always visible when auth/RBAC are off (back-compat).
      {
        id: 'audit',
        label: 'Audit log',
        icon: ScrollText,
        group: 'platform',
        perm: { resource: 'audit', action: 'view' },
      },
      {
        id: 'tuning',
        label: 'Auto-tuning',
        icon: SlidersHorizontal,
        group: 'platform',
        perm: { resource: 'automation', action: 'read' },
      },
      // Settings host: the disclosure surfaces the high-traffic admin sections
      // (Users / Security / Roles / Sessions). Each child is RBAC-gated; with auth
      // off they all show (hasPermission() === true). The Settings host page itself
      // is always reachable (the sub-sections are deep-links into its left rail).
      {
        id: 'settings',
        label: 'Settings',
        icon: Settings,
        group: 'platform',
        children: [
          { id: 'users', label: 'Users', icon: UsersIcon, perm: { resource: 'users', action: 'view' } },
          { id: 'security', label: 'Security', icon: ShieldCheck },
          { id: 'roles', label: 'Roles', icon: KeyRound, perm: { resource: 'roles', action: 'view' } },
          { id: 'sessions', label: 'Sessions', icon: MonitorSmartphone },
        ],
      },
    ],
  },
  // Round-2 Wave 4 — page + Settings IA consolidation. Pages folded into host tabs
  // or into Settings keep their PageId + App.renderPage arm (deep-linkable, cutover
  // safety) but are NOT top-level rail items:
  //   - chat (Workspace) hosts:        Chat | Investigate          (#/chat?…)
  //   - metrics (Analytics) hosts:     Dashboard | Cost            (#/metrics, #/cost)
  //   - overview (Home) hosts:         Dashboard | Standup         (#/overview, #/standup)
  //   - intelligence hosts:            Knowledge | Memory | Catalog
  //   - Settings hosts (Stage 1):      Account/Security/Sessions + Users/Security/SSO
  // The merged sub-page ids (investigate, cost, standup, knowledge, memory, catalog,
  // account, sessions, security, users, admin_sessions) remain valid routes.
  //
  // Round-3 expandable nav: these consolidated sub-pages are now ALSO surfaced as
  // `children` of their host item above (so they are reachable from the rail's
  // disclosure groups), while keeping their standalone PageId + App.renderPage arm.
];

/** Flat list of all top-level nav items shown in the rail (lookups + command palette). */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Every child (sub-page) across all nav items, flattened (disclosure + lookups). */
export const NAV_CHILDREN: NavChild[] = NAV_ITEMS.flatMap((i) => i.children ?? []);

/**
 * Every ROUTABLE page id — the rail items PLUS the consolidated sub-pages that are
 * no longer rail items but remain valid deep-link targets (Round-2 W4, Round-3
 * disclosure children). The router validates the hash against this set so
 * `#/cost`, `#/investigate`, `#/standup`, `#/knowledge`, `#/memory`, `#/catalog`,
 * `#/dashboard`, `#/models`, `#/playbooks`, `#/roles`, and the Settings-folded
 * account/sessions/security/users/admin_sessions routes still resolve to their
 * App.renderPage arm instead of falling back to Overview.
 *
 * NOTE: `dashboard`, `models`, `playbooks`, `roles`, `inbox` are rendered by other
 * builders / the integrator in App.renderPage; nav points at them here.
 */
const HIDDEN_ROUTE_IDS: PageId[] = [
  'dashboard',
  'investigate',
  'cost',
  'models',
  'standup',
  'knowledge',
  'memory',
  'catalog',
  'playbooks',
  'account',
  'sessions',
  'security',
  'roles',
  'users',
  'admin_sessions',
];

/**
 * All valid page ids (rail items + their disclosure children + hidden-but-routable
 * consolidated sub-pages). De-duplicated because some children (e.g. `chat`,
 * `metrics`, `inbox`) share an id with their host item.
 */
export const PAGE_IDS: PageId[] = Array.from(
  new Set<PageId>([
    ...NAV_ITEMS.map((i) => i.id),
    ...NAV_CHILDREN.map((c) => c.id),
    ...HIDDEN_ROUTE_IDS,
  ]),
);

/**
 * Look up a top-level nav item by id (used for the active rail square). Note a
 * consolidated sub-page that is no longer a rail item returns undefined here — use
 * {@link navLabel} for a breadcrumb label that also resolves child labels.
 */
export function navItem(id: PageId): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.id === id);
}

/**
 * Find the top-level nav item whose subtree (itself or a child) contains `id`.
 * Used by the sidebar to mark the active trail on a collapsed parent and to expand
 * the owning disclosure group.
 */
export function navParentOf(id: PageId): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.id === id || (i.children ?? []).some((c) => c.id === id));
}

/**
 * A human label for any routable page id (top-level item, disclosure child, or a
 * consolidated sub-page), for the breadcrumb. Falls back to a humanised id.
 */
export function navLabel(id: PageId): string {
  const top = NAV_ITEMS.find((i) => i.id === id);
  if (top) return top.label;
  const child = NAV_CHILDREN.find((c) => c.id === id);
  if (child) return child.label;
  // Consolidated sub-pages with no nav entry — humanise the id (e.g. account → Account).
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ');
}

/** Type guard: is the given string a known page id? */
export function isPageId(value: string): value is PageId {
  return (PAGE_IDS as string[]).includes(value);
}
