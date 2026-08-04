import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { RefreshButton } from '../RefreshButton';

describe('RefreshButton', () => {
  it('uses one stable visible label and invokes a manual refresh', () => {
    const onClick = vi.fn();
    const { container, rerender } = render(
      <RefreshButton onClick={onClick} refreshing={false} />,
    );

    const button = screen.getByRole('button', { name: 'Refresh' });
    const iconSlot = container.querySelector('[aria-hidden="true"]');
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(button).toBeEnabled();
    expect(iconSlot).toHaveClass('size-4', 'shrink-0');

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(<RefreshButton onClick={onClick} refreshing />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(container.querySelector('svg')).toHaveClass(
      'animate-spin',
      'motion-reduce:animate-none',
    );
    expect(screen.getAllByText('Refresh')).toHaveLength(1);
  });

  it('preserves an explicit disabled state and custom visible label', () => {
    render(<RefreshButton disabled label="Reload evidence" />);

    const button = screen.getByRole('button', { name: 'Reload evidence' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
  });
});
