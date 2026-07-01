/**
 * ConditionBuilder spec (Round-5 G6 · R3) — the flat `{field, op, value}` AND-row
 * builder. Proves rows add/remove, the value input hides for the `exists` op, and
 * edits flow through `onChange` as the `RuleMatch`-shaped predicate list.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/ui/tooltip';

import { ConditionBuilder } from '../ConditionBuilder';
import type { PredicateRow } from '../types';

function setup(initial: PredicateRow[]) {
  const onChange = vi.fn();
  const rerender = (rows: PredicateRow[]) =>
    render(
      <TooltipProvider>
        <ConditionBuilder value={rows} onChange={onChange} />
      </TooltipProvider>,
    );
  const view = rerender(initial);
  return { onChange, view };
}

describe('ConditionBuilder', () => {
  it('renders one row for a single predicate', () => {
    setup([{ field: 'rule.id', op: 'equals', value: '5710' }]);
    expect(screen.getByLabelText('Condition 1 field')).toHaveValue('rule.id');
    expect(screen.getByLabelText('Condition 1 value')).toHaveValue('5710');
    // no second row
    expect(screen.queryByLabelText('Condition 2 field')).toBeNull();
  });

  it('adds a new AND row via "Add condition"', () => {
    const { onChange } = setup([{ field: 'rule.id', op: 'equals', value: '5710' }]);
    fireEvent.click(screen.getByRole('button', { name: /add condition/i }));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as PredicateRow[];
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual({ field: '', op: 'equals', value: '' });
  });

  it('removes a row, keeping at least one', () => {
    const { onChange } = setup([
      { field: 'a', op: 'equals', value: '1' },
      { field: 'b', op: 'equals', value: '2' },
    ]);
    fireEvent.click(screen.getByLabelText('Remove condition 2'));
    const next = onChange.mock.calls[0][0] as PredicateRow[];
    expect(next).toEqual([{ field: 'a', op: 'equals', value: '1' }]);
  });

  it('edits a field through onChange', () => {
    const { onChange } = setup([{ field: '', op: 'equals', value: '' }]);
    fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'user.name' } });
    const next = onChange.mock.calls[0][0] as PredicateRow[];
    expect(next[0].field).toBe('user.name');
  });

  it('hides the value input for the `exists` op', () => {
    // Start with an `exists` predicate — the value input must not render.
    setup([{ field: 'rule.tags', op: 'exists' }]);
    expect(screen.getByLabelText('Condition 1 field')).toBeInTheDocument();
    expect(screen.queryByLabelText('Condition 1 value')).toBeNull();
    expect(screen.getByText(/no value needed/i)).toBeInTheDocument();
  });

  it('labels the second row with an implicit AND', () => {
    setup([
      { field: 'a', op: 'equals', value: '1' },
      { field: 'b', op: 'equals', value: '2' },
    ]);
    expect(screen.getByText('and')).toBeInTheDocument();
  });
});
