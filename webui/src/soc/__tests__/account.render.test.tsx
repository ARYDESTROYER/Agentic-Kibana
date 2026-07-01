/**
 * Account page — render + round-trip test.
 *
 * Mocks GET /api/account/me (the loaded profile) and PUT /api/account/me (the save
 * round-trip), mounts <Account/> inside the auth + tooltip providers (auth ON so the
 * form is editable), and asserts:
 *   1. the profile hydrates (display name + role badge render),
 *   2. editing a field enables Save and PUT is called with the patched body,
 *   3. an env-managed profile renders read-only (no Save button).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const accountGet = vi.fn();
const accountPut = vi.fn();

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
    api: {
      // auth context (auth ON, rbac off → editable, allow-all)
      auth: {
        me: ok({
          auth_enabled: true,
          authenticated: true,
          user: { username: 'alice', role: 'analyst_tier2' },
        }),
        logout: ok({ ok: true }),
      },
      roles: { get: ok({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} }) },
      account: {
        get: () => accountGet(),
        put: (patch: unknown) => accountPut(patch),
        avatar: vi.fn().mockResolvedValue({}),
      },
    },
  };
});

// sonner toasts are side effects we don't assert on — stub them.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { AuthProvider } from '../auth';
import { TooltipProvider } from '@/ui/tooltip';
import Account from '../pages/Account';

function renderAccount() {
  return render(
    <AuthProvider>
      <TooltipProvider>
        <Account onNavigate={vi.fn()} />
      </TooltipProvider>
    </AuthProvider>,
  );
}

describe('Account page', () => {
  beforeEach(() => {
    accountGet.mockReset();
    accountPut.mockReset();
  });

  it('hydrates the profile and renders the identity header', async () => {
    accountGet.mockResolvedValue({
      username: 'alice',
      role: 'analyst_tier2',
      display_name: 'Alice Analyst',
      alias: 'nightshift',
      alt_email: 'alice@home.test',
      timezone: 'Europe/London',
      locale: 'en-GB',
      avatar: '',
      mfa_enabled: true,
      env_managed: false,
    });
    renderAccount();

    // The page mounts in a loading skeleton, then api.account.get() resolves and the
    // profile card commits. Under a fully parallel suite that async transition can slip
    // past waitFor's default 1000ms — poll with explicit headroom (same assertion).
    expect(await screen.findByText('Alice Analyst', {}, { timeout: 5000 })).toBeInTheDocument();
    // @username + role badge derived from humanizeToken (present in the same commit).
    expect(screen.getByText('@alice')).toBeInTheDocument();
    expect(screen.getByText('Analyst tier2')).toBeInTheDocument();
    // The editable display-name input mirrors the loaded value.
    const display = (await screen.findByLabelText('Display name', undefined, {
      timeout: 5000,
    })) as HTMLInputElement;
    expect(display.value).toBe('Alice Analyst');
  });

  it('saves an edited field via PUT /api/account/me', async () => {
    accountGet.mockResolvedValue({
      username: 'alice',
      role: 'analyst_tier2',
      display_name: 'Alice',
      alias: '',
      alt_email: '',
      timezone: '',
      locale: '',
      avatar: '',
      env_managed: false,
    });
    accountPut.mockImplementation((patch: { display_name?: string }) =>
      Promise.resolve({
        username: 'alice',
        role: 'analyst_tier2',
        display_name: patch.display_name ?? 'Alice',
        env_managed: false,
      }),
    );
    renderAccount();

    // Wait out the loading→ready transition before editing (headroom for a contended
    // suite; the assertion — that the field exists and is editable — is unchanged).
    const display = (await screen.findByLabelText('Display name', undefined, {
      timeout: 5000,
    })) as HTMLInputElement;
    fireEvent.change(display, { target: { value: 'Alice A.' } });

    const save = screen.getByRole('button', { name: /Save changes/i });
    await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 5000 });
    fireEvent.click(save);

    await waitFor(() => expect(accountPut).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(accountPut.mock.calls[0][0]).toMatchObject({ display_name: 'Alice A.' });
  });

  it('renders an env-managed profile read-only (no Save button)', async () => {
    accountGet.mockResolvedValue({
      username: 'admin',
      role: 'super_admin',
      env_managed: true,
      display_name: '',
    });
    renderAccount();

    await waitFor(
      () =>
        expect(screen.getByText(/environment-provisioned administrator/i)).toBeInTheDocument(),
      { timeout: 5000 },
    );
    expect(screen.queryByRole('button', { name: /Save changes/i })).toBeNull();
  });
});
