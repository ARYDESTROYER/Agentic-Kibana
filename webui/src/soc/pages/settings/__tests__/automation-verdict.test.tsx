/**
 * Round-5 Rules-FE bug #6 — the case-automation verdict-condition fix.
 *
 * A `CaseAutomationRule`'s `verdict` condition is compared against the case's LLM
 * `Verdict`, which is ONLY ever `false_positive` / `true_positive` / `needs_human`
 * (backend `constants.Verdict`; `engine/threshold_automation._rule_matches` does a
 * case-insensitive equality against `case.verdict.value`). The old editor also
 * offered `suspicious` / `benign` — those are `Disposition` values (the investigative
 * OUTCOME axis) and can NEVER equal a `Verdict`, so a rule conditioned on them
 * silently never fired. This spec proves the fix:
 *
 *   (a) the verdict dropdown offers ONLY the three real Verdict values (+ "Any") —
 *       `suspicious` / `benign` are gone;
 *   (b) a saved rule with an impossible verdict surfaces a clear
 *       "inactive — invalid condition" badge;
 *   (c) the one-click "Migrate" clears ONLY the invalid verdict (keeps every other
 *       condition) and writes it back through the deep-merge `update` buffer —
 *       it NEVER sets a case status (HITL-safe, #3);
 *   (d) a rule with a VALID verdict shows no invalid badge / migrate button.
 *
 * The api client is mocked so the test is fully offline (no playbook fetch).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const { getPlaybooksMock } = vi.hoisted(() => ({ getPlaybooksMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getPlaybooks: getPlaybooksMock },
}));

import { AutomationSection } from '../automation';
import { TooltipProvider } from '@/ui/tooltip';
import type { AutomationRule, Preferences } from '@/lib/types';

beforeEach(() => {
  getPlaybooksMock.mockReset();
  getPlaybooksMock.mockResolvedValue({ enabled: false, playbooks: [] });
});

/** Build a Preferences whose threshold_automation holds the given rules (enabled). */
function prefsWithRules(rules: AutomationRule[]): Preferences {
  return {
    threshold_automation: { enabled: true, rules },
  } as unknown as Preferences;
}

function renderSection(prefs: Preferences) {
  const update = vi.fn<[Partial<Preferences>], void>();
  const utils = render(
    <TooltipProvider>
      <AutomationSection prefs={prefs} update={update} />
    </TooltipProvider>,
  );
  return { update, ...utils };
}

/** Merge every patch seen by `update` into one object (the effective PUT the page sends). */
function mergedPatch(update: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return update.mock.calls.reduce<Record<string, unknown>>((acc, [p]) => ({ ...acc, ...p }), {});
}

const VALID_RULE: AutomationRule = {
  id: 'rule-valid',
  enabled: true,
  priority: 100,
  conditions: { verdict: 'true_positive', min_risk: 40 },
  action: 'tag',
  payload: { tags: ['auto'] },
};

const INVALID_RULE: AutomationRule = {
  id: 'rule-legacy',
  enabled: true,
  priority: 100,
  // `suspicious` is a Disposition, not a Verdict — this rule can never fire.
  conditions: { verdict: 'suspicious', min_risk: 40, source_id: 'src-1' },
  action: 'tag',
  payload: { tags: ['auto'] },
};

describe('Rules-FE bug #6 — verdict condition only accepts real Verdict values', () => {
  it('the verdict dropdown offers only the three Verdict values (no suspicious/benign)', async () => {
    renderSection(prefsWithRules([VALID_RULE]));

    // Open the verdict Select for the (only) rule.
    const trigger = await screen.findByRole('combobox', { name: /verdict/i });
    fireEvent.click(trigger);

    // The three real Verdict values + "Any verdict" are present…
    await screen.findByRole('option', { name: /^any verdict$/i });
    expect(screen.getByRole('option', { name: /^true positive$/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^false positive$/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /^needs human$/i })).toBeTruthy();

    // …and the Disposition values are GONE.
    expect(screen.queryByRole('option', { name: /^suspicious$/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /^benign$/i })).toBeNull();
  });

  it('a saved rule with an impossible verdict shows the "inactive — invalid condition" badge', () => {
    renderSection(prefsWithRules([INVALID_RULE]));
    expect(screen.getByText(/inactive — invalid condition/i)).toBeTruthy();
    // The offending legacy value is surfaced (plain text, #9) so the operator sees it.
    expect(screen.getByText(/suspicious \(invalid\)/i)).toBeTruthy();
  });

  it('a valid rule shows no invalid badge and no migrate button', () => {
    renderSection(prefsWithRules([VALID_RULE]));
    expect(screen.queryByText(/inactive — invalid condition/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /migrate/i })).toBeNull();
  });

  it('one-click migrate clears ONLY the invalid verdict, keeps other conditions, never sets status', () => {
    const { update } = renderSection(prefsWithRules([INVALID_RULE]));

    const migrate = screen.getByRole('button', { name: /migrate/i });
    fireEvent.click(migrate);

    expect(update).toHaveBeenCalled();
    const patch = mergedPatch(update) as {
      threshold_automation?: { rules?: AutomationRule[] };
    };
    const rules = patch.threshold_automation?.rules;
    expect(rules).toHaveLength(1);
    const cond = rules![0].conditions || {};

    // The invalid verdict is cleared (→ "Any verdict")…
    expect(cond.verdict).toBeUndefined();
    // …but every OTHER condition is preserved.
    expect(cond.min_risk).toBe(40);
    expect(cond.source_id).toBe('src-1');

    // HITL-safe (#3): automation never sets a case status/disposition. The migrated
    // rule carries no status/disposition field, and the action is unchanged.
    expect(rules![0].action).toBe('tag');
    expect('status' in rules![0]).toBe(false);
    expect('disposition' in rules![0]).toBe(false);
  });

  it('after migrate the rule is valid: the invalid badge is gone', async () => {
    // Drive the component with a controlled buffer so the re-render reflects the patch.
    let prefs = prefsWithRules([INVALID_RULE]);
    const update = vi.fn((patch: Partial<Preferences>) => {
      prefs = { ...prefs, ...patch } as Preferences;
    });

    const { rerender } = render(
      <TooltipProvider>
        <AutomationSection prefs={prefs} update={update} />
      </TooltipProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /migrate/i }));

    rerender(
      <TooltipProvider>
        <AutomationSection prefs={prefs} update={update} />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(screen.queryByText(/inactive — invalid condition/i)).toBeNull();
    });
  });
});
