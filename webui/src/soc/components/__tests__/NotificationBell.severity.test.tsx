/**
 * NotificationBell — severity redundancy + token (Round 6 admin-misc, #29 / #30).
 *
 * #29: the dropdown row conveyed severity by a color-only dot (aria-hidden, WCAG
 *      1.4.1). FIX: for a known severity it renders the shared SEMANTIC_ICON glyph
 *      (shape = colorblind-safe) + an sr-only "<sev> severity" label for AT.
 * #30: the unread badge used a hardcoded `text-white`. FIX: the paired
 *      `text-critical-foreground` token (so it tracks the critical axis in both themes).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchInboxMock } = vi.hoisted(() => ({ fetchInboxMock: vi.fn() }));

vi.mock('../NotificationBell.api', () => ({
  fetchInbox: fetchInboxMock,
  fetchUnreadCount: vi.fn().mockResolvedValue({ unread: 1 }),
  markAllRead: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/useEventStream', () => ({
  useEventStream: () => ({ live: false }),
}));

import { NotificationBell } from '../NotificationBell';

describe('NotificationBell severity a11y (#29) + badge token (#30)', () => {
  beforeEach(() => {
    fetchInboxMock.mockReset();
    fetchInboxMock.mockResolvedValue({
      items: [
        {
          id: 'n1',
          title: 'Case escalated',
          body: 'risk 82',
          severity: 'high',
          state: 'read',
          created_at: '2026-06-30T10:00:00Z',
        },
      ],
    });
  });

  it('announces severity beside the color (not color-only) + uses the critical token badge', async () => {
    render(<NotificationBell onNavigate={vi.fn()} />);

    // The unread badge uses the paired on-color token, not a hardcoded text-white.
    const badge = await screen.findByText('1');
    expect(badge.className).toContain('text-critical-foreground');
    expect(badge.className).not.toContain('text-white');

    // Open the dropdown and load the recent window.
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));
    await waitFor(() => expect(fetchInboxMock).toHaveBeenCalled());

    // Severity is announced to AT via an sr-only label (WCAG 1.4.1 redundancy).
    expect(await screen.findByText('high severity')).toBeInTheDocument();
  });

  it('uses the shared named loader while the inbox window opens', async () => {
    let resolveInbox!: (value: { items: [] }) => void;
    fetchInboxMock.mockImplementationOnce(
      () => new Promise<{ items: [] }>((resolve) => { resolveInbox = resolve; }),
    );

    render(<NotificationBell onNavigate={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /notifications/i }));

    expect(
      await screen.findByRole('status', { name: 'Loading notifications' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('console-loading-glyph')).toBeInTheDocument();

    resolveInbox({ items: [] });
    expect(await screen.findByText('You’re all caught up')).toBeInTheDocument();
  });
});
