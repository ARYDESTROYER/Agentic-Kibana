/**
 * Login render test — covers all FOUR modes of the redesigned login surface.
 *
 * The mode state machine is:
 *   - signin  (default, when setup is complete)
 *   - setup   (when GET /api/setup/status reports needs_user)
 *   - mfa     (when POST /api/auth/login returns requires_mfa + pending_token)
 *   - change  (when the login user is flagged must_change_password)
 *
 * We mount <Login/> inside the Theme + Tooltip providers, mock branding, the setup
 * status, and the SSO providers, and assert each mode renders WITHOUT crashing:
 *   1. signin: the "Sign in" title + the SSO buttons (google/microsoft icons).
 *   2. setup:  the create-admin title + a password-strength meter once typing.
 *   3. mfa:    driving the password form (requires_mfa) reveals the 6-cell OTP.
 *   4. change: driving the password form (must_change_password) reveals the form.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// ---- Mock the typed api client BEFORE importing the component ------------- //
const loginMock = vi.fn();
const setupStatusMock = vi.fn();
const ssoProvidersMock = vi.fn();

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    api: {
      getBranding: vi.fn().mockResolvedValue({
        org_name: 'Acme SOC',
        product_name: 'Triage',
        logo_data_url: '',
        favicon_data_url: '',
        accent_color: '#2563eb',
        accent_color2: '#9333ea',
        theme: '',
        login_subtitle: 'Welcome back',
        footer_text: 'UNCLASSIFIED',
        support_url: 'https://example.com/help',
        dark_mode_default: false,
      }),
      setup: {
        status: () => setupStatusMock(),
        initAdmin: vi.fn().mockResolvedValue({ ok: true, username: 'admin' }),
      },
      auth: {
        login: (u: string, p: string) => loginMock(u, p),
        changePassword: vi.fn().mockResolvedValue({ ok: true }),
        mfa: { verify: vi.fn().mockResolvedValue({ user: {} }) },
        sso: {
          providers: () => ssoProvidersMock(),
          authorize: vi.fn().mockResolvedValue({ auth_url: 'https://idp/' }),
        },
      },
    },
  };
});

import { ThemeProvider } from '../theme';
import { TooltipProvider } from '@/ui/tooltip';
import Login from '../pages/Login';

function renderLogin() {
  return render(
    <ThemeProvider>
      <TooltipProvider>
        <Login onAuthenticated={vi.fn()} />
      </TooltipProvider>
    </ThemeProvider>,
  );
}

describe('Login — four-mode render', () => {
  beforeEach(() => {
    loginMock.mockReset();
    setupStatusMock.mockReset();
    ssoProvidersMock.mockReset();
    // Default: setup complete (→ signin) and two SSO providers enabled.
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
    ssoProvidersMock.mockResolvedValue({
      providers: [
        { id: 'g', type: 'google', display_name: 'Google' },
        { id: 'm', type: 'microsoft', display_name: 'Microsoft' },
      ],
    });
  });

  it('renders the SIGNIN mode with SSO buttons', async () => {
    renderLogin();
    // The username + password fields are the signin-mode signature.
    expect(await screen.findByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    // SSO buttons appear once the providers resolve.
    await waitFor(() =>
      expect(screen.getByText('Sign in with Google')).toBeInTheDocument(),
    );
    expect(screen.getByText('Sign in with Microsoft')).toBeInTheDocument();
  });

  it('renders the SETUP (create-admin) mode and the password-strength meter', async () => {
    setupStatusMock.mockResolvedValue({ needs_user: true, setup_complete: false });
    renderLogin();
    expect(await screen.findByText('Create your admin account')).toBeInTheDocument();

    // Typing a password surfaces the strength meter label without crashing.
    const pw = screen.getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'Str0ng!Passw0rd#2026' } });
    await waitFor(() => expect(screen.getByText('Strong')).toBeInTheDocument());
  });

  it('transitions to MFA mode and renders the segmented OTP input', async () => {
    loginMock.mockResolvedValue({ requires_mfa: true, pending_token: 'pend-123' });
    renderLogin();
    await screen.findByLabelText('Username');

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Two-factor authentication')).toBeInTheDocument();
    // The OTP group renders 6 single-digit cells.
    const group = await screen.findByRole('group', { name: 'Authentication code' });
    expect(group).toBeInTheDocument();
    const cells = screen.getAllByLabelText(/Authentication code digit/);
    expect(cells).toHaveLength(6);
  });

  it('transitions to CHANGE-PASSWORD mode after a must_change login', async () => {
    loginMock.mockResolvedValue({ user: { must_change_password: true } });
    renderLogin();
    await screen.findByLabelText('Username');

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'oldpw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Set a new password')).toBeInTheDocument();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument();
  });

  it('shows the seeded-default credential hint when seeded_default is set', async () => {
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: true });
    renderLogin();
    await screen.findByLabelText('Username');
    await waitFor(() => expect(screen.getByText(/Default sign-in/i)).toBeInTheDocument());
  });
});
