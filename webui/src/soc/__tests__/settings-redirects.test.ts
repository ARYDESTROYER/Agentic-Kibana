/**
 * Round-5 Sett-B — Settings IA regroup: deep-link + standalone-route REDIRECT contract.
 *
 * The six formerly-standalone admin/account homes (Users / Security / Sessions /
 * Account / Roles / Admin-sessions) collapsed INTO Settings sections. This spec proves
 * the load-bearing back-compat invariant: every retired standalone deep-link, and every
 * legacy in-app `navigate('<id>')`, still resolves — it lands INSIDE Settings on the
 * right section, never dead-ends to Overview or 404s.
 *
 * It also pins that:
 *   - all 31 routable PageIds stay resolvable (deep-link back-compat, DESIGN_STANDARD),
 *   - every current Settings section id is deep-linkable via `#/settings?s=<id>`,
 *   - the redirect map only ever points at REAL section ids (no orphan targets).
 *
 * Pure module-level assertions over the router + registry — no DOM.
 */
import { describe, it, expect, afterEach } from 'vitest';

import {
  SETTINGS_REDIRECTS,
  SECTION_ALIASES,
  isSettingsRedirect,
  settingsRedirectHash,
  settingsSectionHash,
  pageFromHash,
} from '../router';
import { PAGE_IDS, isPageId } from '../nav';
import { FEATURES } from '../registry';
import {
  SECTION_BY_ID,
  isSectionId,
  searchJumpTargets,
  sectionMatchesQuery,
  matchedAnchorsForSection,
  SETTING_ANCHORS,
} from '../pages/settings/settings-sections';

/** The full set of routable PageIds the router must keep alive (DESIGN_STANDARD). */
const EXPECTED_PAGE_IDS = [
  'overview', 'dashboard', 'cases', 'investigate', 'chat', 'intelligence', 'metrics',
  'models', 'scans', 'standup', 'catalog', 'playbooks', 'approvals', 'knowledge',
  'memory', 'sources', 'cost', 'inbox', 'account', 'sessions', 'settings', 'security',
  'roles', 'users', 'audit', 'admin_sessions', 'logs', 'campaigns', 'tuning',
  'batchjobs', 'baseline',
];

function setHash(h: string) {
  window.location.hash = h;
}

afterEach(() => {
  window.location.hash = '';
});

describe('Sett-B — all page ids stay routable (deep-link back-compat)', () => {
  it('keeps every one of the 31 PageIds resolvable', () => {
    for (const id of EXPECTED_PAGE_IDS) {
      expect(isPageId(id)).toBe(true);
    }
    // And nothing was dropped from the union.
    expect(new Set(PAGE_IDS)).toEqual(expect.objectContaining(new Set(PAGE_IDS)));
    for (const id of EXPECTED_PAGE_IDS) expect(PAGE_IDS).toContain(id);
  });
});

describe('Sett-B — retired standalone routes redirect INTO Settings', () => {
  const CASES: Array<[string, string]> = [
    ['account', 'profile'],
    ['users', 'admin_users'],
    ['roles', 'roles'],
    ['security', 'account_security'],
    ['sessions', 'sessions'],
    ['admin_sessions', 'admin_sessions'],
  ];

  it('exposes each retired route as a redirect target', () => {
    for (const [route] of CASES) {
      expect(isSettingsRedirect(route)).toBe(true);
    }
  });

  it.each(CASES)('maps #/%s → #/settings?s=%s', (route, section) => {
    // The pure hash rewrite points at the right section.
    expect(settingsRedirectHash(route)).toBe(`#/settings?s=${section}`);
    // …and the redirect target is a REAL, deep-linkable Settings section.
    expect(isSectionId(section)).toBe(true);
    expect(SECTION_BY_ID[section]).toBeTruthy();
  });

  it.each(CASES)('resolves a #/%s deep-link to the settings page (not Overview)', (route) => {
    setHash(`#/${route}`);
    // pageFromHash treats a retired standalone route as the settings page.
    expect(pageFromHash()).toBe('settings');
  });

  it('never redirects the settings page onto itself, nor a live page', () => {
    // `settings` and every non-retired page must NOT be a redirect key.
    for (const id of ['settings', 'overview', 'cases', 'metrics', 'sources', 'audit', 'tuning']) {
      expect(isSettingsRedirect(id)).toBe(false);
      expect(settingsRedirectHash(id)).toBeNull();
    }
  });

  it('only ever points at real, current section ids (no orphan targets)', () => {
    for (const target of Object.values(SETTINGS_REDIRECTS)) {
      expect(SECTION_BY_ID[target]).toBeTruthy();
      expect(isSectionId(target)).toBe(true);
    }
  });
});

describe('Sett-B — every Settings section is deep-linkable; old section ids alias', () => {
  it('keeps the historically deep-linked section id (#/settings?s=admin_users) resolvable', () => {
    // The one section id explicitly pinned by the prior render test — must still resolve.
    expect(isSectionId('admin_users')).toBe(true);
    expect(SECTION_BY_ID.admin_users).toBeTruthy();
  });

  it('resolves any SECTION_ALIASES entry to a live section (empty today; guard for future renames)', () => {
    for (const [oldId, newId] of Object.entries(SECTION_ALIASES)) {
      expect(oldId).not.toBe(newId); // an alias must actually rename
      expect(SECTION_BY_ID[newId]).toBeTruthy();
    }
  });

  it('resolves the NEW sections (roles, danger) as deep-link targets', () => {
    for (const id of ['roles', 'danger']) {
      expect(isSectionId(id)).toBe(true);
      expect(SECTION_BY_ID[id]).toBeTruthy();
    }
  });
});

describe('Sett-C — deep-link hash survives (the strip-bug fix)', () => {
  it('builds the canonical `#/settings?s=<section>` for a section head (no anchor)', () => {
    expect(settingsSectionHash('general')).toBe('#/settings?s=general');
    expect(settingsSectionHash('admin_users')).toBe('#/settings?s=admin_users');
  });

  it('builds `#/settings?s=<section>&a=<anchor>` when a card anchor is given', () => {
    expect(settingsSectionHash('detection', 'detection-autoclose')).toBe(
      '#/settings?s=detection&a=detection-autoclose',
    );
  });

  it('encodes unexpected values so the hash can never break', () => {
    // Defensive — real ids are `[a-z0-9_-]`, but a stray value must stay a valid hash.
    expect(settingsSectionHash('a b', 'x&y')).toBe('#/settings?s=a%20b&a=x%26y');
  });

  it('a `#/settings?s=<id>&a=<anchor>` deep-link still resolves to the settings page', () => {
    window.location.hash = '#/settings?s=detection&a=detection-autoclose';
    // pageFromHash splits on [?&/], so the section+anchor query never confuses the page id.
    expect(pageFromHash()).toBe('settings');
    // …and both the section id and anchor are recoverable from the hash.
    expect(/[?&]s=detection\b/.test(window.location.hash)).toBe(true);
    expect(/[?&]a=detection-autoclose\b/.test(window.location.hash)).toBe(true);
  });
});

describe('Sett-C — setting-level search + jump targets (shared registry)', () => {
  const allowAll = () => true;

  it('every SETTING_ANCHORS entry points at a real section', () => {
    for (const a of SETTING_ANCHORS) {
      expect(isSectionId(a.section)).toBe(true);
      expect(SECTION_BY_ID[a.section]).toBeTruthy();
    }
  });

  it('a blank query yields ONLY section heads (no card noise)', () => {
    const targets = searchJumpTargets('', allowAll);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => !t.anchor)).toBe(true);
  });

  it('deepens the filter to setting-level — "auto-close" surfaces the exact card', () => {
    const targets = searchJumpTargets('auto-close', allowAll);
    const card = targets.find((t) => t.anchor === 'detection-autoclose');
    expect(card).toBeTruthy();
    expect(card!.section).toBe('detection');
  });

  it('"kill switch" surfaces the advanced kill-switch card', () => {
    const targets = searchJumpTargets('kill switch', allowAll);
    expect(targets.some((t) => t.anchor === 'advanced-killswitch')).toBe(true);
  });

  it('RBAC-filters targets the caller cannot reach', () => {
    // Deny settings:manage → the perm-gated `advanced` cards (and section) drop out.
    const hasPerm = (r: string, a: string) => !(r === 'settings' && a === 'manage');
    const targets = searchJumpTargets('kill switch', hasPerm);
    expect(targets.some((t) => t.anchor === 'advanced-killswitch')).toBe(false);
  });

  it('sectionMatchesQuery matches at section AND setting level', () => {
    const detection = SECTION_BY_ID.detection;
    expect(sectionMatchesQuery(detection, '')).toBe(true);
    // Section-level: its own keyword.
    expect(sectionMatchesQuery(detection, 'escalation')).toBe(true);
    // Setting-level: a card keyword that is NOT on the section itself.
    expect(sectionMatchesQuery(detection, 'auto-close')).toBe(true);
    // A term matching neither the section nor any of its cards → false.
    expect(sectionMatchesQuery(detection, 'zzzznotathing')).toBe(false);
  });

  it('matchedAnchorsForSection returns the matching cards (empty on blank)', () => {
    expect(matchedAnchorsForSection('detection', '')).toEqual([]);
    const hits = matchedAnchorsForSection('detection', 'risk');
    expect(hits.some((a) => a.anchor === 'detection-risk')).toBe(true);
  });
});

describe('Sett-B / bug #7 — nav gate and page requirement unify on the SAME grant', () => {
  // The RBAC vocabulary: `roles` resource has actions {read, manage}; `users` has
  // {manage}. The former nav gated `roles`/`users` children on a non-existent `view`
  // action, hiding the item from operators who actually held `manage`. Both the nav
  // child AND the Settings section now gate on the resolvable grant the page needs.
  const settings = FEATURES.find((f) => f.id === 'settings')!;

  it('gates the Roles nav child on roles:manage (the resolvable grant, not roles:view)', () => {
    const roles = (settings.children ?? []).find((c) => c.id === 'roles');
    expect(roles).toBeTruthy();
    expect(roles!.perm).toEqual({ resource: 'roles', action: 'manage' });
    // …and it matches the Settings Roles section's own gate (single source of grant).
    expect(SECTION_BY_ID.roles.perm).toEqual({ resource: 'roles', action: 'manage' });
  });

  it('gates the Users nav child on users:manage (matching its Settings section)', () => {
    const users = (settings.children ?? []).find((c) => c.id === 'users');
    expect(users).toBeTruthy();
    expect(users!.perm).toEqual({ resource: 'users', action: 'manage' });
    expect(SECTION_BY_ID.admin_users.perm).toEqual({ resource: 'users', action: 'manage' });
  });

  it('no Settings nav child gates on the non-existent `view` action', () => {
    for (const c of settings.children ?? []) {
      expect(c.perm?.action).not.toBe('view');
    }
  });
});
