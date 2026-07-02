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
