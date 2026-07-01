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
const brandingMock = vi.fn();
// The low-level api.post — the OOBE setup client (login.api.ts) posts /setup/account
// and MfaSetupCard posts /auth/mfa/*; capture the calls per-path here.
const postMock = vi.fn();

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
      getBranding: () => brandingMock(),
      get: vi.fn().mockResolvedValue({}),
      post: (path: string, body?: unknown) => postMock(path, body),
      put: vi.fn().mockResolvedValue({}),
      del: vi.fn().mockResolvedValue({}),
      setup: {
        status: () => setupStatusMock(),
      },
      auth: {
        login: (u: string, p: string) => loginMock(u, p),
        changePassword: vi.fn().mockResolvedValue({ ok: true }),
        mfa: {
          setup: vi.fn().mockResolvedValue({
            secret: 'ABC123',
            otpauth_uri: 'otpauth://totp/x',
            recovery_codes: ['aaaa-bbbb'],
          }),
          confirm: vi.fn().mockResolvedValue({ ok: true }),
          verify: vi.fn().mockResolvedValue({ user: {} }),
          disable: vi.fn().mockResolvedValue({ ok: true }),
        },
        sso: {
          providers: () => ssoProvidersMock(),
          authorize: vi.fn().mockResolvedValue({ auth_url: 'https://idp/' }),
        },
      },
    },
  };
});

const BASE_BRANDING = {
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
};

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
    brandingMock.mockReset();
    postMock.mockReset();
    brandingMock.mockResolvedValue({ ...BASE_BRANDING });
    postMock.mockResolvedValue({ ok: true });
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

// --------------------------------------------------------------------------- //
// Round-4 Wave-5: OOBE account-setup (POST /api/setup/account) — the force-set
// strong-password flow that replaces init-admin, with an optional MFA prompt.
// --------------------------------------------------------------------------- //
describe('Login — OOBE account-setup (setup/account)', () => {
  beforeEach(() => {
    loginMock.mockReset();
    setupStatusMock.mockReset();
    ssoProvidersMock.mockReset();
    brandingMock.mockReset();
    postMock.mockReset();
    brandingMock.mockResolvedValue({ ...BASE_BRANDING });
    ssoProvidersMock.mockResolvedValue({ providers: [] });
    setupStatusMock.mockResolvedValue({ needs_user: true, setup_complete: false });
    loginMock.mockResolvedValue({ user: {} });
  });

  async function fillSetup(pw: string, confirmPw = pw) {
    await screen.findByText('Create your admin account');
    fireEvent.change(screen.getByLabelText('Admin username'), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: pw } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: confirmPw } });
  }

  it('keeps the create button DISABLED for a weak/short password (client policy gate)', async () => {
    renderLogin();
    await fillSetup('short'); // < 12 chars
    const btn = screen.getByRole('button', { name: /Create admin & sign in/i });
    expect(btn).toBeDisabled();
    // The inline policy hint surfaces the reason.
    expect(screen.getByText(/at least 12 characters/i)).toBeInTheDocument();
  });

  it('rejects a common password even when long enough', async () => {
    renderLogin();
    await fillSetup('admin12345678'); // long but on the common blocklist
    expect(screen.getByRole('button', { name: /Create admin & sign in/i })).toBeDisabled();
    expect(screen.getByText(/too common/i)).toBeInTheDocument();
  });

  it('POSTs /setup/account (NOT init-admin), then signs in, on a strong password', async () => {
    postMock.mockResolvedValue({ ok: true, username: 'alice', role: 'super_admin', mfa_prompt: false });
    const onAuth = vi.fn();
    render(
      <ThemeProvider>
        <TooltipProvider>
          <Login onAuthenticated={onAuth} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await fillSetup('C0rrectHorseBattery!');
    fireEvent.click(screen.getByRole('button', { name: /Create admin & sign in/i }));
    await waitFor(() => expect(postMock).toHaveBeenCalled());
    // It hits the NEW writer, not the legacy init-admin path.
    expect(postMock).toHaveBeenCalledWith('setup/account', expect.objectContaining({ username: 'alice' }));
    await waitFor(() => expect(loginMock).toHaveBeenCalledWith('alice', 'C0rrectHorseBattery!'));
    await waitFor(() => expect(onAuth).toHaveBeenCalled());
  });

  it('offers the OPTIONAL MFA-enroll step when the server prompts, and lets you skip', async () => {
    postMock.mockResolvedValue({ ok: true, username: 'alice', role: 'super_admin', mfa_prompt: true });
    const onAuth = vi.fn();
    render(
      <ThemeProvider>
        <TooltipProvider>
          <Login onAuthenticated={onAuth} />
        </TooltipProvider>
      </ThemeProvider>,
    );
    await fillSetup('C0rrectHorseBattery!');
    fireEvent.click(screen.getByRole('button', { name: /Create admin & sign in/i }));

    // The prompted-optional two-factor step appears (NOT yet authenticated).
    expect(await screen.findByText('Secure your account')).toBeInTheDocument();
    expect(onAuth).not.toHaveBeenCalled();
    // Skipping continues into the console.
    fireEvent.click(screen.getByRole('button', { name: /Skip for now/i }));
    await waitFor(() => expect(onAuth).toHaveBeenCalled());
  });
});

// --------------------------------------------------------------------------- //
// Round-4 Wave-5: login white-label — bounded plain-text copy + curated layouts.
// --------------------------------------------------------------------------- //
describe('Login — white-label copy + layouts', () => {
  beforeEach(() => {
    loginMock.mockReset();
    setupStatusMock.mockReset();
    ssoProvidersMock.mockReset();
    brandingMock.mockReset();
    postMock.mockReset();
    ssoProvidersMock.mockResolvedValue({ providers: [] });
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
  });

  it('renders operator-set headline / body / chips as PLAIN text', async () => {
    brandingMock.mockResolvedValue({
      ...BASE_BRANDING,
      login_headline: 'Welcome to Contoso SOC',
      login_body: 'Investigate faster.',
      login_chips: ['Fast', 'Audited'],
      login_layout: 'split',
      login_illustration: 'radar',
    });
    renderLogin();
    await screen.findByLabelText('Username');
    expect(await screen.findByText('Welcome to Contoso SOC')).toBeInTheDocument();
    expect(screen.getByText('Investigate faster.')).toBeInTheDocument();
    expect(screen.getByText('Fast')).toBeInTheDocument();
    expect(screen.getByText('Audited')).toBeInTheDocument();
  });

  it('does NOT inject markup — angle-bracketed copy renders as literal text', async () => {
    brandingMock.mockResolvedValue({
      ...BASE_BRANDING,
      login_headline: '<img src=x onerror=alert(1)>',
    });
    const { container } = renderLogin();
    await screen.findByLabelText('Username');
    // The string renders as a text node; no <img> element is created from the copy.
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });

  it.each(['split', 'centered', 'full'] as const)(
    'renders the %s layout without crashing (form is reachable)',
    async (layout) => {
      brandingMock.mockResolvedValue({ ...BASE_BRANDING, login_layout: layout });
      const { container } = renderLogin();
      // The sign-in form is reachable in every layout (wait for the async branding
      // fetch to settle, then assert against this render's own container).
      await screen.findByRole('button', { name: 'Sign in' });
      expect(container.querySelector('#login-username')).not.toBeNull();
      expect(container.querySelector('#login-password')).not.toBeNull();
    },
  );
});
