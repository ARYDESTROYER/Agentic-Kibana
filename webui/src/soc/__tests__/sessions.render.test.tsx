/**
 * Sessions page — render + revoke-confirm test.
 *
 * Mocks GET /api/sessions (two sessions incl. the current one) + GET
 * /api/account/activity, mounts <Sessions/> inside the auth + tooltip providers
 * (auth ON so the page is live), and asserts:
 *   1. the session table renders both devices, with "This device" on the current one,
 *   2. clicking a row's Revoke opens the AlertDialog confirm.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const sessionsList = vi.fn();
const activity = vi.fn();
const revoke = vi.fn();
const revokeOthers = vi.fn();

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: {
        me: ok({
          auth_enabled: true,
          authenticated: true,
          user: { username: 'alice', role: 'super_admin' },
        }),
        logout: ok({ ok: true }),
      },
      roles: { get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }) },
      sessions: {
        list: () => sessionsList(),
        revoke: (sid: string) => revoke(sid),
        revokeOthers: () => revokeOthers(),
      },
      account_activity: () => activity(),
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import Sessions from '../pages/Sessions';

function renderSessions() {
  return render(
    <AuthProvider>
      <TooltipProvider>
        <Sessions onNavigate={vi.fn()} />
      </TooltipProvider>
    </AuthProvider>,
  );
}

describe('Sessions page', () => {
  beforeEach(() => {
    sessionsList.mockReset();
    activity.mockReset();
    revoke.mockReset();
    revokeOthers.mockReset();
    activity.mockResolvedValue({ events: [] });
    sessionsList.mockResolvedValue({
      sessions: [
        {
          sid: 'sid-current',
          current: true,
          ua_browser: 'Chrome',
          ua_os: 'macOS',
          ip: '203.0.113.5',
          ip_city: 'London',
          ip_country: 'UK',
          created_at: new Date(Date.now() - 3600_000).toISOString(),
          last_active_at: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          sid: 'sid-other',
          current: false,
          ua_browser: 'Firefox',
          ua_os: 'Windows',
          ip: '198.51.100.9',
          ip_city: 'Berlin',
          ip_country: 'DE',
          created_at: new Date(Date.now() - 86400_000).toISOString(),
          last_active_at: new Date(Date.now() - 7200_000).toISOString(),
        },
      ],
    });
  });

  it('renders both sessions and badges the current device', async () => {
    renderSessions();

    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('Firefox on Windows')).toBeInTheDocument();
    // The current session is badged "This device".
    expect(screen.getByText('This device')).toBeInTheDocument();
    // Locations render as plain text.
    expect(screen.getByText('London, UK')).toBeInTheDocument();
    expect(screen.getByText('Berlin, DE')).toBeInTheDocument();
  });

  it('opens the revoke confirm dialog when a row Revoke is clicked', async () => {
    renderSessions();

    await screen.findByText('Firefox on Windows');
    // Revoke the non-current session.
    const revokeBtn = screen.getByRole('button', { name: /Revoke session sid-other/i });
    fireEvent.click(revokeBtn);

    // The AlertDialog confirm appears.
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Revoke this session?')).toBeInTheDocument();

    // Confirming calls the revoke API with the right sid.
    const confirm = within(dialog).getByRole('button', { name: /^Revoke$/i });
    fireEvent.click(confirm);
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('sid-other'));
  });
});
