/**
 * SelectItem — the highlighted option uses the accent hover/selected token, the
 * same treatment every other menu primitive uses (round-6 ui-theme #49). Was the
 * fainter `bg-muted` (slate-3) which drifted from the documented token authority.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select';

describe('SelectItem — accent hover/selected token', () => {
  it('highlights with bg-accent (not bg-muted)', () => {
    const { getAllByRole } = render(
      <Select defaultOpen>
        <SelectTrigger>
          <SelectValue placeholder="pick" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Alpha</SelectItem>
        </SelectContent>
      </Select>,
    );
    const option = getAllByRole('option')[0];
    const tokens = option.className.split(/\s+/).filter(Boolean);
    expect(tokens).toContain('focus:bg-accent');
    expect(tokens).toContain('focus:text-accent-foreground');
    expect(tokens).not.toContain('focus:bg-muted');
  });
});
