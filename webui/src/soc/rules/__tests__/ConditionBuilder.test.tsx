/**
 * ConditionBuilder spec (Round-5 G6 · R3) — the single `{field, op, value}`
 * predicate editor. Proves unsupported multi-predicate controls stay absent, the
 * value input hides for `exists`, and edits emit exactly one wire-shaped row.
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

  it('does not expose unsupported multi-predicate controls or rows', () => {
    setup([
      { field: 'a', op: 'equals', value: '1' },
      { field: 'b', op: 'equals', value: '2' },
    ]);
    expect(screen.getByLabelText('Condition 1 field')).toHaveValue('a');
    expect(screen.queryByLabelText('Condition 2 field')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add condition/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /remove condition/i })).not.toBeInTheDocument();
  });

  it('edits a field through onChange', () => {
    const { onChange } = setup([{ field: '', op: 'equals', value: '' }]);
    fireEvent.change(screen.getByLabelText('Condition 1 field'), { target: { value: 'user.name' } });
    const next = onChange.mock.calls[0][0] as PredicateRow[];
    expect(next).toHaveLength(1);
    expect(next[0].field).toBe('user.name');
  });

  it('hides the value input for the `exists` op', () => {
    // Start with an `exists` predicate — the value input must not render.
    setup([{ field: 'rule.tags', op: 'exists' }]);
    expect(screen.getByLabelText('Condition 1 field')).toBeInTheDocument();
    expect(screen.queryByLabelText('Condition 1 value')).toBeNull();
    expect(screen.getByText(/no value needed/i)).toBeInTheDocument();
  });
});
