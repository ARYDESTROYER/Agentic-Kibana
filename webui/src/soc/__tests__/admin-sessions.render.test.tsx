/**
 * Admin Sessions console — render + terminate-confirm test.
 *
 * Mocks GET /api/admin/sessions (sessions across two users), mounts
 * <AdminSessions/> under the auth provider (auth ON + super_admin so the
 * ProtectedRoute grants access), and asserts:
 *   1. the table renders the per-user sessions with the username column,
 *   2. a row "Terminate" opens the confirm dialog (with the notify checkbox).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const adminList = vi.fn();
const adminRevoke = vi.fn();

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
          user: { username: 'root', role: 'super_admin' },
        }),
        logout: ok({ ok: true }),
      },
      roles: { get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }) },
      admin: {
        sessions: {
          list: (u?: string) => adminList(u),
          revoke: (sid: string, notify: boolean) => adminRevoke(sid, notify),
        },
        users: { revokeAll: vi.fn().mockResolvedValue({ ok: true, revoked: 0 }) },
      },
    },
  };
});

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import AdminSessions from '../pages/AdminSessions';

function renderAdmin() {
  return render(
    <AuthProvider>
      <TooltipProvider>
        <AdminSessions onNavigate={vi.fn()} />
      </TooltipProvider>
    </AuthProvider>,
  );
}

describe('Admin Sessions console', () => {
  beforeEach(() => {
    adminList.mockReset();
    adminRevoke.mockReset();
    adminList.mockResolvedValue({
      sessions: [
        {
          sid: 'sid-a',
          username: 'alice',
          ua_browser: 'Chrome',
          ua_os: 'macOS',
          ip: '203.0.113.5',
          ip_city: 'London',
          ip_country: 'UK',
          created_at: new Date(Date.now() - 3600_000).toISOString(),
          last_active_at: new Date(Date.now() - 60_000).toISOString(),
        },
        {
          sid: 'sid-b',
          username: 'bob',
          ua_browser: 'Safari',
          ua_os: 'iOS',
          ip: '198.51.100.9',
          ip_city: 'Paris',
          ip_country: 'FR',
          created_at: new Date(Date.now() - 86400_000).toISOString(),
          last_active_at: new Date(Date.now() - 7200_000).toISOString(),
        },
      ],
    });
  });

  it('renders all users’ sessions with the user column', async () => {
    renderAdmin();
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.getByText('bob')).toBeInTheDocument();
    expect(screen.getByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('Safari on iOS')).toBeInTheDocument();
  });

  it('opens the force-terminate confirm dialog from a row', async () => {
    renderAdmin();
    await screen.findByText('alice');

    const terminateBtn = screen.getByRole('button', { name: /Terminate session sid-a/i });
    fireEvent.click(terminateBtn);

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Terminate this session?')).toBeInTheDocument();
    // The "notify the user" checkbox is present in the confirm.
    expect(within(dialog).getByLabelText('Notify the user')).toBeInTheDocument();
  });
});
