/**
 * Wizard onboarding fixes:
 *   - F5: clicking "Continue" on the Keys step auto-saves typed provider keys (they
 *     are lifted to the wizard, so they no longer vanish when the step unmounts).
 *   - F4/F9: a demo-toggle failure shows an INLINE demo error, never the finish-only
 *     "Could not complete setup" banner.
 *   - F2: the Review step offers a default-on "Recommended automation" card, and Finish
 *     enables the #3-safe engines (tuning + campaigns) before completing setup.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const {
  updateSecretsMock,
  completeSetupMock,
  putSettingsMock,
  demoStatusMock,
  demoEnableMock,
  demoDisableMock,
  authMeMock,
  rolesGetMock,
  getMock,
  putMock,
} = vi.hoisted(() => ({
  updateSecretsMock: vi.fn(),
  completeSetupMock: vi.fn(),
  putSettingsMock: vi.fn(),
  demoStatusMock: vi.fn(),
  demoEnableMock: vi.fn(),
  demoDisableMock: vi.fn(),
  authMeMock: vi.fn(),
  rolesGetMock: vi.fn(),
  getMock: vi.fn(),
  putMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (v: unknown) => vi.fn().mockResolvedValue(v);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    ApiError: class ApiError extends Error {},
    api: {
      get: getMock,
      put: putMock,
      setupStatus: ok({ setup_complete: false, configured: {} }),
      listConnectors: ok({ connectors: [] }),
      listSources: ok({ sources: [] }),
      getSettings: ok({ prefs: {} }),
      putSettings: putSettingsMock,
      updateSecrets: updateSecretsMock,
      completeSetup: completeSetupMock,
      auth: { me: authMeMock, logout: ok({ ok: true }) },
      roles: { get: rolesGetMock },
      demo: {
        status: demoStatusMock,
        enable: demoEnableMock,
        disable: demoDisableMock,
        reset: ok({ mode: 'off', active: false }),
      },
    },
  };
});

import { TooltipProvider } from '@/ui/tooltip';
import { AuthProvider } from '../../auth';
import { DemoProvider } from '../../demo';
import Wizard from '../Wizard';

function renderWizard() {
  return render(
    <TooltipProvider>
      <AuthProvider>
        <DemoProvider>
          <Wizard onComplete={vi.fn()} />
        </DemoProvider>
      </AuthProvider>
    </TooltipProvider>,
  );
}

describe('Wizard onboarding fixes', () => {
  beforeEach(() => {
    updateSecretsMock.mockReset().mockResolvedValue({ ok: true });
    completeSetupMock.mockReset().mockResolvedValue({ ok: true });
    putSettingsMock.mockReset().mockResolvedValue({ ok: true });
    demoStatusMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
    demoEnableMock.mockReset().mockResolvedValue({ mode: 'seeded', active: true });
    demoDisableMock.mockReset().mockResolvedValue({ mode: 'off', active: false });
    getMock.mockReset().mockResolvedValue({ config: { enabled: false } });
    putMock.mockReset().mockResolvedValue({ ok: true });
    authMeMock.mockReset().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null });
    rolesGetMock
      .mockReset()
      .mockResolvedValue({ roles: [], default_role: 'analyst_tier1', rbac_enabled: false, matrix: {} });
  });

  it('F5: Continue on the Keys step auto-saves a typed provider key', async () => {
    const user = userEvent.setup();
    renderWizard();

    // Jump to the Keys step via the stepper.
    await user.click(await screen.findByRole('button', { name: /Provider keys/i }));
    const input = await screen.findByLabelText(/Anthropic API key/i);
    await user.type(input, 'sk-ant-abc123');

    // Click the forward CTA (NOT the Save button) — it must persist the key.
    await user.click(screen.getByRole('button', { name: /^Continue/i }));

    await waitFor(() =>
      expect(updateSecretsMock).toHaveBeenCalledWith(
        expect.objectContaining({ anthropic_api_key: 'sk-ant-abc123' }),
      ),
    );
  });

  it('F4/F9: a demo-toggle failure shows an inline demo error, not the finish banner', async () => {
    demoEnableMock.mockRejectedValue(new Error('demo backend down'));
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByLabelText(/Demo mode/i));

    await screen.findByText(/Couldn't switch demo mode/i);
    // The finish-only banner must NOT appear for a demo-toggle failure.
    expect(screen.queryByText(/Could not complete setup/i)).toBeNull();
  });

  it('F2: the Review step offers recommended automation and Finish enables it', async () => {
    const user = userEvent.setup();
    renderWizard();

    await user.click(await screen.findByRole('button', { name: /Review & finish/i }));
    const toggle = await screen.findByLabelText(/Let this SOC improve itself/i);
    expect(toggle).toBeChecked(); // default on

    await user.click(screen.getByRole('button', { name: /Finish setup/i }));

    // Enables the #3-safe engines before completing setup.
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('tuning/config'));
    expect(putMock).toHaveBeenCalledWith(
      'tuning/config',
      expect.objectContaining({ enabled: true, shadow_eval: true }),
    );
    expect(putMock).toHaveBeenCalledWith('campaigns/config', { enabled: true });
    await waitFor(() => expect(completeSetupMock).toHaveBeenCalled());
  });
});
