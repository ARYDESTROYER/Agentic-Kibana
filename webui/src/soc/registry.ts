/**
 * FEATURES[] — the single typed feature registry for the SOC console (Round-5 W0-F F3).
 *
 * Historically the navigation model lived directly in `soc/nav.ts` as a hand-written
 * `NAV_GROUPS` array plus a parallel `HIDDEN_ROUTE_IDS` list, and each of those was
 * consumed by the shell (rail), the command palette, the router, and the breadcrumb.
 * Round-5 lifts that into ONE typed table — {@link FEATURES} — that describes every
 * navigable feature once: its id, label, icon, group, RBAC gate, optional children,
 * whether it is a rail item or a hidden-but-routable deep-link, and — crucially — an
 * {@link FeatureNode.enabled | `enabled(ctx)`} predicate that unifies the three
 * distinct visibility axes (RBAC grant / prefs feature-toggle / demo mode).
 *
 * `nav.ts` is now a THIN derivation layer over this table: it re-exports the SAME
 * shapes it always did (`NAV_GROUPS`, `NAV_ITEMS`, `NAV_CHILDREN`, `PageId`,
 * `PAGE_IDS`, and `navItem`/`navParentOf`/`navLabel`/`isPageId`) so nothing that
 * imports `nav.ts` changes. This is a non-breaking migration behind existing exports;
 * later waves (Rules, Custom-Dash, Coupling) register their features HERE instead of
 * hand-editing the nav array.
 *
 * Design notes:
 *   - The `enabled(ctx)` axes are DELIBERATELY separate: `hasPermission` (RBAC),
 *     `prefsEnabled` (a user/org prefs feature-toggle), and `demoActive` (the demo
 *     tenant). Today's nav only gates on RBAC, so every feature's default `enabled`
 *     checks ONLY its `perm` — behaviour is byte-identical. New features can opt into
 *     the other axes by supplying their own `enabled` without changing the shell.
 *   - Ordering in {@link FEATURES} is authoritative: it preserves the exact group +
 *     item + child order the old `NAV_GROUPS` array had, so the derived rail is
 *     pixel-identical.
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

/* -------------------------------------------------------------------------- */
/* Stable id + group unions (the router validates hashes against PageId).      */
/* -------------------------------------------------------------------------- */

/** Stable page ids — the router validates the hash against these. */
export type PageId =
  | 'overview'
  | 'dashboard'
  | 'dashboards'
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
 * A permission requirement (`resource:action`) gating a feature. When present, the
 * shell hides the feature from users without the grant. Features without a `perm` are
 * always shown (back-compat: visible when auth/RBAC are off).
 */
export interface NavPerm {
  resource: string;
  action: string;
}

/* -------------------------------------------------------------------------- */
/* enabled(ctx): the three visibility axes, unified.                          */
/* -------------------------------------------------------------------------- */

/**
 * The evaluation context passed to {@link FeatureNode.enabled}. The three fields are
 * the three DISTINCT axes a feature can be gated on; a feature combines them however
 * it needs (default: RBAC only).
 */
export interface FeatureCtx {
  /** RBAC axis: true when auth/RBAC are off, else consults the permission matrix. */
  hasPermission: (resource: string, action: string) => boolean;
  /** Prefs feature-toggle axis: is a named opt-in feature flag enabled? Default true. */
  prefsEnabled?: (flag: string) => boolean;
  /** Demo axis: is the demo tenant currently active? */
  demoActive?: boolean;
}

/**
 * One feature in the registry. A feature is a navigable destination; it may be a
 * top-level rail item, a child (sub-page of a host feature), or a hidden-but-routable
 * deep-link that keeps its own route/PageId but is not shown in the rail.
 */
export interface FeatureNode {
  id: PageId;
  label: string;
  /** Lucide icon component. Children may omit it. */
  icon?: LucideIcon;
  group: NavGroupId;
  /** Optional RBAC gate; consumed by the default {@link FeatureNode.enabled}. */
  perm?: NavPerm;
  /**
   * Optional child destinations (expandable disclosure nav). Children are thin leaves
   * (never nested further) that a host feature tabs between. A child id MUST be a
   * routable PageId registered in App.renderPage.
   */
  children?: FeatureChild[];
  /**
   * True when this feature is routable + deep-linkable but NOT a rail item (a
   * consolidated sub-page kept for cutover safety / deep-links). Hidden features are
   * excluded from the derived NAV_GROUPS/NAV_ITEMS but still contribute to PAGE_IDS.
   */
  hidden?: boolean;
  /**
   * Unified visibility predicate over the three axes. Defaults (via
   * {@link featureEnabled}) to the RBAC axis only, so existing features behave exactly
   * as before. A feature may override to fold in prefs-toggle / demo.
   */
  enabled?: (ctx: FeatureCtx) => boolean;
}

/** A sub-page (child) under a host {@link FeatureNode}. */
export interface FeatureChild {
  id: PageId;
  label: string;
  icon?: LucideIcon;
  perm?: NavPerm;
  enabled?: (ctx: FeatureCtx) => boolean;
}

/**
 * Default visibility evaluation: check the RBAC axis (the item's `perm`, if any), then
 * defer to a feature-supplied `enabled` override. This is the SINGLE place the three
 * axes are combined, so callers never re-implement the RBAC check.
 */
export function featureEnabled(
  node: { perm?: NavPerm; enabled?: (ctx: FeatureCtx) => boolean },
  ctx: FeatureCtx,
): boolean {
  if (node.enabled) return node.enabled(ctx);
  return !node.perm || ctx.hasPermission(node.perm.resource, node.perm.action);
}

/* -------------------------------------------------------------------------- */
/* The registry.                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The one typed feature table. Order is authoritative (drives rail order). Every
 * top-level rail feature keeps `hidden` falsey; consolidated deep-link-only sub-pages
 * are `hidden: true`. `nav.ts` derives NAV_GROUPS / PAGE_IDS / lookups from this.
 */
export const FEATURES: FeatureNode[] = [
  /* ---- Overview -------------------------------------------------------- */
  {
    id: 'overview',
    label: 'Overview',
    icon: LayoutDashboard,
    group: 'overview',
    children: [
      { id: 'dashboard', label: 'Dashboard', icon: Gauge },
      // Round-5 G7 (CD5): the build-your-own custom dashboards surface. Ships ON by
      // default (a read-only per-role default layout; Edit mode to customize) and is
      // gated on the SAME `metrics:view` grant the backend routes_dashboards.py
      // require, so it never appears for a principal who can't read the metrics it
      // renders. RBAC off → always visible (back-compat).
      {
        id: 'dashboards',
        label: 'Dashboards',
        icon: LayoutDashboard,
        perm: { resource: 'metrics', action: 'view' },
      },
      { id: 'standup', label: 'Standup', icon: CalendarDays },
    ],
  },

  /* ---- Triage ---------------------------------------------------------- */
  { id: 'cases', label: 'Cases', icon: ShieldAlert, group: 'triage' },
  {
    id: 'campaigns',
    label: 'Campaigns',
    icon: Network,
    group: 'triage',
    perm: { resource: 'cases', action: 'read' },
  },
  {
    id: 'logs',
    label: 'Logs',
    icon: List,
    group: 'triage',
    perm: { resource: 'sources', action: 'read' },
  },
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

  /* ---- Intelligence ---------------------------------------------------- */
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

  /* ---- Analytics ------------------------------------------------------- */
  {
    id: 'metrics',
    label: 'Analytics',
    icon: BarChart3,
    group: 'analytics',
    children: [
      { id: 'metrics', label: 'Metrics', icon: BarChart3 },
      { id: 'cost', label: 'Cost', icon: DollarSign },
      { id: 'models', label: 'Models', icon: Cpu },
      {
        id: 'baseline',
        label: 'Baseline',
        icon: Activity,
        perm: { resource: 'settings', action: 'read' },
      },
      {
        id: 'batchjobs',
        label: 'Batch jobs',
        icon: Layers,
        perm: { resource: 'models', action: 'read' },
      },
    ],
  },

  /* ---- Notifications --------------------------------------------------- */
  {
    id: 'inbox',
    label: 'Notifications',
    icon: Bell,
    group: 'notifications',
    children: [{ id: 'inbox', label: 'Inbox', icon: Inbox }],
  },

  /* ---- Platform -------------------------------------------------------- */
  { id: 'sources', label: 'Sources', icon: Database, group: 'platform' },
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
  {
    // Round-5 Sett-B: the Settings rail item surfaces the two promoted, admin-only
    // "Security & access" destinations (Users, Roles) as disclosure children. They keep
    // their own PageIds (deep-link back-compat) but the router (SETTINGS_REDIRECTS)
    // rewrites each `#/<id>` to `#/settings?s=<id>` so clicking a child lands INSIDE
    // Settings — no separate standalone home. Each child gates on the SAME resolvable
    // grant its Settings section + page require — bug #7 fix: the former `roles:view` /
    // `users:view` gates were non-existent actions (`roles` = read|manage, `users` =
    // manage) that hid the item from operators who actually held `manage`. Unified on
    // `manage`. (SSO / Sessions / Active-sessions / Secret-keys stay reachable via the
    // Settings rail itself; surfacing only the two highest-value admin tables keeps the
    // sidebar to ≤2 nesting levels and avoids the `security` PageId ↔ section collision:
    // the `security` PageId redirects to PERSONAL 2FA, while the org SSO Settings
    // section is `?s=security`.)
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    group: 'platform',
    children: [
      { id: 'users', label: 'Users', icon: UsersIcon, perm: { resource: 'users', action: 'manage' } },
      { id: 'roles', label: 'Roles', icon: KeyRound, perm: { resource: 'roles', action: 'manage' } },
    ],
  },

  /* ---- Hidden-but-routable consolidated sub-pages ---------------------- *
   * Round-2 W4 / Round-3 disclosure: these keep their PageId + App.renderPage
   * arm (deep-linkable) but are NOT rail items. Some duplicate a rail id (e.g.
   * they also appear as a child above); the derivation de-dupes PAGE_IDS. The
   * `group` here is only a bookkeeping home — hidden features never enter a rail
   * group. Order mirrors the old HIDDEN_ROUTE_IDS list for stability.            */
  { id: 'dashboard', label: 'Dashboard', icon: Gauge, group: 'overview', hidden: true },
  { id: 'investigate', label: 'Investigate', icon: SearchIcon, group: 'triage', hidden: true },
  { id: 'cost', label: 'Cost', icon: DollarSign, group: 'analytics', hidden: true },
  { id: 'models', label: 'Models', icon: Cpu, group: 'analytics', hidden: true },
  { id: 'standup', label: 'Standup', icon: CalendarDays, group: 'overview', hidden: true },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen, group: 'intelligence', hidden: true },
  { id: 'memory', label: 'Memory', icon: Brain, group: 'intelligence', hidden: true },
  { id: 'catalog', label: 'Catalog', icon: Library, group: 'intelligence', hidden: true },
  { id: 'playbooks', label: 'Playbooks', icon: Workflow, group: 'intelligence', hidden: true },
  // Round-5 Sett-B: the six formerly-standalone admin/account homes
  // (account/sessions/security/roles/users/admin_sessions) collapsed INTO Settings
  // sections. Their PageIds stay registered (deep-link back-compat) but the router
  // (SETTINGS_REDIRECTS) rewrites `#/<id>` → `#/settings?s=<sectionId>` — the standalone
  // App.renderPage arms are no longer the primary home. Keeping them here keeps
  // `isPageId('roles')` true so the redirect fires instead of a 404-to-Overview.
  { id: 'account', label: 'Account', icon: Settings, group: 'platform', hidden: true },
  { id: 'sessions', label: 'Sessions', icon: MonitorSmartphone, group: 'platform', hidden: true },
  { id: 'security', label: 'Security', icon: ShieldCheck, group: 'platform', hidden: true },
  { id: 'roles', label: 'Roles', icon: KeyRound, group: 'platform', hidden: true },
  { id: 'users', label: 'Users', icon: UsersIcon, group: 'platform', hidden: true },
  { id: 'admin_sessions', label: 'Admin sessions', icon: MonitorSmartphone, group: 'platform', hidden: true },
];

/**
 * Group ids + display labels, in rail order. Kept beside {@link FEATURES} so the
 * derivation in `nav.ts` can build NAV_GROUPS without a second source of ordering.
 */
export const FEATURE_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'triage', label: 'Triage' },
  { id: 'intelligence', label: 'Intelligence' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'platform', label: 'Platform' },
];
