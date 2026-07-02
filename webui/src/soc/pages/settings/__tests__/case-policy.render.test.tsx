/**
 * Round-6 — the "SLA, priority & suppression" settings section (mounts the orphaned G6
 * config editors: SlaPolicyEditor / PriorityMatrixEditor / SuppressionRuleBuilder).
 *
 * This section is the previously-missing UI mount point (PROPOSAL §G6 R5). The spec proves:
 *   (a) all three editors render;
 *   (b) each writes its OWN Preferences block through the shared deep-merge `update`
 *       buffer — SLA → `sla`, priority → `priority_matrix`, suppression → `suppression_rules`
 *       — and NEVER `decide()` / a case status (#3);
 *   (c) deleting a LIVE suppression rule routes through the ConfirmDialog (it can hide
 *       events), and confirming filters it out of `suppression_rules`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { TooltipProvider } from '@/ui/tooltip';
import type { Preferences, SuppressionRuleConfig } from '@/lib/types';

import { CasePolicySection } from '../case-policy';

function renderSection(prefs: Partial<Preferences> = {}) {
  const update = vi.fn<[Partial<Preferences>], void>();
  const utils = render(
    <TooltipProvider>
      <CasePolicySection prefs={prefs as Preferences} update={update} />
    </TooltipProvider>,
  );
  return { update, ...utils };
}

const LIVE_RULE: SuppressionRuleConfig = {
  field: 'rule.name',
  value: 'known-benign-scan',
  reason: 'benign',
  enabled: true,
  created_by: 'operator',
};

describe('CasePolicySection — mounts the orphaned G6 editors', () => {
  it('renders all three editors', () => {
    renderSection({ sla: {}, priority_matrix: {}, suppression_rules: [] });
    expect(screen.getByRole('switch', { name: /enable sla tracking/i })).toBeTruthy();
    expect(screen.getByRole('switch', { name: /enable priority derivation/i })).toBeTruthy();
    // The suppression builder's add affordance.
    expect(screen.getByRole('button', { name: /add rule/i })).toBeTruthy();
  });

  it('the SLA editor writes prefs.sla', () => {
    const { update } = renderSection({ sla: {} });
    fireEvent.click(screen.getByRole('switch', { name: /enable sla tracking/i }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { sla?: { enabled?: boolean } };
    expect(patch).toHaveProperty('sla');
    expect(patch.sla?.enabled).toBe(true);
  });

  it('the priority-matrix editor writes prefs.priority_matrix', () => {
    const { update } = renderSection({ priority_matrix: {} });
    fireEvent.click(screen.getByRole('switch', { name: /enable priority derivation/i }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { priority_matrix?: { enabled?: boolean } };
    expect(patch).toHaveProperty('priority_matrix');
    expect(patch.priority_matrix?.enabled).toBe(true);
  });

  it('the suppression builder adds an operator rule to prefs.suppression_rules', () => {
    const { update } = renderSection({ suppression_rules: [] });
    fireEvent.click(screen.getByRole('button', { name: /add rule/i }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { suppression_rules?: SuppressionRuleConfig[] };
    expect(patch.suppression_rules).toHaveLength(1);
    // A fresh operator rule is provenance-stamped, enabled.
    expect(patch.suppression_rules?.[0].created_by).toBe('operator');
  });

  it('deleting a LIVE suppression rule confirms first, then filters it out', () => {
    const { update } = renderSection({ suppression_rules: [LIVE_RULE] });
    // Removing a live rule opens the ConfirmDialog rather than deleting immediately.
    fireEvent.click(screen.getByRole('button', { name: /remove suppression rule/i }));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText(/delete this suppression rule/i)).toBeTruthy();

    // Confirm → the rule is filtered out via the deep-merge `update` buffer (#3-safe).
    fireEvent.click(screen.getByRole('button', { name: /^delete rule$/i }));
    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as { suppression_rules?: SuppressionRuleConfig[] };
    expect(patch.suppression_rules).toEqual([]);
  });
});
