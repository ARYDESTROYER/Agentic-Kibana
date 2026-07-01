/**
 * Lifecycle-timing dashboard widget (Round 5 / G7): MTTA / MTTR / dwell p50 from the
 * SERVER posture rollup (fetched once). Reuses `KpiTile` (bar variant). Sentinel-aware
 * — a `StatBlock` with `available:false` renders an honest DASH via `statP50Duration`,
 * never a fabricated number (#). Layout is advisory (#3); labels are plain text (#9).
 */
import * as React from 'react';
import { Clock, Timer, Gauge } from 'lucide-react';

import { KpiTile, type KpiAccent } from '@/soc/components/KpiTile';
import { isAvailable, useDashboardSource } from '@/soc/dashboard/DashboardDataProvider';
import { statP50Duration } from '@/soc/pages/posture.format';
import type { StatBlock } from '@/soc/pages/Metrics.posture.api';

import { WidgetShell, resolveTitle, type WidgetProps } from './common';

interface TimingRow {
  key: string;
  label: string;
  block: StatBlock | undefined;
  accent: KpiAccent;
  icon: typeof Clock;
}

export function LifecycleTimingWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('posture');
  const title = resolveTitle(props, 'Response timing (p50)');

  const rows: TimingRow[] = React.useMemo(() => {
    const lc = data?.lifecycle;
    return [
      { key: 'mtta', label: 'MTTA', block: lc?.mtta_minutes, accent: 'info', icon: Clock },
      { key: 'mttr', label: 'MTTR', block: lc?.mttr_minutes, accent: 'primary', icon: Timer },
      { key: 'dwell', label: 'Dwell', block: lc?.dwell_minutes, accent: 'high', icon: Gauge },
    ];
  }, [data]);

  // Honest empty: no posture at all → EmptyState. Individual unavailable blocks show
  // DASH per-tile (never a fake zero).
  const empty = error && !data ? 'Posture data unavailable' : undefined;

  return (
    <WidgetShell
      title={title}
      icon={Timer}
      accentClass="text-primary"
      loading={loading && !data}
      emptyMessage={empty}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {rows.map((r) => (
          <KpiTile
            key={r.key}
            variant="bar"
            label={r.label}
            value={statP50Duration(r.block)}
            sub={isAvailable(r.block) ? `${r.block?.count ?? 0} cases` : (r.block?.reason || 'no data')}
            accent={r.accent}
            goodDirection="down"
            icon={r.icon}
          />
        ))}
      </div>
    </WidgetShell>
  );
}
