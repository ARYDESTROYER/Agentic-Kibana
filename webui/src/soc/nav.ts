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
  Settings,
} from 'lucide-react';

/** Stable page ids — the router validates the hash against these. */
export type PageId =
  | 'overview'
  | 'cases'
  | 'investigate'
  | 'chat'
  | 'intelligence'
  | 'metrics'
  | 'scans'
  | 'standup'
  | 'catalog'
  | 'approvals'
  | 'knowledge'
  | 'memory'
  | 'sources'
  | 'cost'
  | 'account'
  | 'sessions'
  | 'settings'
  | 'security'
  | 'users'
  | 'admin_sessions';

export type NavGroupId =
  | 'overview'
  | 'triage'
  | 'intelligence'
  | 'analytics'
  | 'platform'
  | 'automation'
  | 'admin';

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
      { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'overview' },
    ],
  },
  {
    id: 'triage',
    label: 'Triage',
    items: [
      { id: 'cases', label: 'Cases', icon: ShieldAlert, group: 'triage' },
      // Host page: Workspace = Chat | Investigate (ONE chat engine, CLAUDE.md).
      { id: 'chat', label: 'Workspace', icon: MessageSquare, group: 'triage' },
      { id: 'scans', label: 'Automated scans', icon: ScanLine, group: 'triage' },
      { id: 'approvals', label: 'Approvals', icon: CheckCircle2, group: 'triage' },
    ],
  },
  {
    id: 'intelligence',
    label: 'Intelligence',
    items: [
      // Host page: Intelligence = Knowledge | Memory | Playbooks & Agents.
      { id: 'intelligence', label: 'Intelligence', icon: Library, group: 'intelligence' },
    ],
  },
  {
    id: 'analytics',
    label: 'Analytics',
    items: [
      // Host page: Analytics = Dashboard (metrics) | Cost & usage.
      { id: 'metrics', label: 'Analytics', icon: BarChart3, group: 'analytics' },
    ],
  },
  {
    id: 'platform',
    label: 'Platform',
    items: [
      { id: 'sources', label: 'Sources', icon: Database, group: 'platform' },
      { id: 'settings', label: 'Settings', icon: Settings, group: 'platform' },
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
];

/** Flat list of all nav items shown in the rail (lookups + command palette). */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/**
 * Every ROUTABLE page id — the rail items PLUS the consolidated sub-pages that are
 * no longer rail items but remain valid deep-link targets (Round-2 W4). The router
 * validates the hash against this set so `#/cost`, `#/investigate`, `#/standup`,
 * `#/knowledge`, `#/memory`, `#/catalog`, and the Settings-folded
 * account/sessions/security/users/admin_sessions routes still resolve to their
 * App.renderPage arm instead of falling back to Overview.
 */
const HIDDEN_ROUTE_IDS: PageId[] = [
  'investigate',
  'cost',
  'standup',
  'knowledge',
  'memory',
  'catalog',
  'account',
  'sessions',
  'security',
  'users',
  'admin_sessions',
];

/** All valid page ids (rail items + hidden-but-routable consolidated sub-pages). */
export const PAGE_IDS: PageId[] = [
  ...NAV_ITEMS.map((i) => i.id),
  ...HIDDEN_ROUTE_IDS,
];

/** Look up a nav item by id (used for breadcrumbs + the active rail square). */
export function navItem(id: PageId): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.id === id);
}

/** Type guard: is the given string a known page id? */
export function isPageId(value: string): value is PageId {
  return (PAGE_IDS as string[]).includes(value);
}
