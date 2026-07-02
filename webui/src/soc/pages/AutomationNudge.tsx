/**
 * AutomationNudge — the Overview banner that nudges a beginner SOC to turn on the
 * #3-safe self-improvement engines once at least one source is live but threshold
 * tuning is still off. Part 2 of the onboarding-beginner journey (the Wizard's
 * "Recommended automation" card is Part 1); both share `enableRecommendedAutomation`.
 *
 * RBAC: only rendered for a principal who can act (auth off / `automation:manage`); it
 * SELF-HIDES otherwise so it never nags a user who can't enable anything and never
 * fires a call that would 403. Campaigns are only enabled when the admin grant holds.
 *
 * #3: enabling tuning/campaigns adjusts what gets INVESTIGATED, never how a case is
 * closed/escalated (that stays deterministic). Advisory only.
 */
import * as React from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { useAuth } from '@/soc/auth';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { enableRecommendedAutomation, anyEnabled } from './automation';

export interface AutomationNudgeProps {
  /** Called after ≥1 engine was enabled (the parent hides the banner + refetches). */
  onEnabled: () => void;
  /** Navigate to the tuning/automation settings surface ("Review in Settings"). */
  onReview: () => void;
  /** Persist dismissal + hide (never nag again). */
  onDismiss: () => void;
}

export function AutomationNudge({ onEnabled, onReview, onDismiss }: AutomationNudgeProps) {
  const { authEnabled, hasPermission } = useAuth();
  const canTune = !authEnabled || hasPermission('automation', 'manage');
  const canCampaign =
    !authEnabled || (hasPermission('cases', 'read') && hasPermission('users', 'manage'));
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  // Only nudge a principal who can act on it (never a 403 dead-end).
  if (!canTune) return null;

  const enable = async () => {
    setBusy(true);
    setErr(null);
    const res = await enableRecommendedAutomation({ tuning: canTune, campaigns: canCampaign });
    setBusy(false);
    if (anyEnabled(res)) {
      onEnabled();
      return;
    }
    setErr('Could not turn on automation. You can enable it from Settings.');
  };

  return (
    // `default` variant (AA-safe card text) with a coloured icon — NOT the `info`
    // variant, whose fill token as body text fails 4.5:1 (DESIGN_STANDARD §1.3).
    <Alert data-testid="automation-nudge">
      <Sparkles className="h-4 w-4 text-primary" aria-hidden />
      <AlertTitle>Let this SOC improve itself over time</AlertTitle>
      <AlertDescription>
        <p>
          A source is connected but recommended automation is off. Turn on nightly,
          shadow-checked false-positive tuning
          {canCampaign ? ' and daily campaign grouping' : ''} — it adjusts what gets
          investigated, never how a case is closed or escalated (that stays deterministic).
        </p>
        {err ? <p className="mt-2 text-critical-text">{err}</p> : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={() => void enable()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            Turn on recommended automation
          </Button>
          <Button size="sm" variant="outline" onClick={onReview}>
            Review in Settings
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
