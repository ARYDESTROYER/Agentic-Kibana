/**
 * nav.ts derivation-layer coverage (Round-6 nav batch).
 *
 * `nav.ts` is a thin derivation over the typed feature registry. Two invariants are
 * load-bearing but previously unguarded:
 *
 *   1. Every rail item (non-hidden feature) carries a REAL icon. `toNavItem` used to
 *      cast a missing icon to `undefined as unknown as LucideIcon`, converting a
 *      registry data mistake into a runtime white-screen when the shell rendered
 *      `<item.icon />`. It now fails fast at module-load instead; this pins that every
 *      derived NAV_ITEM has a defined, renderable icon.
 *
 *   2. `navLabel` sources its label from the registry (the single source of truth) for
 *      hidden-but-routable pages, only humanising a truly-unknown id as a last resort.
 */
import { describe, it, expect } from 'vitest';
import { NAV_ITEMS, navLabel } from '../nav';
import { FEATURES, type PageId } from '../registry';

describe('NAV_ITEMS — every rail item carries a real icon', () => {
  it('has a defined, renderable icon for every top-level nav item', () => {
    expect(NAV_ITEMS.length).toBeGreaterThan(0);
    for (const item of NAV_ITEMS) {
      expect(item.icon, `nav item ${item.id} is missing an icon`).toBeDefined();
      // A LucideIcon is a React component — a function or a forwardRef object.
      expect(['function', 'object']).toContain(typeof item.icon);
    }
  });
});

describe('navLabel — the registry is the authoritative label source', () => {
  // Pages that are hidden-but-routable only (NOT a rail item and NOT a disclosure
  // child), so navLabel must reach the FEATURES lookup rather than NAV_ITEMS/CHILDREN.
  const hiddenOnly: PageId[] = ['catalog', 'account', 'sessions', 'security', 'admin_sessions'];

  it.each(hiddenOnly)('resolves hidden page "%s" to its registry label', (id) => {
    const feat = FEATURES.find((f) => f.id === id);
    expect(feat, `registry has no feature ${id}`).toBeDefined();
    expect(navLabel(id)).toBe(feat!.label);
  });

  it('still resolves a rail item + a disclosure child to their registry labels', () => {
    expect(navLabel('cases')).toBe('Cases'); // top-level rail item
    expect(navLabel('standup')).toBe('Standup'); // disclosure child of Overview
  });

  it('humanises a truly-unknown id only as the last resort', () => {
    expect(navLabel('made_up_page' as PageId)).toBe('Made up page');
  });
});
