/**
 * Case-mix dashboard widgets (Round 5 / G7): the verdict/severity bar list and the
 * autonomous-vs-human split donut. Both read the SHARED metrics/posture payload
 * (fetched once) and reuse `BarList` / `DonutChart` — no new charting code. Every
 * label is plain text (#9); layout is advisory (#3).
 */
import * as React from 'react';
import { BarChart3, Bot } from 'lucide-react';

import { BarList, type BarListItem } from '@/soc/components/BarList';
import { DonutChart, type DonutSegment } from '@/soc/components/charts';
import { semanticColor } from '@/soc/components/palette';
import { humanizeToken, fmtNumber } from '@/lib/format';

import { useDashboardSource } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetShell, resolveTitle, type WidgetProps } from './common';

// Map a verdict key to a BarList token color class so TP reads critical, FP neutral.
const VERDICT_BAR: Record<string, string> = {
  TRUE_POSITIVE: 'bg-critical',
  FALSE_POSITIVE: 'bg-info',
  NEEDS_HUMAN: 'bg-warning',
  none: 'bg-muted',
};

// --------------------------------------------------------------------------- //
// Open by verdict — a ranked bar list of the verdict breakdown.
// --------------------------------------------------------------------------- //
export function OpenBySeverityWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('metrics');
  const title = resolveTitle(props, 'Cases by verdict');

  const items: BarListItem[] = React.useMemo(() => {
    const bv = data?.by_verdict;
    if (!bv) return [];
    return Object.entries(bv)
      .filter(([, v]) => typeof v === 'number' && v > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => ({
        label: humanizeToken(k),
        value: v,
        color: VERDICT_BAR[k] ?? 'bg-accent-bar',
      }));
  }, [data]);

  const empty =
    error && !data
      ? 'Metrics unavailable'
      : items.length === 0 && !loading
        ? 'No verdicts recorded in this window.'
        : undefined;

  return (
    <WidgetShell
      title={title}
      icon={BarChart3}
      loading={loading && !data}
      emptyMessage={empty}
    >
      <BarList items={items} format={fmtNumber} showPercent />
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Autonomous-vs-human split — auto-closed vs escalated/needs-human, from the
// server posture QUALITY rollup (honest counts, never client-derived).
// --------------------------------------------------------------------------- //
export function AutonomousVsHumanWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('posture');
  const title = resolveTitle(props, 'Autonomous vs human');

  const segments: DonutSegment[] = React.useMemo(() => {
    const q = data?.quality;
    if (!q) return [];
    const auto = Math.max(0, q.auto_closed_cases || 0);
    // "Touched a human" = escalated ∪ still needing a human decision.
    const human = Math.max(0, (q.escalated_cases || 0) + (q.needs_human_cases || 0));
    const out: DonutSegment[] = [];
    if (auto > 0) out.push({ label: 'Auto-resolved', value: auto, color: semanticColor('success') });
    if (human > 0) out.push({ label: 'Human-handled', value: human, color: semanticColor('warning') });
    return out;
  }, [data]);

  const total = segments.reduce((a, s) => a + s.value, 0);
  const empty =
    error && !data
      ? 'Posture data unavailable'
      : segments.length === 0 && !loading
        ? 'No resolved cases in this window.'
        : undefined;

  return (
    <WidgetShell
      title={title}
      icon={Bot}
      accentClass="text-accent"
      loading={loading && !data}
      emptyMessage={empty}
    >
      <DonutChart
        segments={segments}
        format={fmtNumber}
        center={
          <div className="text-center">
            <div className="text-lg font-semibold tabular-nums">{fmtNumber(total)}</div>
            <div className="text-2xs uppercase tracking-wide text-muted-foreground">resolved</div>
          </div>
        }
      />
    </WidgetShell>
  );
}
