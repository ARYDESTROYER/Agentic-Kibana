/**
 * ControlBar — spec (Dash-B). Pins the layout contract:
 *   - title/meta render on the left, controls on the right;
 *   - the controls region is a labelled GROUP when `label` is given (not a toolbar —
 *     the children are independently tabbable with no roving-tabindex navigation).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ControlBar } from '../ControlBar';

describe('ControlBar', () => {
  it('renders title, meta, and controls', () => {
    render(
      <ControlBar
        title="Overview"
        meta="live"
        label="Dashboard controls"
        controls={<button type="button">Refresh</button>}
      />,
    );
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('live')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('keeps wide interactive title content horizontally reachable', () => {
    render(
      <ControlBar
        title={<div data-testid="wide-title">Operational Performance Posture Cost</div>}
      />,
    );

    const title = screen.getByTestId('wide-title').parentElement;
    expect(title).toHaveClass('max-w-full', 'overflow-x-auto');
    expect(title).not.toHaveClass('truncate');
  });

  it('exposes a labelled group for the controls (not a toolbar)', () => {
    render(
      <ControlBar
        title="Metrics"
        label="Dashboard controls"
        controls={<button type="button">X</button>}
      />,
    );
    expect(screen.getByRole('group', { name: 'Dashboard controls' })).toBeInTheDocument();
    // Must NOT advertise toolbar semantics (no roving-tabindex/arrow navigation).
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('omits the group role when no label is given', () => {
    render(<ControlBar controls={<button type="button">Y</button>} />);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Y' })).toBeInTheDocument();
  });
});
