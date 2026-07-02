/**
 * Round-6 #29 / #30 — saved-view management feedback + the "Shared" badge.
 *
 *  #29: a failed clone/delete now surfaces an error toast (previously the button click
 *       resolved falsy and produced NO feedback at all).
 *  #30: the "Shared" pill is the shared <Badge> primitive, not a one-off `text-[11px]` span.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const { toastMock } = vi.hoisted(() => ({
  toastMock: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }));

const mocks = {
  effective: vi.fn(),
  getOrg: vi.fn(),
  viewsRemove: vi.fn(),
  viewsClone: vi.fn(),
  authMe: vi.fn().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null }),
};

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
    setReauthHandler: vi.fn(),
    api: {
      prefs: {
        effective: () => mocks.effective(),
        getUser: vi.fn(),
        putUser: vi.fn().mockResolvedValue({}),
        getOrg: () => mocks.getOrg(),
        putOrg: vi.fn().mockResolvedValue({}),
        tables: { put: vi.fn() },
      },
      views: {
        list: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        remove: (id: string) => mocks.viewsRemove(id),
        clone: (id: string) => mocks.viewsClone(id),
      },
      terminology: { get: vi.fn(), put: vi.fn().mockResolvedValue({}) },
      getBranding: vi.fn().mockResolvedValue({}),
      auth: { me: () => mocks.authMe() },
      roles: { get: vi.fn().mockResolvedValue({ matrix: {}, rbac_enabled: false }) },
    },
  };
});

import { ThemeProvider } from '../../theme';
import { AuthProvider } from '../../auth';
import { PrefsProvider } from '../../prefs';
import { CustomizationSection } from '../CustomizationSection';
import type { EffectivePrefs } from '@/lib/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withView = (shared: boolean): EffectivePrefs =>
  ({
    terminology: {},
    theme_mode: 'system',
    saved_views: [{ id: 'v1', name: 'Mine', scope: 'cases', shared }],
    pinned_view_ids: [],
    tables: {},
    last_list_state: {},
    misc: {},
    org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrg.mockResolvedValue({ terminology: {}, default_theme: 'system' });
});

function renderSection() {
  return render(
    <ThemeProvider>
      <AuthProvider>
        <PrefsProvider>
          <CustomizationSection />
        </PrefsProvider>
      </AuthProvider>
    </ThemeProvider>,
  );
}

describe('CustomizationSection saved views (Round-6 #29/#30)', () => {
  it('toasts an error when a delete fails', async () => {
    mocks.effective.mockResolvedValue(withView(false));
    mocks.viewsRemove.mockRejectedValue(new Error('boom'));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /delete mine/i }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });

  it('toasts an error when a clone fails', async () => {
    mocks.effective.mockResolvedValue(withView(true));
    mocks.viewsClone.mockRejectedValue(new Error('boom'));
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: /clone mine/i }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled());
  });

  it('renders the shared badge without the off-scale text-[11px]', async () => {
    mocks.effective.mockResolvedValue(withView(true));
    renderSection();
    const shared = await screen.findByText('Shared');
    expect(shared.className).not.toContain('text-[11px]');
  });
});
