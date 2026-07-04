/**
 * ActiveRiskIndex — the ONE Command-Center risk instrument (#1).
 *
 * Renders a compact "ACTIVE RISK INDEX" caption + a (?) HelpTip explaining the exact
 * math, and a small RiskGauge showing the mean deterministic risk score across the
 * currently OPEN cases. When there are no open cases it degrades to an honest DASH
 * placeholder ("no open cases") rather than drawing a misleading zero gauge.
 *
 * The canonical value is computed server-side (`Metrics.active_risk_index`, W0.5) as the
 * mean deterministic `risk_score` over non-terminal cases; this component is presentation
 * only. It shares `ACTIVE_RISK_HELP_TEXT` (which folds in the per-factor `RISK_HELP_TEXT`)
 * with the per-case triage header so the two never disagree.
 *
 * SECURITY (#9): the score is a code-derived number and the help copy is
 * author-controlled — both render as plain text only. #3: the Active Risk Index is
 * ranking-only and was never fed to the deterministic decide().
 *
 * NOTE (W0.3): no threshold notch here — the band-cut markers on the gauge arc are
 * deferred to Wave 2 (#12). The band cuts are documented in the HelpTip copy instead.
 */
import * as React from 'react';

import { cn } from '@/lib/cn';
import { DASH } from '@/lib/format';

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
  /** Gauge width in px (default 78 — compact enough for the Command-Center hero). */
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
  size = 78,
  className,
}) => {
  const hasOpen = (count ?? 0) > 0 && score != null && Number.isFinite(score);

  return (
    <div
      data-testid="active-risk-index"
      className={cn('flex flex-col items-center gap-1', className)}
    >
      <Caption />
      {loading ? (
        <Skeleton
          className="rounded-lg"
          style={{ width: size, height: Math.round(size * 0.72) }}
          data-testid="active-risk-loading"
        />
      ) : hasOpen ? (
        <RiskGauge score={score as number} size={size} />
      ) : (
        <div
          data-testid="active-risk-empty"
          className="flex flex-col items-center justify-center gap-0.5 py-2"
          style={{ minWidth: size }}
        >
          <span
            aria-hidden
            className="text-2xl font-semibold leading-none tabular-nums text-muted-foreground"
          >
            {DASH}
          </span>
          <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
            no open cases
          </span>
        </div>
      )}
    </div>
  );
};

export default ActiveRiskIndex;
