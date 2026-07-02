/**
 * Navigation model for the SOC console — a THIN derivation layer over the typed
 * feature registry (`soc/registry.ts`, Round-5 W0-F F3).
 *
 * This module used to hand-hold the whole nav array; that authoritative table now
 * lives in {@link ./registry.FEATURES}. `nav.ts` re-exports the SAME shapes it always
 * did — `NAV_GROUPS`, `NAV_ITEMS`, `NAV_CHILDREN`, `PageId`, `PAGE_IDS`, and the
 * `navItem`/`navParentOf`/`navLabel`/`isPageId` helpers — DERIVED from `FEATURES`, so
 * every existing importer (shell rail, command palette, router, breadcrumb) keeps
 * working unchanged. This is a non-breaking migration behind existing exports; new
 * features register in `registry.ts`, not here.
 *
 * Round-2 W4 page consolidation (still true): the rail is grouped into ≤5–6 top-level
 * groups (Overview / Triage / Intelligence / Analytics / Notifications / Platform —
 * Miller's 7±2) and a batch of near-duplicate pages live as tabbed sub-views of a host
 * page rather than as standalone rail items:
 *
 *   - `chat`         (Workspace)    hosts Chat | Investigate.
 *   - `metrics`      (Analytics)    hosts Metrics | Cost | Models | Baseline | Batch.
 *   - `overview`     (Home)         hosts Dashboard | Standup.
 *   - `intelligence` (Intelligence) hosts Knowledge | Memory | Playbooks.
 *
 * The merged sub-pages keep their page ids in the union + the App.renderPage switch
 * (so old `#/cost`, `#/investigate`, … deep-links still resolve), but they are no
 * longer top-level rail items. Icons are lucide-react component types so the shell +
 * command palette can render them without a string→icon lookup table.
 */
import type { LucideIcon } from 'lucide-react';
import {
  FEATURES,
  FEATURE_GROUPS,
  featureEnabled,
  type FeatureChild,
  type FeatureCtx,
  type FeatureNode,
  type NavGroupId,
  type NavPerm,
  type PageId,
} from './registry';

/* Re-export the id/group/perm contracts unchanged (they now live in registry.ts). */
export type { PageId, NavGroupId, NavPerm, FeatureCtx } from './registry';

/**
 * The SINGLE nav-visibility authority (Round-6 #42). `featureEnabled` (registry.ts) is
 * the one place the three visibility axes (RBAC grant / prefs feature-toggle / demo)
 * are combined; re-export it here so the nav consumers (NavSidebar, CommandPalette)
 * import ONE authority from the same module they already pull `NAV_GROUPS` from, rather
 * than re-implementing an ad-hoc `!perm || has()` check that silently ignores a
 * feature's `enabled` override. See {@link navVisible} for the RBAC-only convenience.
 */
export { featureEnabled };

/**
 * A top-level rail destination. Structurally identical to a non-hidden
 * {@link FeatureNode} (id/label/icon/group/perm/children) — kept as its own named
 * type for the exact back-compat shape existing importers rely on (icon required).
 */
export interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
  group: NavGroupId;
  /** Optional RBAC gate; the item is hidden unless the user has this grant. */
  perm?: NavPerm;
  /**
   * Optional unified visibility predicate over the three axes (RBAC / prefs-toggle /
   * demo). Carried through from the registry so a consumer can route the item through
   * {@link navVisible} / {@link featureEnabled} (the single authority) instead of only
   * checking `perm`. Round-6 #42: previously DROPPED at this derivation boundary, which
   * silently defeated any registered `enabled` override.
   */
  enabled?: (ctx: FeatureCtx) => boolean;
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
  /** Optional unified visibility predicate (see {@link NavItem.enabled}). */
  enabled?: (ctx: FeatureCtx) => boolean;
}

export interface NavGroup {
  id: NavGroupId;
  label: string;
  items: NavItem[];
}

/* -------------------------------------------------------------------------- */
/* Derivation from the registry.                                              */
/* -------------------------------------------------------------------------- */

/** Narrow a registry child to the back-compat {@link NavChild} shape. */
function toNavChild(c: FeatureChild): NavChild {
  const child: NavChild = { id: c.id, label: c.label };
  if (c.icon) child.icon = c.icon;
  if (c.perm) child.perm = c.perm;
  // Round-6 #42: carry the unified `enabled` predicate through the derivation so nav
  // consumers can gate on all three axes via navVisible/featureEnabled, not perm alone.
  if (c.enabled) child.enabled = c.enabled;
  return child;
}

/** Narrow a non-hidden registry feature to the back-compat {@link NavItem} shape. */
function toNavItem(f: FeatureNode): NavItem {
  if (!f.icon) {
    // A rail feature (non-hidden) MUST declare an icon — the shell + command palette
    // render it as a component (`<item.icon />`). Fail fast at module-load (boot) with a
    // named feature rather than casting `undefined` to a LucideIcon and white-screening
    // the rail at paint time. toNavItem is only ever called for non-hidden features
    // (see NAV_GROUPS), so a missing icon here is always a registry data mistake.
    throw new Error(`nav: rail feature "${f.id}" is missing a required icon`);
  }
  const item: NavItem = {
    id: f.id,
    label: f.label,
    icon: f.icon,
    group: f.group,
  };
  if (f.perm) item.perm = f.perm;
  // Round-6 #42: carry `enabled` through (see toNavChild) so the rail/palette can route
  // visibility through the single featureEnabled authority instead of a perm-only check.
  if (f.enabled) item.enabled = f.enabled;
  if (f.children && f.children.length) item.children = f.children.map(toNavChild);
  return item;
}

/**
 * The rail groups, derived from {@link FEATURES}: for each declared group (in order),
 * collect its non-hidden features (in registry order). Groups with no visible items
 * are omitted, matching the old hand-written array (which had none empty).
 */
export const NAV_GROUPS: NavGroup[] = FEATURE_GROUPS.map((g) => ({
  id: g.id,
  label: g.label,
  items: FEATURES.filter((f) => !f.hidden && f.group === g.id).map(toNavItem),
})).filter((g) => g.items.length > 0);

/** Flat list of all top-level nav items shown in the rail (lookups + command palette). */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Every child (sub-page) across all nav items, flattened (disclosure + lookups). */
export const NAV_CHILDREN: NavChild[] = NAV_ITEMS.flatMap((i) => i.children ?? []);

/**
 * All valid page ids — the rail items PLUS their disclosure children PLUS the
 * hidden-but-routable consolidated sub-pages (Round-2 W4, Round-3 disclosure). The
 * router validates the hash against this set so `#/cost`, `#/investigate`,
 * `#/standup`, `#/knowledge`, `#/memory`, `#/catalog`, `#/dashboard`, `#/models`,
 * `#/playbooks`, `#/roles`, and the Settings-folded account/sessions/security/users/
 * admin_sessions routes still resolve to their App.renderPage arm instead of falling
 * back to Overview. De-duplicated because some children (e.g. `chat`, `metrics`,
 * `inbox`) and hidden entries share an id with a rail item.
 */
export const PAGE_IDS: PageId[] = Array.from(
  new Set<PageId>([
    ...NAV_ITEMS.map((i) => i.id),
    ...NAV_CHILDREN.map((c) => c.id),
    ...FEATURES.map((f) => f.id),
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
  // Hidden-but-routable pages are not in NAV_ITEMS/NAV_CHILDREN, but the registry is the
  // single source of truth for labels — honour its declared label (correct multi-word
  // casing included) before falling back to a humanised id for a truly unknown one.
  const feat = FEATURES.find((f) => f.id === id);
  if (feat) return feat.label;
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, ' ');
}

/** Type guard: is the given string a known page id? */
export function isPageId(value: string): value is PageId {
  return (PAGE_IDS as string[]).includes(value);
}

/**
 * The single nav-visibility check for consumers that only have the RBAC axis handy
 * (Round-6 #42). Delegates to {@link featureEnabled} — the ONE authority combining the
 * three axes — supplying just `hasPermission`; a feature's own `enabled` override still
 * wins (e.g. one that gates on a prefs toggle with no `perm`), which a bare
 * `!perm || has()` check silently ignored. Consumers with the prefs/demo axes can call
 * {@link featureEnabled} directly with a fuller {@link FeatureCtx}.
 */
export function navVisible(
  node: { perm?: NavPerm; enabled?: (ctx: FeatureCtx) => boolean },
  has: (resource: string, action: string) => boolean,
): boolean {
  return featureEnabled(node, { hasPermission: has });
}
