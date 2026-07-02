/**
 * Round-6 sweep — useDemoGuard() shape + behavior.
 *
 * Locks the demo guard's public contract to the fields consumers actually use
 * (`active` / `disabled` / `reason`) and asserts the removed `guardProps` API is
 * gone, so the helper can never drift back into an unused parallel surface. The
 * hook is exercised under a real <DemoProvider> with a mocked status endpoint.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

const { statusMock } = vi.hoisted(() => ({ statusMock: vi.fn() }));

vi.mock('@/lib/api', () => ({
  setUnauthorizedHandler: vi.fn(),
  setReauthHandler: vi.fn(),
  api: { demo: { status: statusMock } },
}));

import { DemoProvider, useDemoGuard, type DemoGuard } from '../demo';

const OFF = { mode: 'off' as const, active: false, run_id: null };
const ACTIVE = { mode: 'live' as const, active: true, run_id: 'demo-abc' };

/** Renders the hook and captures its latest value for assertions. */
function harness() {
  const captured: { current: DemoGuard | null } = { current: null };
  function Probe() {
    captured.current = useDemoGuard();
    return null;
  }
  render(
    <DemoProvider>
      <Probe />
    </DemoProvider>,
  );
  return captured;
}

beforeEach(() => {
  statusMock.mockReset();
});

describe('useDemoGuard()', () => {
  it('is inert when demo is off (not disabled, no guardProps surface)', async () => {
    statusMock.mockResolvedValue(OFF);
    const guard = harness();
    await waitFor(() => expect(statusMock).toHaveBeenCalled());
    await waitFor(() => expect(guard.current?.active).toBe(false));

    expect(guard.current).toMatchObject({ active: false, disabled: false });
    expect(typeof guard.current?.reason).toBe('string');
    // The removed parallel API must stay gone.
    expect(guard.current && 'guardProps' in guard.current).toBe(false);
  });

  it('disables with a reason when demo is active', async () => {
    statusMock.mockResolvedValue(ACTIVE);
    const guard = harness();
    await waitFor(() => expect(guard.current?.active).toBe(true));

    expect(guard.current).toMatchObject({ active: true, disabled: true });
    expect(guard.current?.reason).toMatch(/demo mode/i);
    expect(guard.current && 'guardProps' in guard.current).toBe(false);
  });
});
