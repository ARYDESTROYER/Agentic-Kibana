/**
 * DashboardGroup — spec (Dash-B). Pins the load-bearing behavior:
 *   - the title + count render and the group is a labelled region;
 *   - the trigger toggles `aria-expanded` (uncontrolled);
 *   - controlled mode reflects the `open` prop and calls `onOpenChange`;
 *   - actions in the header do not toggle the group.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { DashboardGroup } from '../DashboardGroup';

describe('DashboardGroup', () => {
  it('renders the title, count, and content when open', () => {
    render(
      <DashboardGroup title="Attention queue" count={7} defaultOpen>
        <div>widget body</div>
      </DashboardGroup>,
    );
    expect(screen.getByRole('region', { name: 'Attention queue' })).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('widget body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Attention queue/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('toggles aria-expanded on click (uncontrolled)', () => {
    render(
      <DashboardGroup title="Recent cases" defaultOpen>
        <div>body</div>
      </DashboardGroup>,
    );
    const trigger = screen.getByRole('button', { name: /Recent cases/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('reflects the controlled open prop and reports changes', () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <DashboardGroup title="Controlled" open={false} onOpenChange={onOpenChange}>
        <div>body</div>
      </DashboardGroup>,
    );
    const trigger = screen.getByRole('button', { name: /Controlled/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    // controlled: does not flip internally, but reports the requested next state
    expect(onOpenChange).toHaveBeenCalledWith(true);
    rerender(
      <DashboardGroup title="Controlled" open={true} onOpenChange={onOpenChange}>
        <div>body</div>
      </DashboardGroup>,
    );
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('wires aria-controls to the collapsible region id', () => {
    render(
      <DashboardGroup title="Wired" defaultOpen>
        <div>body</div>
      </DashboardGroup>,
    );
    const trigger = screen.getByRole('button', { name: /Wired/i });
    const controls = trigger.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(document.getElementById(controls!)).toBeInTheDocument();
  });

  it('renders header actions without toggling the group', () => {
    const onAction = vi.fn();
    render(
      <DashboardGroup
        title="With actions"
        defaultOpen
        actions={
          <button type="button" onClick={onAction}>
            Configure
          </button>
        }
      >
        <div>body</div>
      </DashboardGroup>,
    );
    const trigger = screen.getByRole('button', { name: /With actions/i });
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    // group stays open — the action button is outside the trigger
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});
