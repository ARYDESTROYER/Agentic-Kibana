/**
 * Round-5 Sett-A — the data-driven Settings section registry.
 *
 * Proves the SINGLE source of truth (`settings-sections.ts`) is internally consistent
 * and that the three formerly hand-synced structures are now DERIVED from it:
 *   - the `SectionId` union ⇄ registry ids,
 *   - the grouped rail (`SECTION_GROUPS`) preserves order,
 *   - the per-section dirty map (`SECTION_KEYS`) is derived from `ownedKeys`,
 *   - `settings-dirty` re-exports the SAME derived `SECTION_KEYS` (no drift),
 *   - `GRID_SECTIONS` reflects the Automation double-wrap fix,
 *   - every section has a Component + the lookup covers every id.
 *
 * Pure data assertions — no rendering, no DOM.
 */
import { describe, it, expect } from 'vitest';

import {
  SETTINGS_SECTIONS,
  SECTION_GROUPS,
  SECTION_BY_ID,
  SECTION_KEYS,
  GRID_SECTIONS,
  ALL_SECTIONS,
  isSectionId,
} from '../settings-sections';
import { SECTION_KEYS as DIRTY_SECTION_KEYS } from '../../settings-dirty';

/** The exact set of section ids the page must keep routable (deep-link back-compat). */
const EXPECTED_IDS = [
  'profile',
  'account_security',
  'sessions',
  'customization',
  'general',
  'models',
  'keys',
  'detection',
  'detection_rules', // NEW (Round-5 G6 R2: unified "Detection & rules" home)
  'cases',
  'automation',
  'standup',
  'notifications',
  'enrichment',
  'knowledge',
  'admin_users',
  'roles', // NEW (Round-5 Sett-B: split out of Users into Security & access)
  'security',
  'admin_sessions',
  'appearance',
  'advanced',
  'advanced_all', // NEW (Round-5 Sett-C: schema-driven "All settings" generic renderer)
  'demo',
  'danger', // NEW (Round-5 Sett-B: isolated Danger zone, last)
].sort();

describe('settings section registry — single source of truth', () => {
  it('registers every expected section id exactly once', () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id).sort();
    expect(ids).toEqual(EXPECTED_IDS);
    // no duplicate ids
    expect(new Set(ids).size).toBe(ids.length);
    expect(ALL_SECTIONS).toBe(SETTINGS_SECTIONS);
  });

  it('exposes a lookup covering every id, each with a Component', () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(SECTION_BY_ID[s.id]).toBe(s);
      expect(typeof s.Component).toBe('function');
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(0);
    }
    // No stray keys beyond the registered ids.
    expect(Object.keys(SECTION_BY_ID).sort()).toEqual(EXPECTED_IDS);
  });

  it('isSectionId accepts registered ids and rejects unknowns', () => {
    expect(isSectionId('general')).toBe(true);
    expect(isSectionId('admin_users')).toBe(true);
    expect(isSectionId('demo')).toBe(true);
    expect(isSectionId('not-a-section')).toBe(false);
    expect(isSectionId('')).toBe(false);
  });
});

describe('grouped rail derivation (Round-5 Sett-B: 5 groups, Security promoted)', () => {
  it('groups sections in the canonical FIVE-group order, non-empty', () => {
    expect(SECTION_GROUPS.map((g) => g.id)).toEqual([
      'account',
      'general',
      'integrations',
      'security_access',
      'organization',
    ]);
    for (const g of SECTION_GROUPS) expect(g.sections.length).toBeGreaterThan(0);
  });

  it('every registered section appears in exactly one group', () => {
    const grouped = SECTION_GROUPS.flatMap((g) => g.sections.map((s) => s.id)).sort();
    expect(grouped).toEqual(EXPECTED_IDS);
  });

  it('preserves the registry order within a group', () => {
    // General group: general, models, detection, cases, automation, standup.
    const general = SECTION_GROUPS.find((g) => g.id === 'general')!;
    expect(general.sections.map((s) => s.id)).toEqual([
      'general',
      'models',
      'detection',
      'detection_rules',
      'cases',
      'automation',
      'standup',
    ]);
    // Security & access group: Users → Roles → SSO → Active sessions → Secret keys.
    const sec = SECTION_GROUPS.find((g) => g.id === 'security_access')!;
    expect(sec.sections.map((s) => s.id)).toEqual([
      'admin_users',
      'roles',
      'security',
      'admin_sessions',
      'keys',
    ]);
    // Organization group ends with the isolated Danger zone (last).
    const org = SECTION_GROUPS.find((g) => g.id === 'organization')!;
    expect(org.sections.map((s) => s.id)).toEqual([
      'appearance',
      'advanced',
      'advanced_all',
      'demo',
      'danger',
    ]);
    expect(org.sections[org.sections.length - 1].id).toBe('danger');
  });

  it('caps the hierarchy at TWO levels (group → section; no nested sub-groups)', () => {
    // Each section is a flat leaf under exactly one group — no section carries its own
    // children/sub-sections, so the rail can never exceed group → section → in-page.
    for (const s of SETTINGS_SECTIONS) {
      expect('children' in s).toBe(false);
    }
  });
});

describe('SECTION_KEYS is derived from ownedKeys (kills the 3-file hand-sync)', () => {
  it('re-exported identically from settings-dirty', () => {
    expect(DIRTY_SECTION_KEYS).toBe(SECTION_KEYS);
  });

  it('contains only sections that declare ownedKeys', () => {
    for (const s of SETTINGS_SECTIONS) {
      if (s.ownedKeys && s.ownedKeys.length > 0) {
        expect(SECTION_KEYS[s.id]).toEqual(s.ownedKeys);
      } else {
        expect(s.id in SECTION_KEYS).toBe(false);
      }
    }
  });

  it('tracks the auto-close keys on detection (Round-5 R1) and both rag homes', () => {
    expect(SECTION_KEYS.detection).toContain('auto_close');
    expect(SECTION_KEYS.detection).toContain('fp_auto_close');
    // rag is owned by BOTH knowledge and advanced (honest dual-dot signal).
    expect(SECTION_KEYS.knowledge).toContain('rag');
    expect(SECTION_KEYS.advanced).toContain('rag');
  });

  it('leaves the embedded / self-saving sections out of the dirty map', () => {
    // These manage their own save lifecycle (embedded bodies, write-only keys,
    // enrichment's self-contained provider editor, roles matrix, danger-zone resets).
    for (const id of ['profile', 'account_security', 'sessions', 'customization', 'keys', 'admin_users', 'roles', 'admin_sessions', 'appearance', 'demo', 'danger']) {
      expect(id in SECTION_KEYS).toBe(false);
    }
  });
});

describe('GRID_SECTIONS (full-width, no outer Card) — incl. the automation double-wrap fix', () => {
  it('includes the multi-card grid sections AND automation', () => {
    // general/detection/knowledge/advanced render their own SettingsGrid; automation
    // was moved here in Sett-A so its bordered rule cards no longer sit in a card-in-a-card.
    for (const id of ['general', 'detection', 'knowledge', 'advanced', 'automation']) {
      expect(GRID_SECTIONS.has(id)).toBe(true);
    }
  });

  it('excludes the single-card sections', () => {
    for (const id of ['models', 'keys', 'cases', 'standup', 'enrichment', 'security']) {
      expect(GRID_SECTIONS.has(id)).toBe(false);
    }
  });
});
