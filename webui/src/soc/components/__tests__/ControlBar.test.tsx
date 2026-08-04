/**
 * ControlBar — spec (Dash-B). Pins the layout contract:
 *   - title/meta render on the left, controls on the right;
 *   - the controls region is a labelled GROUP when `label` is given (not a toolbar —
 *     the children are independently tabbable with no roving-tabindex navigation).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Trash2 } from 'lucide-react';

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

  it('keeps primary controls before wrapping secondary controls', () => {
    render(
      <ControlBar
        label="Queue controls"
        controls={<button type="button">Refresh</button>}
        secondaryControls={<button type="button">Sort</button>}
      />,
    );

    const group = screen.getByRole('group', { name: 'Queue controls' });
    const primary = group.querySelector('[data-controlbar-slot="primary"]');
    const secondary = group.querySelector('[data-controlbar-slot="secondary"]');

    expect(primary).toBeInTheDocument();
    expect(secondary).toBeInTheDocument();
    expect(within(primary as HTMLElement).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
    expect(within(secondary as HTMLElement).getByRole('button', { name: 'Sort' })).toBeInTheDocument();
    expect(
      (primary as HTMLElement).compareDocumentPosition(secondary as HTMLElement) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('moves explicit simple commands behind a labelled narrow-width menu', () => {
    render(
      <ControlBar
        label="Dashboard controls"
        overflowLabel="More dashboard actions"
        overflowActions={[
          {
            id: 'delete',
            label: 'Delete dashboard',
            icon: Trash2,
            destructive: true,
            onSelect: () => {},
          },
        ]}
      />,
    );

    const group = screen.getByRole('group', { name: 'Dashboard controls' });
    const inline = group.querySelector('[data-controlbar-slot="overflow-inline"]');
    const trigger = within(group).getByRole('button', { name: 'More dashboard actions' });

    expect(group.parentElement).toHaveClass('@container/controlbar');
    expect(inline).toHaveClass('hidden', '@3xl/controlbar:flex');
    expect(within(inline as HTMLElement).getByRole('button', { name: 'Delete dashboard' })).toHaveClass(
      'text-critical-text',
    );
    expect(trigger).toHaveClass('@3xl/controlbar:hidden');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  });

  it('supports keyboard selection and restores focus to the overflow trigger', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ControlBar
        label="Dashboard controls"
        overflowLabel="More dashboard actions"
        overflowActions={[{ id: 'reset', label: 'Reset layout', onSelect }]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'More dashboard actions' });
    trigger.focus();
    await user.keyboard('{Enter}');

    const item = await screen.findByRole('menuitem', { name: 'Reset layout' });
    await waitFor(() => expect(item).toHaveFocus());
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
