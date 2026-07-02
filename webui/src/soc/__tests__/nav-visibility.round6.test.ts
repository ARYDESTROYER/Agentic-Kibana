/**
 * nav.ts visibility authority (Round-6 #42).
 *
 * The registry advertises `featureEnabled(node, ctx)` as the SINGLE place the three
 * visibility axes (RBAC / prefs-toggle / demo) combine, but `nav.ts` used to DROP a
 * feature's `enabled` override at the `toNavItem`/`toNavChild` derivation boundary — so
 * a consumer that only did `!perm || has()` (NavSidebar/CommandPalette) silently ignored
 * it. This pins the two owned-file fixes:
 *
 *   1. `navVisible` is the single RBAC-axis entry point and DELEGATES to `featureEnabled`
 *      (so an `enabled` override wins over a perm-only check — the exact bug).
 *   2. the derivation carries `enabled` through onto NavItem/NavChild (a feature that
 *      supplies one is no longer stripped), so a consumer routed through `navVisible`
 *      honours it.
 */
import { describe, it, expect } from 'vitest';
import { navVisible, featureEnabled, type NavItem, type NavChild } from '../nav';

describe('navVisible — the single nav-visibility authority (#42)', () => {
  const grantAll = () => true;
  const denyAll = () => false;
  const grantOnly =
    (res: string, act: string) => (r: string, a: string) => r === res && a === act;

  it('falls back to the perm check when there is no enabled override', () => {
    // No perm → always visible (back-compat: visible when RBAC is off).
    expect(navVisible({}, grantAll)).toBe(true);
    // A perm → gated by the grant.
    expect(navVisible({ perm: { resource: 'audit', action: 'view' } }, grantAll)).toBe(true);
    expect(navVisible({ perm: { resource: 'audit', action: 'view' } }, denyAll)).toBe(false);
    expect(
      navVisible({ perm: { resource: 'audit', action: 'view' } }, grantOnly('audit', 'view')),
    ).toBe(true);
    expect(
      navVisible({ perm: { resource: 'audit', action: 'view' } }, grantOnly('cases', 'read')),
    ).toBe(false);
  });

  it('honours an `enabled` override with NO perm (a bare `!perm || has()` check ignored it)', () => {
    // A feature gated ONLY on a prefs/demo axis: no perm, an enabled predicate. The old
    // ad-hoc check would show it unconditionally; navVisible defers to the override.
    expect(navVisible({ enabled: () => false }, grantAll)).toBe(false);
    expect(navVisible({ enabled: () => true }, denyAll)).toBe(true);
  });

  it('is a thin delegate to featureEnabled for the RBAC ctx', () => {
    const node = { perm: { resource: 'metrics', action: 'view' } };
    const has = grantOnly('metrics', 'view');
    expect(navVisible(node, has)).toBe(featureEnabled(node, { hasPermission: has }));
  });
});

describe('nav derivation carries `enabled` through onto the nav shapes (#42)', () => {
  it('a NavItem/NavChild carrying `enabled` is honoured by navVisible end-to-end', () => {
    // Simulate a derived nav item/child that came from a registry feature with an
    // `enabled` override (the derivation now copies it instead of dropping it). The
    // type accepts the field, and navVisible routes through it.
    const item: NavItem = {
      id: 'cases',
      label: 'Cases',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icon: (() => null) as any,
      group: 'triage',
      enabled: () => false,
    };
    const child: NavChild = { id: 'standup', label: 'Standup', enabled: () => true };
    // enabled=false wins even though there is no perm and the caller grants everything.
    expect(navVisible(item, () => true)).toBe(false);
    // enabled=true wins even though the caller denies everything.
    expect(navVisible(child, () => false)).toBe(true);
  });
});
