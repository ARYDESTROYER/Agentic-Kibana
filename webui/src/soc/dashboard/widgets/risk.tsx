/**
 * Active-risk dashboard widget (Round 5 / G7): the mean case risk score on a
 * `RiskGauge`. Reads the SHARED metrics payload (fetched once). Numeric only — no
 * untrusted markup. Layout is advisory (#3).
 */
import { Gauge } from 'lucide-react';

import { RiskGauge } from '@/soc/components/RiskGauge';
import { statNumber, useDashboardSource } from '@/soc/dashboard/DashboardDataProvider';

import { WidgetShell, resolveTitle, type WidgetProps } from './common';

export function RiskGaugeWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('metrics');
  const title = resolveTitle(props, 'Active risk index');

  const score = statNumber(
    (data?.avg_risk_score as number | string | undefined) ?? null,
  );

  const empty =
    error && !data ? 'Metrics unavailable' : score == null && !loading ? 'No scored cases yet.' : undefined;

  return (
    <WidgetShell
      title={title}
      icon={Gauge}
      accentClass="text-high"
      loading={loading && !data}
      emptyMessage={empty}
    >
      <div className="flex items-center justify-center py-2">
        <RiskGauge score={score ?? 0} label="mean case risk" />
      </div>
    </WidgetShell>
  );
}
