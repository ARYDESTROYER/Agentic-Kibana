/**
 * Round-2 Wave 5 — Demo Mode UX render tests.
 *
 * 1. Experimental Settings control (<DemoModeSection/>): renders the mode toggle +
 *    knobs and calls api.demo.enable when "Enable demo mode" is clicked.
 * 2. <DemoBanner/>: shows when the demo tenant is active (status.mode !== 'off')
 *    and renders nothing when off.
 *
 * Both mount under a real <DemoProvider> with a mocked api so the shared status
 * context drives them exactly as it does in the app.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// Mock the typed api client BEFORE importing anything that pulls it in. The mock
// factory is hoisted, so the shared fns must be declared via vi.hoisted().
const { enableMock, statusMock } = vi.hoisted(() => ({
  enableMock: vi.fn(),
  statusMock: vi.fn(),
}));

vi.mock('@/lib/api', () => {
  const ok = (value: unknown) => vi.fn().mockResolvedValue(value);
  return {
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      demo: {
        status: statusMock,
        enable: enableMock,
        reset: ok({ mode: 'seeded', active: true, run_id: 'demo-run' }),
        disable: ok({ mode: 'off', active: false, run_id: null }),
      },
    },
  };
});

// sonner toasts are side-effects we don't assert on; stub them.
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn(), warning: vi.fn() },
}));

import { DemoProvider } from '../demo';
import { DemoModeSection } from '../components/DemoModeSection';
import { DemoBanner } from '../components/DemoBanner';

const OFF = { mode: 'off' as const, active: false, run_id: null };
const ACTIVE = {
  mode: 'live' as const,
  active: true,
  run_id: 'demo-abc',
  seed: 1337,
  history_days: 14,
  tick_seconds: 10,
  incident_rate: 0.05,
  case_count: 42,
};

function withProvider(node: React.ReactNode) {
  return render(<DemoProvider>{node}</DemoProvider>);
}

beforeEach(() => {
  enableMock.mockReset();
  enableMock.mockResolvedValue(ACTIVE);
  statusMock.mockReset();
  // Default: OFF for the status poll. Individual tests override.
  statusMock.mockResolvedValue(OFF);
});

describe('Experimental › Demo Mode control', () => {
  it('renders the mode toggle + knobs and calls api.demo.enable on Enable', async () => {
    statusMock.mockResolvedValue(OFF);
    withProvider(<DemoModeSection />);

    // The experimental label + both mode options render once status (OFF) resolves.
    await waitFor(() => expect(screen.getByText('Experimental')).toBeInTheDocument());
    expect(screen.getByText('Seeded')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    // A knob label proves the arming form (not the active summary) is shown.
    expect(screen.getByText('History')).toBeInTheDocument();

    // Clicking "Enable demo mode" calls the endpoint with a DemoConfig.
    fireEvent.click(screen.getByRole('button', { name: /enable demo mode/i }));
    await waitFor(() => expect(enableMock).toHaveBeenCalledTimes(1));
    const arg = enableMock.mock.calls[0][0];
    expect(arg).toMatchObject({ mode: 'seeded' });
    expect(typeof arg.seed).toBe('number');
  });

  it('shows the active summary + Exit & clear when demo is already active', async () => {
    statusMock.mockResolvedValue(ACTIVE);
    withProvider(<DemoModeSection />);
    await waitFor(() => expect(screen.getByText('Synthetic cases')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /exit & clear/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset/i })).toBeInTheDocument();
  });
});

describe('<DemoBanner/>', () => {
  it('renders nothing when demo mode is off', async () => {
    statusMock.mockResolvedValue(OFF);
    const { container } = withProvider(<DemoBanner />);
    // Allow the status poll to resolve, then assert the banner stayed empty.
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    expect(container.textContent).not.toMatch(/demo mode active/i);
  });

  it('shows the banner with Reset + Exit & clear when demo mode is active', async () => {
    statusMock.mockResolvedValue(ACTIVE);
    withProvider(<DemoBanner />);
    await waitFor(() =>
      expect(screen.getByText(/demo mode active \(simulated data\)/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /^reset$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /exit & clear/i })).toBeInTheDocument();
  });
});
