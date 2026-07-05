/**
 * ActiveRiskIndex — the ONE Command-Center risk instrument (#1).
 *
 * Renders, inside its OWN bordered soc <Card>, a compact "ACTIVE RISK INDEX" caption + a
 * (?) HelpTip explaining the exact math, and a RiskGauge showing the mean deterministic
 * risk score across the currently OPEN cases. When there are no open cases it degrades to
 * an honest DASH placeholder ("no open cases") rather than drawing a misleading zero gauge.
 *
 * The canonical value is computed server-side (`Metrics.active_risk_index`, W0.5) as the
 * mean deterministic `risk_score` over non-terminal cases; this component is presentation
 * only. It shares `ACTIVE_RISK_HELP_TEXT` (which folds in the per-factor `RISK_HELP_TEXT`)
 * with the per-case triage header so the two never disagree. The full band-cut ladder is
 * spelled out in the HelpTip copy (Critical ≥74 · High ≥48 · Medium ≥22 · Low <22).
 *
 * SECURITY (#9): the score is a code-derived number and the help copy is
 * author-controlled — both render as plain text only. #3: the Active Risk Index is
 * ranking-only and was never fed to the deterministic decide().
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { DASH } from '@/lib/format';

import { Card } from '@/ui/card';
import { Skeleton } from '@/ui/skeleton';
import { RiskGauge } from '@/soc/components/RiskGauge';
import { HelpTip } from '@/soc/components/HelpTip';
import { ACTIVE_RISK_HELP_TEXT } from '@/soc/components/riskCopy';

export interface ActiveRiskIndexProps {
  /** Mean deterministic risk (0-100) over the open cases; null when unknown/loading. */
  score: number | null;
  /** Number of currently OPEN cases the mean was taken over. */
  count?: number;
  /** Show a placeholder while the metric is loading. */
  loading?: boolean;
  /** Gauge width in px (default 180 — a prominent, self-contained instrument card). */
  size?: number;
  className?: string;
}

/**
 * A compact caption + HelpTip that heads both states, so the affordance stays put
 * whether or not there are open cases to gauge.
 */
const Caption: React.FC = () => (
  <div className="flex items-center gap-1">
    <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
      Active Risk Index
    </span>
    <HelpTip text={ACTIVE_RISK_HELP_TEXT} label="What the Active Risk Index means" />
  </div>
);

export const ActiveRiskIndex: React.FC<ActiveRiskIndexProps> = ({
  score,
  count,
  loading,
  size = 180,
  className,
}) => {
  const hasOpen = (count ?? 0) > 0 && score != null && Number.isFinite(score);

  return (
    <Card
      data-testid="active-risk-index"
      className={cn('flex flex-col items-center gap-2 p-5', className)}
    >
      <Caption />
      {loading ? (
        <Skeleton
          className="rounded-lg"
          style={{ width: size, height: Math.round(size * 0.72) }}
          data-testid="active-risk-loading"
        />
      ) : hasOpen ? (
        // `notch={74}` marks the critical auto-escalate boundary on the track so the
        // gauge reads active pressure AGAINST the escalation threshold, not in a vacuum.
        <RiskGauge score={score as number} size={size} notch={74} />
      ) : (
        <div
          data-testid="active-risk-empty"
          className="flex flex-col items-center justify-center gap-0.5 py-2"
          style={{ minWidth: size }}
        >
          <span
            aria-hidden
            className="text-3xl font-semibold leading-none tabular-nums text-muted-foreground"
          >
            {DASH}
          </span>
          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            no open cases
          </span>
        </div>
      )}
    </Card>
  );
};

export default ActiveRiskIndex;
