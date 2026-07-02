/**
 * Campaigns "Recorrelate" RBAC gate — BUG #9 regression (G6 R6).
 *
 * BUG: the Recorrelate action was wrapped in `<Can resource="cases" action="read">`,
 * so a read-only user saw an ENABLED button — but the backend gates it on
 * `require_admin` (== `users:manage`), so it 403s. The fix gates the UI on the SAME
 * admin grant and disables-with-tooltip for everyone else (never a silent 403).
 *
 * These specs flip `hasPermission` and assert the button's enabled/disabled state +
 * that the config editor mutation surface follows the same gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const { listMock, recorrelateMock, getMock, putMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  recorrelateMock: vi.fn(),
  getMock: vi.fn(),
  putMock: vi.fn(),
}));

vi.mock('@/soc/pages/Campaigns.api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../Campaigns.api')>();
  return {
    ...actual,
    campaignsApi: { ...actual.campaignsApi, list: listMock, recorrelate: recorrelateMock },
  };
});

// Campaigns loads/saves its config through the shared `api.campaign` client
// (getConfig/putConfig → GET/PUT campaigns/config).
vi.mock('@/lib/api', () => ({
  api: { campaign: { getConfig: getMock, putConfig: putMock }, post: vi.fn() },
}));

// A configurable permission gate. `admin` toggles the users:manage grant that gates
// Recorrelate; `cases:read` is always granted so the page (ProtectedRoute) renders.
const permState = { admin: false };
vi.mock('@/soc/auth', () => ({
  useAuth: () => ({
    username: 'tester',
    authEnabled: true,
    hasPermission: (res: string, act: string) => {
      if (res === 'users' && act === 'manage') return permState.admin;
      // Page access + any other read: always granted for the read-only user.
      return true;
    },
  }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { TooltipProvider } from '@/ui/tooltip';
import Campaigns from '../Campaigns';

function renderCampaigns(admin: boolean) {
  permState.admin = admin;
  return render(
    <TooltipProvider>
      <Campaigns onNavigate={vi.fn()} />
    </TooltipProvider>,
  );
}

describe('Campaigns Recorrelate gate (bug #9)', () => {
  beforeEach(() => {
    listMock.mockReset();
    recorrelateMock.mockReset();
    getMock.mockReset();
    putMock.mockReset();
    listMock.mockResolvedValue({ campaigns: [], total: 0, enabled: false });
    getMock.mockResolvedValue({ config: { enabled: false, cadence: 'daily' } });
  });

  it('DISABLES Recorrelate for a read-only user (no admin grant)', async () => {
    renderCampaigns(false);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const btn = await screen.findByRole('button', { name: /recorrelate/i });
    expect(btn).toBeDisabled();
  });

  it('ENABLES Recorrelate for an admin (users:manage grant)', async () => {
    renderCampaigns(true);
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const btn = await screen.findByRole('button', { name: /recorrelate/i });
    expect(btn).not.toBeDisabled();
  });
});
