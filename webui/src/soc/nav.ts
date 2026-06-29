/**
 * Navigation model for the SOC console.
 *
 * Three groups (TRIAGE / AUTOMATION / PLATFORM), each a list of nav items keyed
 * by a stable page id (the same ids the hash router validates against). Icons are
 * lucide-react component types so the shell + command palette can render them
 * without a string→icon lookup table.
 */
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  ShieldAlert,
  Search,
  MessageSquare,
  BarChart3,
  ScanLine,
  ClipboardList,
  BookOpenCheck,
  CheckCircle2,
  Library,
  Brain,
  Database,
  DollarSign,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';

/** Stable page ids — the router validates the hash against these. */
export type PageId =
  | 'overview'
  | 'cases'
  | 'investigate'
  | 'chat'
  | 'metrics'
  | 'scans'
  | 'standup'
  | 'catalog'
  | 'approvals'
  | 'knowledge'
  | 'memory'
  | 'sources'
  | 'cost'
  | 'settings'
  | 'security'
  | 'users';

export type NavGroupId = 'triage' | 'automation' | 'platform' | 'admin';

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
    id: 'triage',
    label: 'Triage',
    items: [
      { id: 'overview', label: 'Overview', icon: LayoutDashboard, group: 'triage' },
      { id: 'cases', label: 'Cases', icon: ShieldAlert, group: 'triage' },
      { id: 'investigate', label: 'Investigate', icon: Search, group: 'triage' },
      { id: 'chat', label: 'Chat', icon: MessageSquare, group: 'triage' },
      { id: 'metrics', label: 'Metrics', icon: BarChart3, group: 'triage' },
    ],
  },
  {
    id: 'automation',
    label: 'Automation',
    items: [
      { id: 'scans', label: 'Automated scans', icon: ScanLine, group: 'automation' },
      { id: 'standup', label: 'Standup', icon: ClipboardList, group: 'automation' },
      { id: 'catalog', label: 'Playbooks & Agents', icon: BookOpenCheck, group: 'automation' },
      { id: 'approvals', label: 'Approvals', icon: CheckCircle2, group: 'automation' },
    ],
  },
  {
    id: 'platform',
    label: 'Platform',
    items: [
      { id: 'knowledge', label: 'Knowledge', icon: Library, group: 'platform' },
      { id: 'memory', label: 'Memory', icon: Brain, group: 'platform' },
      { id: 'sources', label: 'Sources', icon: Database, group: 'platform' },
      { id: 'cost', label: 'Cost & usage', icon: DollarSign, group: 'platform' },
      { id: 'security', label: 'Security', icon: ShieldCheck, group: 'platform' },
      { id: 'settings', label: 'Settings', icon: Settings, group: 'platform' },
    ],
  },
  {
    id: 'admin',
    label: 'Administration',
    items: [
      {
        id: 'users',
        label: 'Users & roles',
        icon: Users,
        group: 'admin',
        perm: { resource: 'users', action: 'manage' },
      },
    ],
  },
];

/** Flat list of all nav items (handy for lookups + the command palette). */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** All valid page ids, derived from the nav model. */
export const PAGE_IDS: PageId[] = NAV_ITEMS.map((i) => i.id);

/** Look up a nav item by id (used for breadcrumbs + the active rail square). */
export function navItem(id: PageId): NavItem | undefined {
  return NAV_ITEMS.find((i) => i.id === id);
}

/** Type guard: is the given string a known page id? */
export function isPageId(value: string): value is PageId {
  return (PAGE_IDS as string[]).includes(value);
}
