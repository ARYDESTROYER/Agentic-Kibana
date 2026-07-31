/**
 * SecurityMfaInner has two presentation contexts: the established framed Security route
 * and the flat Settings workspace. Keep the enrollment behavior identical while guarding
 * the frame and heading hierarchy in both contexts.
 */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const refresh = vi.fn().mockResolvedValue(undefined);

vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    authEnabled: true,
    isAuthenticated: true,
    username: 'alice',
    refresh,
  }),
}));

vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    auth: {
      me: vi.fn().mockResolvedValue({ user: { username: 'alice', mfa_enabled: false } }),
      mfa: {
        setup: vi.fn(),
        confirm: vi.fn(),
        disable: vi.fn(),
      },
    },
  },
}));

vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { api } from '@/lib/api';
import { SecurityMfaInner } from '../pages/Security';

beforeEach(() => {
  vi.mocked(api.auth.me).mockReset();
  vi.mocked(api.auth.me).mockResolvedValue({ user: { username: 'alice', mfa_enabled: false } } as never);
});

describe('SecurityMfaInner presentation', () => {
  it('retains the established framed MFA card outside Settings', async () => {
    render(
      <main>
        <h1>Security</h1>
        <SecurityMfaInner />
      </main>,
    );

    await screen.findByRole('button', { name: /enable two-factor/i });
    expect(screen.getByTestId('two-factor-surface')).toHaveAttribute(
      'data-surface',
      'standalone',
    );
    expect(screen.getByRole('heading', { name: 'Two-factor authentication', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Two-factor authentication', level: 3 })).toBeInTheDocument();
  });

  it('renders one flat divider band with a single section heading inside Settings', async () => {
    render(
      <main>
        <h1>Settings</h1>
        <SecurityMfaInner embedded />
      </main>,
    );

    await screen.findByRole('button', { name: /enable two-factor/i });
    const surface = screen.getByTestId('two-factor-surface');
    expect(surface).toHaveAttribute('data-surface', 'embedded');
    expect(surface).toHaveClass('border-t');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('heading', { name: 'Two-factor authentication' })).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Two-factor authentication', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Two-factor authentication', level: 3 })).not.toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
  });

  it('shows a retryable failure instead of presenting an unverified disabled state', async () => {
    vi.mocked(api.auth.me).mockRejectedValueOnce(new Error('profile unavailable'));

    render(<SecurityMfaInner embedded />);

    expect(
      await screen.findByText('Could not load two-factor settings'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Disabled')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enable two-factor/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: /enable two-factor/i })).toBeInTheDocument();
  });
});
