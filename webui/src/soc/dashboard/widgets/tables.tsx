/**
 * Table dashboard widgets (Round 5 / G7): connector health + recent cases. Both read
 * a SHARED payload (fetched once) and reuse the compact `DataTable`. Every cell value
 * (source name, case number, entity, verdict) is source-/operator-derived → rendered
 * as PLAIN text (#9). Layout is advisory (#3); these widgets only READ.
 */
import * as React from 'react';
import { Plug, ListChecks, CheckCircle2, XCircle } from 'lucide-react';

import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { fmtNumber, humanizeAge, humanizeToken, DASH } from '@/lib/format';

import {
  useDashboardSource,
  type SourceHealthRow,
} from '@/soc/dashboard/DashboardDataProvider';
import { WidgetShell, resolveTitle, type WidgetProps } from './common';
import type { Case } from '@/lib/types';

// --------------------------------------------------------------------------- //
// Connector health — per-source enabled state + kind + last poll / buffer depth.
// --------------------------------------------------------------------------- //
export function ConnectorHealthWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('sourcesHealth');
  const title = resolveTitle(props, 'Connector health');

  const rows: SourceHealthRow[] = data?.sources ?? [];

  const columns: DataTableColumn<SourceHealthRow>[] = React.useMemo(
    () => [
      {
        id: 'source',
        header: 'Source',
        cell: (r) => <span className="font-medium">{r.source_name || r.source_id}</span>,
      },
      {
        id: 'kind',
        header: 'Kind',
        cell: (r) => <span className="text-muted-foreground">{humanizeToken(r.kind)}</span>,
      },
      {
        id: 'state',
        header: 'State',
        align: 'center',
        cell: (r) =>
          r.enabled ? (
            <CheckCircle2 className="mx-auto h-4 w-4 text-success" aria-label="Enabled" />
          ) : (
            <XCircle className="mx-auto h-4 w-4 text-muted-foreground" aria-label="Disabled" />
          ),
      },
      {
        id: 'signal',
        header: 'Signal',
        align: 'right',
        cell: (r) => {
          // PULL sources report last-poll age; PUSH sources report live-tail depth.
          if (r.kind === 'push') {
            return <span className="tabular-nums">{fmtNumber(r.buffer_depth)} buffered</span>;
          }
          if (r.last_poll_millis > 0) {
            return (
              <span className="tabular-nums text-muted-foreground">
                {humanizeAge(new Date(r.last_poll_millis).toISOString())}
              </span>
            );
          }
          return <span className="text-muted-foreground">{DASH}</span>;
        },
      },
    ],
    [],
  );

  const empty =
    error && !data
      ? 'Source health unavailable'
      : rows.length === 0 && !loading
        ? 'No sources configured.'
        : undefined;

  return (
    <WidgetShell
      title={title}
      icon={Plug}
      accentClass="text-info"
      loading={loading && !data}
      emptyMessage={empty}
    >
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(r) => r.source_id}
        density="compact"
        ariaLabel="Connector health"
      />
    </WidgetShell>
  );
}

// --------------------------------------------------------------------------- //
// Recent cases — the newest cases with entity + verdict + age.
// --------------------------------------------------------------------------- //
export function RecentCasesWidget(props: WidgetProps) {
  const { loading, data, error } = useDashboardSource('cases');
  const title = resolveTitle(props, 'Recent cases');

  const rows: Case[] = React.useMemo(() => {
    const cases = data?.cases ?? [];
    // Newest first (created_at desc); cap so the widget stays compact.
    return [...cases]
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
      .slice(0, 12);
  }, [data]);

  const columns: DataTableColumn<Case>[] = React.useMemo(
    () => [
      {
        id: 'case',
        header: 'Case',
        cell: (c) => (
          <span className="font-medium">{c.case_number || c.case_id}</span>
        ),
      },
      {
        id: 'entity',
        header: 'Entity',
        cell: (c) => (
          <span className="text-muted-foreground">{c.entity?.value || DASH}</span>
        ),
      },
      {
        id: 'verdict',
        header: 'Verdict',
        cell: (c) => (
          <span>{c.verdict ? humanizeToken(c.verdict) : DASH}</span>
        ),
      },
      {
        id: 'age',
        header: 'Age',
        align: 'right',
        cell: (c) => (
          <span className="tabular-nums text-muted-foreground">{humanizeAge(c.created_at)}</span>
        ),
      },
    ],
    [],
  );

  const empty =
    error && !data
      ? 'Cases unavailable'
      : rows.length === 0 && !loading
        ? 'No cases yet.'
        : undefined;

  return (
    <WidgetShell
      title={title}
      icon={ListChecks}
      accentClass="text-primary"
      loading={loading && !data}
      emptyMessage={empty}
    >
      <DataTable
        columns={columns}
        rows={rows}
        getRowId={(c) => c.case_id}
        density="compact"
        ariaLabel="Recent cases"
      />
    </WidgetShell>
  );
}
