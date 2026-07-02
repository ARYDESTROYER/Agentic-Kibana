/**
 * KPI-style dashboard widgets (Round 5 / G7). Each reads the SHARED metrics/posture
 * payload (fetched once by `DashboardDataProvider`) and reuses `KpiTile` — no new
 * charting code. Values render as plain text (#9); layout is advisory (#3).
 */
import { UserCheck, CircleDollarSign } from 'lucide-react';

import { KpiTile } from '@/soc/components/KpiTile';
import { fmtNumber, fmtMoney, DASH } from '@/lib/format';

import {
  useDashboardSource,
  statNumber,
} from '@/soc/dashboard/DashboardDataProvider';
import { WidgetShell, resolveTitle, type WidgetProps } from './common';

// --------------------------------------------------------------------------- //
// Needs-human queue — the count of cases awaiting a human decision.
// --------------------------------------------------------------------------- //
export function NeedsHumanQueueWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('metrics');
  const title = resolveTitle(props, 'Needs-human queue');
  const count = data ? data.needs_human_cases : null;
  const open = data ? data.open_cases : null;

  return (
    <WidgetShell
      title={title}
      icon={UserCheck}
      accentClass="text-warning"
      loading={loading && !data}
      emptyMessage={error && !data ? 'Metrics unavailable' : undefined}
    >
      {/* No inner card frame or icon: the WidgetShell ChartCard already supplies the
          bordered card + the icon chip in its header (ONE card grammar). */}
      <KpiTile
        label="Awaiting a human decision"
        value={count == null ? DASH : fmtNumber(count)}
        sub={open == null ? undefined : `${fmtNumber(open)} open cases total`}
        accent="high"
        goodDirection="down"
        className="border-0 bg-transparent p-0 shadow-none"
      />
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Cost / budget — LLM spend in the active window (from the metrics cost summary).
// --------------------------------------------------------------------------- //
export function CostBudgetWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('metrics');
  const title = resolveTitle(props, 'LLM cost (window)');

  // The metrics payload carries a compact cost summary; be defensive about shape.
  const cost = data?.cost ?? {};
  const totalCost = statNumber(
    (cost.total_cost as number | string | undefined) ?? null,
  );
  const currency = typeof cost.currency === 'string' ? cost.currency : undefined;
  const calls = statNumber((cost.call_count as number | string | undefined) ?? null);

  return (
    <WidgetShell
      title={title}
      icon={CircleDollarSign}
      accentClass="text-success"
      loading={loading && !data}
      emptyMessage={error && !data ? 'Cost data unavailable' : undefined}
    >
      {/* No inner card frame or icon: the WidgetShell ChartCard already supplies the
          bordered card + the icon chip in its header (ONE card grammar). */}
      <KpiTile
        label="Spend in this window"
        value={totalCost == null ? DASH : fmtMoney(totalCost, currency)}
        sub={calls == null ? undefined : `${fmtNumber(calls)} LLM calls`}
        accent="success"
        goodDirection="down"
        className="border-0 bg-transparent p-0 shadow-none"
      />
    </WidgetShell>
  );
}
