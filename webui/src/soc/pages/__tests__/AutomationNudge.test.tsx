/**
 * AutomationNudge — the Overview onboarding banner (F3).
 *   - auth off / privileged → renders and its "Turn on" button enables the #3-safe
 *     engines through enableRecommendedAutomation (tuning GET-then-PUT + campaigns),
 *   - a principal WITHOUT automation:manage → self-hides (no 403 dead-end).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { getMock, putMock, authMeMock, rolesGetMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  putMock: vi.fn(),
  authMeMock: vi.fn(),
  rolesGetMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  setUnauthorizedHandler: vi.fn(),
  setReauthHandler: vi.fn(),
  ApiError: class ApiError extends Error {},
  api: {
    get: getMock,
    put: putMock,
    auth: { me: authMeMock, logout: vi.fn().mockResolvedValue({ ok: true }) },
    roles: { get: rolesGetMock },
  },
}));

import { AuthProvider } from '../../auth';
import { AutomationNudge } from '../AutomationNudge';

function renderNudge(overrides?: Partial<{ onEnabled: () => void }>) {
  const onEnabled = overrides?.onEnabled ?? vi.fn();
  render(
    <AuthProvider>
      <AutomationNudge onEnabled={onEnabled} onReview={vi.fn()} onDismiss={vi.fn()} />
    </AuthProvider>,
  );
  return { onEnabled };
}

describe('AutomationNudge (F3)', () => {
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue({ config: { enabled: false } });
    putMock.mockReset().mockResolvedValue({ ok: true });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    rolesGetMock
      .mockReset()
      .mockResolvedValue({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} });
  });

  it('renders and enables recommended automation on click (auth off)', async () => {
    const user = userEvent.setup();
    const { onEnabled } = renderNudge();

    const btn = await screen.findByRole('button', { name: /Turn on recommended automation/i });
    await user.click(btn);

    // Tuning is GET-then-PUT with shadow_eval kept true.
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('tuning/config'));
    expect(putMock).toHaveBeenCalledWith(
      'tuning/config',
      expect.objectContaining({ enabled: true, shadow_eval: true }),
    );
    // Campaigns via the PLURAL path (auth off → admin grant holds).
    expect(putMock).toHaveBeenCalledWith('campaigns/config', { enabled: true });
    await waitFor(() => expect(onEnabled).toHaveBeenCalled());
  });

  it('self-hides for a principal without automation:manage (no 403 dead-end)', async () => {
    authMeMock.mockResolvedValue({
      auth_enabled: true,
      authenticated: true,
      user: { username: 'ana', role: 'analyst_tier1' },
    });
    rolesGetMock.mockResolvedValue({
      roles: [],
      default_role: 'analyst_tier1',
      rbac_enabled: true,
      matrix: { analyst_tier1: { cases: ['read'] } },
    });

    renderNudge();

    // Once the (auth-on, no-grant) context loads, the nudge removes itself.
    await waitFor(() =>
      expect(screen.queryByTestId('automation-nudge')).toBeNull(),
    );
    expect(putMock).not.toHaveBeenCalled();
  });
});
