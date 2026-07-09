/**
 * enableRecommendedAutomation — the ONE place the onboarding surfaces (the first-run
 * Wizard's "Recommended automation" card and the Overview nudge banner) turn on the
 * #3-safe self-improvement engines a beginner SOC should run.
 *
 * WHAT it enables (and why only these two):
 *   - Threshold tuning  (`PUT /api/tuning/config`)  — the nightly, deterministic
 *     observer that reduces false-positive noise from CLOSED cases. We GET the live
 *     config and PUT it back with `enabled:true` + `shadow_eval:true` so the whole
 *     ThresholdTuningConfig round-trips valid AND a threshold raise can never hide a
 *     confirmed TP. Suppression DROPs are routed to Approvals (HITL), never applied.
 *   - Campaign grouping (`PUT /api/campaigns/config`) — the daily, ADVISORY
 *     shared-entity grouping of related cases (the route deep-merges, so we send only
 *     the changed key). We call the PLURAL `campaigns/config` route directly (the
 *     `api.campaign` typed client targets the non-existent SINGULAR path → 404).
 *
 * WHAT it deliberately does NOT enable:
 *   - Baseline (`baseline/config`) is a STRUCTURAL no-op unless LLM batching (a
 *     cost/provider-tier opt-in) is also on and EVENT feeds are configured — enabling
 *     it alone would promise "learn normal activity" while doing nothing, so we leave
 *     it off rather than ship a hollow promise.
 *   - Batch is a cost/provider-tier opt-in, not an "improvement", so it stays off.
 *
 * NON-NEGOTIABLE #3: neither engine touches `decide()`. Tuning is a config-writer that
 * keeps shadow-eval on and routes suppression to HITL; campaigns are advisory grouping
 * that only reference case_ids. Nothing here changes how a case is closed/escalated.
 *
 * Every enable is INDEPENDENT and BEST-EFFORT: a failure of one never blocks the other
 * and never throws (the callers must never let this block setup completion).
 */
import { api } from '@/lib/api';

/** Which grants the caller holds — computed from the RBAC context before calling. */
export interface AutomationGrants {
  /** `automation:manage` (or auth off) — gates threshold tuning. */
  tuning: boolean;
  /** `cases:read` + `users:manage` (or auth off) — gates the admin-gated campaigns PUT. */
  campaigns: boolean;
}

export type AutomationOutcome = 'enabled' | 'skipped' | 'failed';

export interface AutomationResult {
  tuning: AutomationOutcome;
  campaigns: AutomationOutcome;
}

/** True when at least one engine was actually enabled. */
export function anyEnabled(result: AutomationResult): boolean {
  return result.tuning === 'enabled' || result.campaigns === 'enabled';
}

/** True when a grant was held but the enable call failed. */
export function anyFailed(result: AutomationResult): boolean {
  return result.tuning === 'failed' || result.campaigns === 'failed';
}

export async function enableRecommendedAutomation(
  grants: AutomationGrants,
): Promise<AutomationResult> {
  const result: AutomationResult = { tuning: 'skipped', campaigns: 'skipped' };

  if (grants.tuning) {
    try {
      // GET-then-PUT: the tuning PUT replaces the whole ThresholdTuningConfig, so we
      // round-trip the live config and only flip `enabled`/`shadow_eval` — never
      // guessing field names that could 422 the strict Pydantic model.
      const cur = await api.get<{ config?: Record<string, unknown> }>('tuning/config');
      await api.put('tuning/config', {
        ...(cur?.config ?? {}),
        enabled: true,
        shadow_eval: true,
      });
      result.tuning = 'enabled';
    } catch {
      result.tuning = 'failed';
    }
  }

  if (grants.campaigns) {
    try {
      // The plural campaigns/config PUT deep-merges, so we send only the changed key.
      await api.put('campaigns/config', { enabled: true });
      result.campaigns = 'enabled';
    } catch {
      result.campaigns = 'failed';
    }
  }

  return result;
}

// --------------------------------------------------------------------------- //
// Autopilot overhaul — the smart engines are now DEFAULT-ON in the backend, so the
// onboarding surface flips from an opt-in NUDGE to an "Autopilot is ON — here's what
// it's doing" REASSURANCE card with a one-click OFF + a sensitivity dial. These helpers
// back that card. All are best-effort + RBAC-gated by the caller (never throw).
// --------------------------------------------------------------------------- //

/** The one sensitivity dial: scales the three cost/aggression knobs. Mirrors the
 * backend ``AUTOPILOT_PROFILES`` resolver (STANDARDS.md) so the webui can apply a profile
 * in one deep-merge settings PUT. Balanced == the concrete out-of-the-box defaults. */
export type AutopilotProfile = 'conservative' | 'balanced' | 'aggressive';

export const AUTOPILOT_PROFILES: Record<
  AutopilotProfile,
  { auto_investigate_risk_floor: number; daily_usd: number; max_auto_investigations_per_tick: number }
> = {
  conservative: { auto_investigate_risk_floor: 90, daily_usd: 5, max_auto_investigations_per_tick: 10 },
  balanced: { auto_investigate_risk_floor: 70, daily_usd: 10, max_auto_investigations_per_tick: 25 },
  aggressive: { auto_investigate_risk_floor: 40, daily_usd: 50, max_auto_investigations_per_tick: 100 },
};

/** Human-facing one-liners for each profile (rendered in the dial). */
export const AUTOPILOT_PROFILE_BLURBS: Record<AutopilotProfile, string> = {
  conservative: 'Max precision — investigate only critical (risk ≥ 90), lowest spend.',
  balanced: 'The recommended default — investigate high & critical (risk ≥ 70).',
  aggressive: 'Max recall — investigate medium+ (risk ≥ 40), higher spend.',
};

/**
 * Apply an autopilot sensitivity profile in ONE deep-merge settings PUT: it scales the
 * risk-gate floor, the per-tick investigation cap, and the daily $ budget. #3-safe — none
 * of these feeds the deterministic close/escalate decision. Best-effort (returns false on
 * failure, never throws).
 */
export async function setAutopilotProfile(profile: AutopilotProfile): Promise<boolean> {
  const bounds = AUTOPILOT_PROFILES[profile] ?? AUTOPILOT_PROFILES.balanced;
  try {
    // PUT /api/settings deep-merges, so we send only the changed keys (nested caps/budget
    // partials merge onto the stored config).
    await api.put('settings', {
      autopilot_profile: profile,
      auto_investigate_risk_floor: bounds.auto_investigate_risk_floor,
      caps: { max_auto_investigations_per_tick: bounds.max_auto_investigations_per_tick },
      budget: { daily_usd: bounds.daily_usd },
    });
    return true;
  } catch {
    return false;
  }
}

export type AutopilotToggleOutcome = 'disabled' | 'skipped' | 'failed';

export interface AutopilotDisableResult {
  /** The master auto-investigation switch + the tuning engine. */
  autopilot: AutopilotToggleOutcome;
  /** The campaign-grouping engine (admin-gated). */
  campaigns: AutopilotToggleOutcome;
}

/** True when at least one thing was actually turned off. */
export function anyDisabled(result: AutopilotDisableResult): boolean {
  return result.autopilot === 'disabled' || result.campaigns === 'disabled';
}

/**
 * The one-click "turn autopilot off": halts auto-investigation (the master switch) and
 * the nightly self-tuning; admins also stop campaign grouping. Best-effort + RBAC-gated;
 * each part is independent and never throws. #3-safe — turning autopilot off changes what
 * gets INVESTIGATED, never how a case is closed/escalated.
 */
export async function disableAutopilot(
  grants: AutomationGrants,
): Promise<AutopilotDisableResult> {
  const result: AutopilotDisableResult = { autopilot: 'skipped', campaigns: 'skipped' };

  if (grants.tuning) {
    try {
      // Stop auto-investigating everything (master switch) + stop nightly tuning. The
      // settings PUT deep-merges; the tuning PUT round-trips the live config so we only
      // flip `enabled` (never dropping the advanced knobs).
      await api.put('settings', { background_scan_enabled: false });
      const cur = await api.get<{ config?: Record<string, unknown> }>('tuning/config');
      await api.put('tuning/config', { ...(cur?.config ?? {}), enabled: false });
      result.autopilot = 'disabled';
    } catch {
      result.autopilot = 'failed';
    }
  }

  if (grants.campaigns) {
    try {
      await api.put('campaigns/config', { enabled: false });
      result.campaigns = 'disabled';
    } catch {
      result.campaigns = 'failed';
    }
  }

  return result;
}
