/**
 * Round-6 regression — CustomizationSection "Save default" (org theme) must NOT wipe the
 * other org customization fields.
 *
 * `PUT /api/prefs/org` REPLACES the whole customization object (no server-side merge), so
 * sending a partial `{ default_theme }` used to silently blank the org terminology, shared
 * saved views, pinned view ids, and per-role default dashboards. The fix spreads the FULL
 * loaded org into the patch, overriding only the theme (+ the latest terminology draft).
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const FULL_ORG = {
  terminology: { case: 'incident' },
  default_theme: 'system',
  default_saved_views: [{ id: 'v-org', name: 'Org triage', scope: 'cases', shared: true }],
  default_pinned_view_ids: ['v-org'],
  default_dashboards: { analyst_tier1: { widgets: [{ id: 'w1', kind: 'kpi', x: 0, y: 0, w: 2, h: 1 }] } },
};

const mocks = {
  effective: vi.fn(),
  getOrg: vi.fn(),
  putOrg: vi.fn().mockResolvedValue(FULL_ORG),
  putUser: vi.fn().mockResolvedValue({}),
  terminologyPut: vi.fn().mockResolvedValue({}),
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
        putUser: (p: unknown) => mocks.putUser(p),
        getOrg: () => mocks.getOrg(),
        putOrg: (o: unknown) => mocks.putOrg(o),
        tables: { put: vi.fn() },
      },
      views: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), clone: vi.fn() },
      terminology: { get: vi.fn(), put: (t: unknown) => mocks.terminologyPut(t) },
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

const EMPTY_EFFECTIVE: EffectivePrefs = {
  terminology: {},
  theme_mode: 'system',
  saved_views: [],
  pinned_view_ids: [],
  tables: {},
  last_list_state: {},
  misc: {},
  org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effective.mockResolvedValue({ ...EMPTY_EFFECTIVE });
  mocks.getOrg.mockResolvedValue({ ...FULL_ORG });
  mocks.putOrg.mockResolvedValue({ ...FULL_ORG });
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

describe('CustomizationSection — org defaults save (Round-6 clobber fix)', () => {
  it('round-trips the full org object (saved views + dashboards) when saving the default theme', async () => {
    renderSection();
    await waitFor(() => expect(mocks.getOrg).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole('button', { name: /save default/i }));

    await waitFor(() => expect(mocks.putOrg).toHaveBeenCalledTimes(1));
    const sent = mocks.putOrg.mock.calls[0][0] as Record<string, unknown>;
    // The fields with no editor on this surface must survive the REPLACE PUT.
    expect(sent.default_saved_views).toEqual(FULL_ORG.default_saved_views);
    expect(sent.default_pinned_view_ids).toEqual(FULL_ORG.default_pinned_view_ids);
    expect(sent.default_dashboards).toEqual(FULL_ORG.default_dashboards);
    // Terminology is preserved (carried from the loaded org).
    expect(sent.terminology).toEqual(FULL_ORG.terminology);
    // The theme is the one field this button owns.
    expect(sent.default_theme).toBe('system');
  });
});
