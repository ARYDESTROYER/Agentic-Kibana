/**
 * Round-6 #34 — clearing BOTH quiet-hours time fields no longer tears down the editor
 * or flips the "Enable quiet hours" switch off.
 *
 * The on/off state is now the EXPLICIT presence of the `quiet_hours` object (set by the
 * toggle), not "is a time string non-empty" — so clearing a field to retype it keeps the
 * editor open and the switch on.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/soc/pages/Inbox.api', async (importActual) => {
  const actual = await importActual<typeof import('@/soc/pages/Inbox.api')>();
  return {
    ...actual,
    inboxApi: {
      ...actual.inboxApi,
      getPrefs: vi.fn().mockResolvedValue({
        categories: {},
        quiet_hours: { start: '22:00', end: '07:00' },
        digest: 'off',
      }),
      putPrefs: vi.fn().mockResolvedValue({ categories: {}, quiet_hours: null, digest: 'off' }),
    },
  };
});

import { NotificationPrefs } from '../NotificationPrefs';

describe('NotificationPrefs quiet hours (Round-6 #34)', () => {
  it('keeps the editor open and the switch on when both times are cleared', async () => {
    render(<NotificationPrefs />);

    // Quiet hours starts enabled (a window is loaded) → the editor is visible.
    const start = (await screen.findByLabelText('Start')) as HTMLInputElement;
    const end = screen.getByLabelText('End') as HTMLInputElement;
    const toggle = screen.getByLabelText('Enable quiet hours');
    expect(toggle).toBeChecked();

    // Clear BOTH times (e.g. about to retype the window).
    fireEvent.change(start, { target: { value: '' } });
    fireEvent.change(end, { target: { value: '' } });

    // Editor stays mounted and the toggle stays ON (previously it collapsed + flipped off).
    await waitFor(() => {
      expect(screen.getByLabelText('Start')).toBeInTheDocument();
      expect(screen.getByLabelText('End')).toBeInTheDocument();
      expect(screen.getByLabelText('Enable quiet hours')).toBeChecked();
    });
  });
});
