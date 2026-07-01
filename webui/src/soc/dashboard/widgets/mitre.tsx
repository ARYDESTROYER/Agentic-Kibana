/**
 * MITRE ATT&CK coverage dashboard widget (Round 5 / G7). Reads the SHARED
 * `mitre/coverage` rollup (fetched once) and reuses the `MitreHeatmap` primitive — no
 * new charting code. Technique ids/names are framework-canonical plain text (#9);
 * layout is advisory (#3).
 */
import * as React from 'react';
import { Crosshair } from 'lucide-react';

import { MitreHeatmap, type MitreTacticColumn } from '@/soc/components/charts-soc';

import { useDashboardSource } from '@/soc/dashboard/DashboardDataProvider';
import { WidgetShell, resolveTitle, type WidgetProps } from './common';

export function MitreHeatmapWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('mitre');
  const title = resolveTitle(props, 'MITRE ATT&CK coverage');

  // Each tactic → a column; cells are its covered techniques (top 8), mirroring the
  // Metrics-page transform so the two heatmaps stay consistent.
  const columns: MitreTacticColumn[] = React.useMemo(() => {
    if (!data || data.covered_techniques <= 0) return [];
    return Object.values(data.by_tactic)
      .filter((t) => t.techniques.length > 0)
      .sort((a, b) => b.covered - a.covered)
      .map((t) => ({
        tactic: t.tactic,
        label: t.tactic, // the framework-canonical id (plain, never attacker-controlled)
        cells: t.techniques.slice(0, 8).map((tech) => ({
          technique: tech.id,
          name: tech.name,
          value: tech.case_count,
        })),
      }));
  }, [data]);

  const empty =
    error && !data
      ? 'Coverage data unavailable'
      : columns.length === 0 && !loading
        ? 'No techniques observed yet.'
        : undefined;

  return (
    <WidgetShell
      title={title}
      icon={Crosshair}
      accentClass="text-critical"
      loading={loading && !data}
      emptyMessage={empty}
    >
      <MitreHeatmap columns={columns} ariaLabel="MITRE ATT&CK coverage" />
    </WidgetShell>
  );
}
