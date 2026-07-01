/**
 * ControlBar — spec (Dash-B). Pins the layout contract:
 *   - title/meta render on the left, controls on the right;
 *   - the controls region is a labelled toolbar when `label` is given.
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

  it('exposes a labelled toolbar for the controls', () => {
    render(
      <ControlBar
        title="Metrics"
        label="Dashboard controls"
        controls={<button type="button">X</button>}
      />,
    );
    expect(screen.getByRole('toolbar', { name: 'Dashboard controls' })).toBeInTheDocument();
  });

  it('omits the toolbar role when no label is given', () => {
    render(<ControlBar controls={<button type="button">Y</button>} />);
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Y' })).toBeInTheDocument();
  });
});
