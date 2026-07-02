/**
 * Round-6 admin-misc batch — a failed initial load on the Users and Roles admin
 * surfaces must render a retryable LoadError, NOT a misleading "No users yet." /
 * "No roles yet." empty state (which, since the roster always has built-ins, could
 * only ever mean the fetch failed).
 *
 * Auth is off, so the users:manage / roles:manage ProtectedRoute is transparent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { usersListMock, rolesGetMock, apiGetMock } = vi.hoisted(() => ({
  usersListMock: vi.fn(),
  rolesGetMock: vi.fn(),
  apiGetMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  class ApiError extends Error {
    status?: number;
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      auth: { me: ok({ authenticated: false, auth_enabled: false, user: null }) },
      users: { list: usersListMock },
      roles: { get: rolesGetMock },
      get: apiGetMock,
    },
  };
});

import { AuthProvider } from '../auth';
import { RouterProvider } from '../router';
import { TooltipProvider } from '@/ui/tooltip';
import Users from '../pages/Users';
import Roles from '../pages/Roles';

function renderPage(node: React.ReactNode) {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <RouterProvider>{node}</RouterProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
}

describe('Users admin — failed load shows LoadError, not "No users yet."', () => {
  beforeEach(() => {
    usersListMock.mockReset();
    rolesGetMock.mockReset();
    rolesGetMock.mockResolvedValue({ roles: [], default_role: '', rbac_enabled: false, matrix: {} });
  });

  it('renders a retryable error when GET /users fails', async () => {
    usersListMock.mockRejectedValue(new Error('boom'));
    renderPage(<Users />);
    await waitFor(() => expect(usersListMock).toHaveBeenCalled());
    expect(await screen.findByText("Couldn't load users")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('No users yet.')).not.toBeInTheDocument();
  });
});

describe('Roles admin — failed load shows LoadError, not "No roles yet."', () => {
  beforeEach(() => {
    apiGetMock.mockReset();
  });

  it('renders a retryable error when GET /roles fails', async () => {
    apiGetMock.mockImplementation((path: string) =>
      path === 'roles'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ authenticated: false, role: '', custom_roles: [], rbac_enabled: false, permissions: {} }),
    );
    renderPage(<Roles />);
    await waitFor(() => expect(apiGetMock).toHaveBeenCalled());
    expect(await screen.findByText("Couldn't load roles")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByText('No roles yet.')).not.toBeInTheDocument();
  });
});
