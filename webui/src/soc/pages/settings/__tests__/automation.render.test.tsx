/**
 * Round-6 de-dup — the slimmed Automation settings section.
 *
 * Two surfaces used to edit the SAME `threshold_automation.rules` (this legacy section
 * AND the G6 "Detection & rules" home). The Detection & rules home is now THE editor.
 * This spec proves the de-dup:
 *
 *   (a) the section keeps the NON-rule master switch — toggling it patches
 *       `threshold_automation.enabled` (and NEVER touches `.rules`, #3-safe);
 *   (b) the former embedded per-rule editor is GONE — no "Add rule" button, no verdict
 *       condition dropdown (that editor now lives in RuleEditor, covered by the rules specs);
 *   (c) a clear link card routes to the Detection & rules home via `onOpenRules`
 *       (wired by the Settings page to `setSection('detection_rules')`).
 *
 * The section imports no api client anymore, so the test is fully offline.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { AutomationRule, Preferences } from '@/lib/types';

import { AutomationSection } from '../automation';

function prefsWithRules(rules: AutomationRule[], enabled = false): Preferences {
  return { threshold_automation: { enabled, rules } } as unknown as Preferences;
}

function renderSection(prefs: Preferences, onOpenRules = vi.fn()) {
  const update = vi.fn<[Partial<Preferences>], void>();
  const utils = render(
    <TooltipProvider>
      <AutomationSection prefs={prefs} update={update} onOpenRules={onOpenRules} />
    </TooltipProvider>,
  );
  return { update, onOpenRules, ...utils };
}

const A_RULE: AutomationRule = {
  id: 'rule-1',
  enabled: true,
  priority: 100,
  conditions: { verdict: 'true_positive' },
  action: 'tag',
  payload: { tags: ['auto'] },
};

describe('Round-6 — Automation section is de-duplicated (no embedded rule editor)', () => {
  it('keeps the master switch: toggling it patches threshold_automation.enabled only', () => {
    const { update } = renderSection(prefsWithRules([A_RULE], false));
    const sw = screen.getByRole('switch', { name: /threshold automation enabled/i });
    fireEvent.click(sw);

    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as {
      threshold_automation?: { enabled?: boolean; rules?: AutomationRule[] };
    };
    expect(patch.threshold_automation?.enabled).toBe(true);
    // #3-safe: the master toggle never rewrites the rules list.
    expect(patch.threshold_automation?.rules).toEqual([A_RULE]);
  });

  it('no longer renders the embedded per-rule editor (moved to Detection & rules)', () => {
    renderSection(prefsWithRules([A_RULE]));
    // The old editor exposed an "Add rule" button + a per-rule verdict-condition dropdown.
    expect(screen.queryByRole('button', { name: /add rule/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /verdict/i })).toBeNull();
    // …and the impossible-verdict migrate affordance is gone from here too.
    expect(screen.queryByRole('button', { name: /migrate/i })).toBeNull();
  });

  it('links to the Detection & rules home and reports the current rule count', () => {
    const { onOpenRules } = renderSection(prefsWithRules([A_RULE]));
    // The count of existing case-automation rules is surfaced (plain text, #9).
    expect(screen.getByText(/1 case-automation rule\b/i)).toBeTruthy();
    const link = screen.getByRole('button', { name: /open detection & rules/i });
    fireEvent.click(link);
    expect(onOpenRules).toHaveBeenCalledTimes(1);
  });

  it('renders without a link button when onOpenRules is absent (standalone render)', () => {
    const update = vi.fn();
    render(
      <TooltipProvider>
        <AutomationSection prefs={prefsWithRules([])} update={update} />
      </TooltipProvider>,
    );
    expect(screen.queryByRole('button', { name: /open detection & rules/i })).toBeNull();
    // The empty-count copy still renders.
    expect(screen.getByText(/no case-automation rules yet/i)).toBeTruthy();
  });
});
