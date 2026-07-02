/**
 * DetectionRulesHome — anomaly-tier SAVE wiring (Round-6 regression).
 *
 * Round-5 shipped the "Detection · Anomaly / Baseline" tier as a fully-editable,
 * selectable form whose Save was a SILENT no-op: `save()` handled only
 * `case_automation` + `detection_match`, so an anomaly rule closed the sheet as if it
 * saved while discarding the whole form. This pins the fix: an anomaly save now
 * persists the shared `Preferences.baseline` block through the deep-merge `update`
 * buffer (never `decide()`), preserving untouched sibling keys.
 *
 * `RuleEditor` is stubbed so we can switch the draft tier deterministically (the real
 * tier control is a Radix Select that jsdom cannot drive) without touching the adapter.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

vi.mock('@/soc/components/Can', async () => {
  const actual = await vi.importActual<typeof import('@/soc/components/Can')>('@/soc/components/Can');
  return { ...actual, useCan: () => true };
});

// A minimal stub: expose a button to flip the draft tier to anomaly (via onTierChange).
vi.mock('../RuleEditor', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  RuleEditor: (props: any) => (
    <div>
      <div data-testid="draft-tier">{props.value?.tier}</div>
      <button type="button" onClick={() => props.onTierChange?.('detection_anomaly')}>
        switch-to-anomaly
      </button>
    </div>
  ),
}));

import { DetectionRulesHome } from '../DetectionRulesHome';
import type { Preferences } from '@/lib/types';

const PREFS: Preferences = {
  // A catalog entry so the table (not the empty state) renders — the empty state also
  // has a "New rule" button, which would make the query ambiguous.
  rule_catalog: [
    {
      name: 'existing',
      enabled: true,
      match: { field: 'rule.id', op: 'equals', value: '1' },
      correlation: { mode: 'threshold', n: 5, window_seconds: 120, group_by: 'ip' },
      priority: 100,
    },
  ],
  baseline: { enabled: false, half_life_days: 7 },
};

describe('DetectionRulesHome — anomaly save wiring', () => {
  it('persists the shared baseline block instead of silently discarding the anomaly form', () => {
    const update = vi.fn();
    render(
      <TooltipProvider>
        <DetectionRulesHome prefs={PREFS} update={update} />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New rule' }));
    // Flip the new rule to the anomaly tier (seeds the form from the current baseline).
    fireEvent.click(screen.getByRole('button', { name: 'switch-to-anomaly' }));
    expect(screen.getByTestId('draft-tier').textContent).toBe('detection_anomaly');
    // Save now writes `baseline` (never a no-op, never `decide()`).
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));

    expect(update).toHaveBeenCalledTimes(1);
    const patch = update.mock.calls[0][0] as Partial<Preferences>;
    expect(patch).toHaveProperty('baseline');
    expect(patch.baseline?.modified_z_threshold).toBe(3.5);
    // untouched sibling keys survive the deep-merge-friendly mapping
    expect(patch.baseline?.half_life_days).toBe(7);
    // a config write only — never the automation/catalog blocks
    expect(patch).not.toHaveProperty('rule_catalog');
    expect(patch).not.toHaveProperty('threshold_automation');
  });
});
