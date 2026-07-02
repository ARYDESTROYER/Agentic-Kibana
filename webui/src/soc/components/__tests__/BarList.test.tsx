/**
 * BarList — the sub/percent footer row is conditional (round-6 ui-theme).
 *
 * A bar with neither a `sub` nor `showPercent` must NOT render the trailing footer
 * row, so those bars don't each accrue a stray 4px (`mt-1`) trailer that makes the
 * inter-row rhythm inconsistent versus bars that DO show a sub/percent.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { BarList } from '../BarList';

describe('BarList footer row', () => {
  it('renders no trailing footer row when a bar has neither a sub nor showPercent', () => {
    // The footer is the only element with the exact `mt-1` class (the bar track is `mt-1.5`).
    const { container } = render(<BarList items={[{ label: 'Alpha', value: 10 }]} />);
    expect(container.querySelector('.mt-1')).toBeNull();
  });

  it('renders the footer row (with the %) when showPercent is set', () => {
    const { container, getByText } = render(
      <BarList items={[{ label: 'Alpha', value: 10 }]} showPercent />,
    );
    expect(container.querySelector('.mt-1')).not.toBeNull();
    expect(getByText('100%')).toBeInTheDocument();
  });

  it('renders the footer row when an item supplies a sub caption', () => {
    const { container, getByText } = render(
      <BarList items={[{ label: 'Alpha', value: 10, sub: 'last 24h' }]} />,
    );
    expect(container.querySelector('.mt-1')).not.toBeNull();
    expect(getByText('last 24h')).toBeInTheDocument();
  });
});
