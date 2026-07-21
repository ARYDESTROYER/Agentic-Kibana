/**
 * AutomationNudge — the Overview "Autopilot is ON" REASSURANCE card.
 *
 * Autopilot overhaul: the #3-safe self-improvement engines (nightly false-positive
 * tuning, campaign grouping, cross-source links, baseline learning, SLA/priority) are now
 * DEFAULT-ON in the backend, and auto-investigation reads every alert + risk-scores every
 * event under a bounded budget. This card INVERTS the old opt-in nudge: instead of asking
 * a beginner to turn things ON, it reassures them that autopilot is already working, lets
 * them tune its sensitivity (conservative / balanced / aggressive) in one click, and gives
 * a one-click OFF. It also surfaces the cost/irreversibility levers autopilot NEVER
 * auto-selects (batch inference, hard budget block) via "Review in Settings".
 *
 * RBAC: only rendered for a principal who can act (auth off / `automation:manage`); it
 * SELF-HIDES otherwise so it never shows controls a user can't use or fires a 403.
 * Campaigns are only toggled when the admin grant holds.
 *
 * #3: turning autopilot on/off or changing its sensitivity adjusts what gets INVESTIGATED
 * and the $ ceiling — never how a case is closed/escalated (that stays deterministic).
 */
import * as React from 'react';
import { Sparkles, Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/soc/auth';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import {
  disableAutopilot,
  anyDisabled,
  setAutopilotProfile,
  AUTOPILOT_PROFILE_BLURBS,
  type AutopilotProfile,
} from './automation';

export interface AutomationNudgeProps {
  /** Called after autopilot state CHANGED (profile set or turned off) so the parent
   * refetches. (Kept as `onEnabled` for back-compat with the prior nudge contract.) */
  onEnabled: () => void;
  /** Navigate to the automation/settings surface ("Review in Settings"). */
  onReview: () => void;
  /** Persist dismissal + hide (never nag again). */
  onDismiss: () => void;
  /** The current autopilot sensitivity (optional; defaults to the balanced standard). */
  profile?: AutopilotProfile;
}

const PROFILE_OPTIONS: { value: AutopilotProfile; label: string }[] = [
  { value: 'conservative', label: 'Conservative' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'aggressive', label: 'Aggressive' },
];

export function AutomationNudge({ onEnabled, onReview, onDismiss, profile }: AutomationNudgeProps) {
  const { authEnabled, hasPermission } = useAuth();
  const canTune = !authEnabled || hasPermission('automation', 'manage');
  const canCampaign =
    !authEnabled || (hasPermission('cases', 'read') && hasPermission('users', 'manage'));
  const [selected, setSelected] = React.useState<AutopilotProfile>(profile ?? 'balanced');
  const [busy, setBusy] = React.useState<null | 'profile' | 'off'>(null);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (profile) setSelected(profile);
  }, [profile]);

  // Only show controls to a principal who can act on them (never a 403 dead-end).
  if (!canTune) return null;

  const changeProfile = async (next: AutopilotProfile) => {
    const prev = selected;
    setSelected(next);
    setBusy('profile');
    setErr(null);
    const ok = await setAutopilotProfile(next);
    setBusy(null);
    if (ok) {
      onEnabled();
      return;
    }
    setSelected(prev);
    setErr('Could not update autopilot sensitivity. You can change it in Settings.');
  };

  const turnOff = async () => {
    setBusy('off');
    setErr(null);
    const res = await disableAutopilot({ tuning: canTune, campaigns: canCampaign });
    setBusy(null);
    if (anyDisabled(res)) {
      onEnabled();
      return;
    }
    setErr('Could not turn off autopilot. You can turn it off from Settings.');
  };

  return (
    // `default` variant (AA-safe card text) with a coloured icon — NOT the `info` variant,
    // whose fill token as body text fails 4.5:1 (DESIGN_STANDARD §1.3).
    <Alert data-testid="automation-nudge">
      <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
      <AlertTitle>Autopilot is on — this SOC is triaging + improving itself</AlertTitle>
      <AlertDescription>
        <p>
          Agentic SOC is reading every alert, risk-scoring every event, and self-tuning nightly
          (shadow-checked false-positive tuning{canCampaign ? ' + campaign grouping' : ''})
          under a bounded daily budget. It adjusts what gets investigated, never how a case
          is closed or escalated — that stays deterministic.
        </p>

        <div className="mt-3">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
            Sensitivity
          </div>
          <SegmentedControl<AutopilotProfile>
            aria-label="Autopilot sensitivity"
            size="sm"
            options={PROFILE_OPTIONS}
            value={selected}
            onValueChange={(v) => void changeProfile(v)}
            disabled={busy !== null}
          />
          <p className="mt-1 text-xs text-muted-foreground">{AUTOPILOT_PROFILE_BLURBS[selected]}</p>
        </div>

        <p className="mt-3 text-xs text-muted-foreground">
          Autopilot never turns on the cost/irreversible levers for you — batch inference
          and a hard budget stop stay off until you choose them.
        </p>

        {err ? <p className="mt-2 text-critical-text">{err}</p> : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={onReview}>
            Review in Settings
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void turnOff()}
            disabled={busy !== null}
            data-testid="autopilot-off"
          >
            {busy === 'off' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Turn autopilot off
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

export default AutomationNudge;
