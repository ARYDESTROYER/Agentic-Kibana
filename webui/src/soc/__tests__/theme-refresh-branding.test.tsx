/**
 * Ask #6 — theme context: `refreshBranding()` re-fetches GET /api/branding and updates
 * the shared branding for every consumer, without a full page reload.
 *
 * This is the primitive that fixes "saved branding doesn't reach the login screen":
 * `ThemeProvider` is mounted once at the app root and otherwise never refetched, so a
 * writer (BrandingEditor Save) or a reader that must never be stale (Login on mount)
 * needs an explicit re-sync handle. A minimal Probe proves the handle exists on the
 * context and re-applies a CHANGED api.getBranding() response.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { brandingMock } = vi.hoisted(() => ({ brandingMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  api: { getBranding: () => brandingMock() },
}));

import { ThemeProvider, useTheme } from '../theme';

function Probe() {
  const { branding, refreshBranding } = useTheme();
  return (
    <>
      <span data-testid="org">{branding.org_name}</span>
      <button type="button" onClick={() => void refreshBranding()}>
        refresh
      </button>
    </>
  );
}

describe('theme — refreshBranding re-syncs the shared branding context', () => {
  beforeEach(() => {
    brandingMock.mockReset();
  });

  it('exposes refreshBranding() that re-fetches and updates the shared branding', async () => {
    brandingMock.mockResolvedValueOnce({ org_name: 'Old Co' });
    render(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('org').textContent).toBe('Old Co'));

    // A subsequent backend change is picked up on the next refreshBranding() — the
    // context (and thus every consumer) resyncs without a page reload.
    brandingMock.mockResolvedValueOnce({ org_name: 'New Co' });
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(screen.getByTestId('org').textContent).toBe('New Co'));
  });
});
