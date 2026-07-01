/**
 * RuleEditor — jest-axe accessibility smoke (Round-5 G9 · DESIGN_STANDARD §6).
 *
 * A rules editor (`soc/rules`) is one of the five load-bearing surfaces the a11y sweep
 * pins. It is a dense config-writer form (four section tabs · condition builder ·
 * threshold knobs · enable switch) — exactly the kind of surface where an unlabeled
 * control or a broken tab/aria relationship regresses silently. We render the editor
 * with a representative detection-match rule (the richest Define surface) inside the
 * app's TooltipProvider and assert the rendered tree has no axe violations.
 *
 * The editor is a pure config-writer (edits flow through `onChange`, never `decide()`),
 * so asserting on its static markup touches no runtime / #3 behaviour.
 *
 * ── H4 FIXED — full ruleset, nothing scoped out ─────────────────────────────────────
 * Previously `button-name` was scoped out here: `Field` injected its generated `id` onto
 * the Radix `<Select>` *root* (a context provider that renders no DOM), not the underlying
 * `role="combobox"` trigger, so `<label htmlFor>` never named the trigger and axe reported
 * a nameless button. H4's fix makes every Field-wrapped Select use the render-prop and
 * forward `id` + `aria-labelledby` to its `<SelectTrigger>`. We now run the FULL axe
 * ruleset (no scoped exceptions) so the whole surface — including combobox naming — is
 * guarded against regression.
 */
import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';

// jest-axe ships its own matcher; register it on Vitest's expect.
expect.extend(toHaveNoViolations);

import { TooltipProvider } from '@/ui/tooltip';
import { RuleEditor } from '../RuleEditor';
import { newRuleForm } from '../constants';
import type { RuleForm } from '../types';

describe('RuleEditor — a11y smoke (jest-axe)', () => {
  it('has no axe violations on the detection-match Define surface', async () => {
    const form = newRuleForm('detection_match') as Extract<RuleForm, { tier: 'detection_match' }>;
    form.predicates = [{ field: 'rule.id', op: 'equals', value: '5710' }];

    const { container } = render(
      <TooltipProvider>
        <RuleEditor value={form} onChange={() => {}} />
      </TooltipProvider>,
    );

    // Full axe ruleset — H4 named every combobox trigger, so nothing is scoped out.
    expect(await axe(container)).toHaveNoViolations();
  });

  it('names every combobox trigger — the anomaly Group-by / Seasonality Selects (H4 regression guard)', async () => {
    // The anomaly tier renders the Field-wrapped "Group by" + "Seasonality" Selects whose
    // triggers used to be nameless (Field cloned its id onto the DOM-less Radix Root).
    // Assert the accessible name now resolves via the forwarded aria-labelledby.
    const form = newRuleForm('detection_anomaly') as Extract<RuleForm, { tier: 'detection_anomaly' }>;

    const { getAllByRole } = render(
      <TooltipProvider>
        <RuleEditor value={form} onChange={() => {}} />
      </TooltipProvider>,
    );

    const combos = getAllByRole('combobox');
    expect(combos.length).toBeGreaterThan(0);
    for (const c of combos) {
      // Every combobox must expose a non-empty accessible name (aria-label OR the
      // aria-labelledby target Field wires up).
      const label = c.getAttribute('aria-label');
      const labelledBy = c.getAttribute('aria-labelledby');
      const named =
        (label && label.trim().length > 0) ||
        (labelledBy != null &&
          labelledBy
            .split(/\s+/)
            .some((id) => (document.getElementById(id)?.textContent || '').trim().length > 0));
      expect(named).toBe(true);
    }
  });
});
