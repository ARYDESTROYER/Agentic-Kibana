/**
 * DetectionRulesHome + registration spec (Round-5 G6 · R2).
 *
 * Proves:
 *  - the home lists BOTH rule families (detection catalog + case-automation) plainly,
 *  - a config edit (delete) flows through the deep-merge `update` buffer, writing the
 *    exact wire key — never a `decide()` call,
 *  - the "Detection & rules" section is REGISTERED in the settings registry under the
 *    General group, ON BY DEFAULT, gated on the unified `rules` resource (M2 / R9) —
 *    the SAME resource the backend `routes_rules.py` enforces, end-to-end.
 *
 * `useCan` is mocked to grant manage (auth-off back-compat) so the table + actions render.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

// Grant manage so mutations render (mirrors the auth-off default where useCan===true).
vi.mock('@/soc/components/Can', async () => {
  const actual = await vi.importActual<typeof import('@/soc/components/Can')>('@/soc/components/Can');
  return { ...actual, useCan: () => true };
});

import { DetectionRulesHome } from '../DetectionRulesHome';
import { RULES_PERM, RULES_READ_PERM } from '../types';
import type { Preferences } from '@/lib/types';

import {
  SECTION_BY_ID,
  SECTION_GROUPS,
  SECTION_KEYS,
  isSectionId,
} from '@/soc/pages/settings/settings-sections';

const PREFS: Preferences = {
  rule_catalog: [
    {
      name: 'ssh-bruteforce',
      enabled: true,
      description: 'many failed logins',
      match: { field: 'rule.id', op: 'equals', value: '5710' },
      correlation: { mode: 'threshold', n: 5, window_seconds: 120, group_by: 'ip' },
      priority: 100,
    },
  ],
  threshold_automation: {
    enabled: true,
    rules: [{ id: 'rule-tag', enabled: true, priority: 50, conditions: {}, action: 'tag', payload: { tags: ['x'] } }],
  },
};

function renderHome(prefs: Preferences = PREFS) {
  const update = vi.fn();
  render(
    <TooltipProvider>
      <DetectionRulesHome prefs={prefs} update={update} />
    </TooltipProvider>,
  );
  return { update };
}

describe('DetectionRulesHome', () => {
  it('lists both rule families in one table (plain text)', () => {
    renderHome();
    expect(screen.getByRole('button', { name: 'ssh-bruteforce' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'rule-tag' })).toBeInTheDocument();
    // the #3 guard is surfaced
    expect(screen.getByText(/never the verdict/i)).toBeInTheDocument();
  });

  it('deleting a detection rule writes rule_catalog via the deep-merge buffer (never decide())', () => {
    const { update } = renderHome();
    fireEvent.click(screen.getByLabelText('Delete ssh-bruteforce'));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as Partial<Preferences>;
    expect(patch).toHaveProperty('rule_catalog');
    expect(patch.rule_catalog).toEqual([]);
    // it does NOT touch the automation block on a detection delete
    expect(patch).not.toHaveProperty('threshold_automation');
  });

  it('deleting a case-automation rule writes threshold_automation.rules only', () => {
    const { update } = renderHome();
    fireEvent.click(screen.getByLabelText('Delete rule-tag'));
    const patch = update.mock.calls[0][0] as Partial<Preferences>;
    expect(patch.threshold_automation?.rules).toEqual([]);
    // the master `enabled` flag is preserved (deep-merge friendly)
    expect(patch.threshold_automation?.enabled).toBe(true);
  });

  it('opens the editor sheet when a rule name is clicked', () => {
    renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'ssh-bruteforce' }));
    expect(screen.getByRole('tab', { name: 'Define' })).toBeInTheDocument();
  });
});

describe('Detection & rules section registration', () => {
  it('is registered as `detection_rules`, ON BY DEFAULT, in the General group', () => {
    expect(isSectionId('detection_rules')).toBe(true);
    const def = SECTION_BY_ID.detection_rules;
    expect(def).toBeDefined();
    expect(def.group).toBe('general');
    expect(typeof def.Component).toBe('function');
    expect(def.title).toBe('Detection & rules');

    const general = SECTION_GROUPS.find((g) => g.id === 'general')!;
    expect(general.sections.map((s) => s.id)).toContain('detection_rules');
  });

  it('gates the section + mutations on the UNIFIED `rules` resource, matching the backend (M2 / R9)', () => {
    const def = SECTION_BY_ID.detection_rules;
    // M2 fix: the backend `routes_rules.py` enforces `rules:read`/`rules:manage` on the
    // WHOLE surface (nav → ledger → rollback → preview). The FE MUST gate on the SAME
    // resource end-to-end — NOT the legacy `automation` resource — so a custom role
    // granted the advertised unified `rules:*` can actually see/use the editor (and a
    // role without it is honestly blocked instead of seeing 403-ing buttons). For every
    // built-in role `rules`/`automation`/`settings` derive identically, so this is
    // behaviour-preserving for them and correct for custom roles.
    expect(def.perm).toEqual({ resource: 'rules', action: 'read' });
    expect(RULES_PERM).toEqual({ resource: 'rules', action: 'manage' });
    expect(RULES_READ_PERM).toEqual({ resource: 'rules', action: 'read' });
    // The section-visibility gate and the mutation gate agree on the resource (one
    // surface, one resource) — the exact drift M2 fixes.
    expect(def.perm?.resource).toBe(RULES_PERM.resource);
    expect(def.perm?.resource).toBe(RULES_READ_PERM.resource);
  });

  it('owns the rule_catalog + threshold_automation keys (dirty-map)', () => {
    expect(SECTION_KEYS.detection_rules).toEqual(['rule_catalog', 'threshold_automation']);
  });
});
