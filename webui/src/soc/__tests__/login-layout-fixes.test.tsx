/**
 * Round-6 auth-login fixes for the Login layout shells.
 *
 *  - finding 5  (glitch): in the 'full' layout the form floats over an ALWAYS-DARK
 *    hero, so the peripheral caption/support copy must use on-dark tokens, not the
 *    card/canvas theme tokens (dark-on-dark → fails WCAG-AA in light theme).
 *  - finding 17 (ux): the first paint is held until the setup-status probe settles,
 *    so a first-run install doesn't flash the 'signin' form before 'setup'.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const { brandingMock, setupStatusMock, ssoMock, loginMock } = vi.hoisted(() => ({
  brandingMock: vi.fn(),
  setupStatusMock: vi.fn(),
  ssoMock: vi.fn(),
  loginMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  class ApiError extends Error {
    status: number;
    constructor(status = 0, message = '') {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    api: {
      getBranding: () => brandingMock(),
      get: ok({}),
      post: ok({}),
      put: ok({}),
      del: ok({}),
      setup: { status: () => setupStatusMock() },
      auth: {
        login: (u: string, p: string) => loginMock(u, p),
        changePassword: ok({ ok: true }),
        mfa: { setup: ok({}), confirm: ok({}), verify: ok({}), disable: ok({}) },
        sso: { providers: () => ssoMock(), authorize: ok({ auth_url: 'https://idp/' }) },
      },
    },
  };
});

const BASE_BRANDING = {
  org_name: 'Acme SOC',
  product_name: 'Triage',
  logo_data_url: '',
  favicon_data_url: '',
  accent_color: '',
  accent_color2: '',
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

beforeEach(() => {
  brandingMock.mockReset();
  setupStatusMock.mockReset();
  ssoMock.mockReset();
  loginMock.mockReset();
  ssoMock.mockResolvedValue({ providers: [] });
});

describe('Login — full layout on-dark peripheral text (finding 5)', () => {
  it('renders the caption + support link with on-dark tokens over the dark hero', async () => {
    brandingMock.mockResolvedValue({ ...BASE_BRANDING, login_layout: 'full' });
    setupStatusMock.mockResolvedValue({ setup_complete: true, seeded_default: false });
    renderLogin();

    const caption = await screen.findByText('Audited, cost-metered agentic triage.');
    expect(caption).toHaveClass('text-white/60');
    expect(caption).not.toHaveClass('text-muted-foreground');

    const support = screen.getByRole('link', { name: /docs & help/i });
    expect(support).toHaveClass('text-white/70');
    expect(support).not.toHaveClass('text-muted-foreground');
  });
});

describe('Login — setup-status gate avoids the signin→setup flash (finding 17)', () => {
  it('shows a loading gate until setup status settles, then the form', async () => {
    brandingMock.mockResolvedValue({ ...BASE_BRANDING, login_layout: 'split' });
    let resolveStatus: (v: unknown) => void = () => {};
    setupStatusMock.mockReturnValue(
      new Promise((r) => {
        resolveStatus = r;
      }),
    );
    renderLogin();

    // Before status settles the sign-in form is NOT painted (no flash).
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();

    await act(async () => {
      resolveStatus({ setup_complete: true, seeded_default: false });
    });
    // Once settled, the resolved form paints.
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });
});
