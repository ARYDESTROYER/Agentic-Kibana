/**
 * enableRecommendedAutomation — the shared onboarding self-improvement enabler
 * (Wizard card + Overview nudge). Locks the #3-safe contract:
 *   - tuning is GET-then-PUT with enabled + shadow_eval always true,
 *   - campaigns uses the PLURAL `campaigns/config` deep-merge path,
 *   - baseline/batch are NEVER touched,
 *   - grants gate each engine, failures are reported (never thrown).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getMock, putMock } = vi.hoisted(() => ({ getMock: vi.fn(), putMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: getMock, put: putMock } }));

import {
  enableRecommendedAutomation,
  anyEnabled,
  anyFailed,
  disableAutopilot,
  anyDisabled,
  setAutopilotProfile,
  AUTOPILOT_PROFILES,
} from '../automation';

describe('enableRecommendedAutomation', () => {
  beforeEach(() => {
    getMock.mockReset();
    putMock.mockReset();
    getMock.mockResolvedValue({
      config: { enabled: false, cadence: 'nightly', shadow_eval: true, min_samples: 25 },
    });
    putMock.mockResolvedValue({ ok: true });
  });

  it('enables tuning via GET-then-PUT with enabled + shadow_eval true (#3-safe)', async () => {
    const res = await enableRecommendedAutomation({ tuning: true, campaigns: false });
    expect(getMock).toHaveBeenCalledWith('tuning/config');
    // The PUT round-trips the live config and only flips enabled/shadow_eval — never
    // dropping the advanced knobs or hiding a confirmed TP.
    expect(putMock).toHaveBeenCalledWith(
      'tuning/config',
      expect.objectContaining({
        enabled: true,
        shadow_eval: true,
        cadence: 'nightly',
        min_samples: 25,
      }),
    );
    expect(res.tuning).toBe('enabled');
    expect(res.campaigns).toBe('skipped');
    expect(anyEnabled(res)).toBe(true);
  });

  it('enables campaigns via the PLURAL campaigns/config path (deep-merge, not the broken singular)', async () => {
    const res = await enableRecommendedAutomation({ tuning: false, campaigns: true });
    expect(putMock).toHaveBeenCalledWith('campaigns/config', { enabled: true });
    expect(getMock).not.toHaveBeenCalled(); // campaigns needs no GET
    expect(res.campaigns).toBe('enabled');
    expect(res.tuning).toBe('skipped');
  });

  it('skips everything when no grants are held (no api calls, #10 sane default)', async () => {
    const res = await enableRecommendedAutomation({ tuning: false, campaigns: false });
    expect(getMock).not.toHaveBeenCalled();
    expect(putMock).not.toHaveBeenCalled();
    expect(res).toEqual({ tuning: 'skipped', campaigns: 'skipped' });
    expect(anyEnabled(res)).toBe(false);
  });

  it('never throws; a failed enable is reported as failed so setup is never blocked', async () => {
    putMock.mockRejectedValue(new Error('403'));
    const res = await enableRecommendedAutomation({ tuning: true, campaigns: true });
    expect(res.tuning).toBe('failed');
    expect(res.campaigns).toBe('failed');
    expect(anyFailed(res)).toBe(true);
    expect(anyEnabled(res)).toBe(false);
  });

  it('NEVER enables baseline or batch (only tuning + campaigns)', async () => {
    await enableRecommendedAutomation({ tuning: true, campaigns: true });
    const putPaths = putMock.mock.calls.map((c) => c[0]);
    expect(putPaths).not.toContain('baseline/config');
    expect(putPaths).not.toContain('batch/config');
    expect(putPaths).toContain('tuning/config');
    expect(putPaths).toContain('campaigns/config');
  });

  it('a tuning failure does not block campaigns (independent, best-effort)', async () => {
    getMock.mockRejectedValue(new Error('boom'));
    const res = await enableRecommendedAutomation({ tuning: true, campaigns: true });
    expect(res.tuning).toBe('failed');
    expect(res.campaigns).toBe('enabled');
    expect(putMock).toHaveBeenCalledWith('campaigns/config', { enabled: true });
  });
});

describe('autopilot dial + one-click OFF (overhaul)', () => {
  beforeEach(() => {
    getMock.mockReset().mockResolvedValue({ config: { enabled: true, shadow_eval: true } });
    putMock.mockReset().mockResolvedValue({ ok: true });
  });

  it('AUTOPILOT_PROFILES matches the STANDARDS bounds', () => {
    expect(AUTOPILOT_PROFILES.conservative).toEqual({
      auto_investigate_risk_floor: 90,
      daily_usd: 5,
      max_auto_investigations_per_tick: 10,
    });
    expect(AUTOPILOT_PROFILES.balanced.auto_investigate_risk_floor).toBe(70);
    expect(AUTOPILOT_PROFILES.aggressive.daily_usd).toBe(50);
  });

  it('setAutopilotProfile deep-merges the three resolved knobs onto settings', async () => {
    const ok = await setAutopilotProfile('conservative');
    expect(ok).toBe(true);
    expect(putMock).toHaveBeenCalledWith('settings', {
      autopilot_profile: 'conservative',
      auto_investigate_risk_floor: 90,
      caps: { max_auto_investigations_per_tick: 10 },
      budget: { daily_usd: 5 },
    });
  });

  it('setAutopilotProfile returns false on failure (never throws)', async () => {
    putMock.mockRejectedValue(new Error('403'));
    await expect(setAutopilotProfile('aggressive')).resolves.toBe(false);
  });

  it('disableAutopilot halts the master switch + tuning, and campaigns for admins', async () => {
    const res = await disableAutopilot({ tuning: true, campaigns: true });
    expect(putMock).toHaveBeenCalledWith('settings', { background_scan_enabled: false });
    expect(getMock).toHaveBeenCalledWith('tuning/config');
    expect(putMock).toHaveBeenCalledWith(
      'tuning/config',
      expect.objectContaining({ enabled: false }),
    );
    expect(putMock).toHaveBeenCalledWith('campaigns/config', { enabled: false });
    expect(res.autopilot).toBe('disabled');
    expect(res.campaigns).toBe('disabled');
    expect(anyDisabled(res)).toBe(true);
  });

  it('disableAutopilot skips campaigns without the admin grant', async () => {
    const res = await disableAutopilot({ tuning: true, campaigns: false });
    expect(res.autopilot).toBe('disabled');
    expect(res.campaigns).toBe('skipped');
    const putPaths = putMock.mock.calls.map((c) => c[0]);
    expect(putPaths).not.toContain('campaigns/config');
  });

  it('disableAutopilot reports failure without throwing (setup never blocked)', async () => {
    putMock.mockRejectedValue(new Error('boom'));
    const res = await disableAutopilot({ tuning: true, campaigns: true });
    expect(res.autopilot).toBe('failed');
    expect(res.campaigns).toBe('failed');
    expect(anyDisabled(res)).toBe(false);
  });
});
