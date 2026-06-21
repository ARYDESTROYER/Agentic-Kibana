/**
 * Cases / dashboard — the default landing surface and the entry point to the
 * core analyst workflow. Lists recent cases (GET /api/cases) with headline
 * counts and a status filter; clicking any row opens the CaseDetailFlyout where
 * the analyst reviews evidence, the agent trace, the timeline, and takes a
 * lifecycle action.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EuiBasicTable,
  EuiButton,
  EuiFilterButton,
  EuiFilterGroup,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
} from '@elastic/eui';
import type { EuiBasicTableColumn } from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS } from '../../lib/theme';
import { humanizeAge } from '../../lib/format';
import {
  EmptyState,
  ErrorCallout,
  Loading,
  RiskBadge,
  SectionHeader,
  StatTile,
  StatusBadge,
  VerdictBadge,
} from '../common/ui';
import { CaseDetailFlyout } from './CaseDetailFlyout';

type StatusFilter = 'all' | 'open' | 'needs_human' | 'closed';

const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'needs_human', label: 'Needs human' },
  { key: 'closed', label: 'Closed' },
];

export const CasesPage: React.FC = () => {
  const [cases, setCases] = useState<Case[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query: Record<string, unknown> = { limit: 50 };
      if (statusFilter !== 'all') query.status = statusFilter;
      const res = await api.listCases(query);
      setCases(res.cases);
      setTotal(res.total);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    let open = 0;
    let needsHuman = 0;
    let truePositive = 0;
    for (const c of cases) {
      if (c.status === 'open') open += 1;
      if (c.status === 'needs_human') needsHuman += 1;
      if ((c.verdict || '').toUpperCase().includes('TRUE')) truePositive += 1;
    }
    return { open, needsHuman, truePositive };
  }, [cases]);

  const columns: Array<EuiBasicTableColumn<Case>> = [
    {
      field: 'title',
      name: 'Title',
      render: (_: unknown, c: Case) => (
        <span style={{ fontWeight: 600 }}>{c.title || c.case_id}</span>
      ),
    },
    {
      field: 'entity',
      name: 'Entity',
      render: (_: unknown, c: Case) =>
        c.entity ? (
          <span>
            {c.entity.type}: <span className="socMono">{c.entity.value}</span>
          </span>
        ) : (
          '—'
        ),
    },
    {
      field: 'verdict',
      name: 'Verdict',
      render: (_: unknown, c: Case) => <VerdictBadge verdict={c.verdict} />,
    },
    {
      field: 'risk_score',
      name: 'Risk',
      render: (_: unknown, c: Case) => <RiskBadge score={c.risk_score} />,
    },
    {
      field: 'status',
      name: 'Status',
      render: (_: unknown, c: Case) => <StatusBadge status={c.status} />,
    },
    {
      field: 'updated_at',
      name: 'Updated',
      render: (_: unknown, c: Case) => humanizeAge(c.updated_at || c.created_at),
    },
    {
      name: '',
      width: '40px',
      actions: [
        {
          name: 'Open',
          description: 'Open case detail',
          icon: 'expand',
          type: 'icon',
          onClick: (c: Case) => setSelectedCaseId(c.case_id),
        },
      ],
    },
  ];

  return (
    <div>
      <SectionHeader
        icon="securityApp"
        title="Cases"
        description="Audited, human-reviewable triage cases."
        actions={
          <EuiButton size="s" iconType="refresh" onClick={load} isLoading={loading}>
            Refresh
          </EuiButton>
        }
      />

      <EuiFlexGroup gutterSize="m">
        <EuiFlexItem>
          <StatTile label="Total cases" value={total} icon="documents" accent={COLORS.primary} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="Open" value={counts.open} icon="dot" accent={COLORS.primary} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="Needs human" value={counts.needsHuman} icon="alert" accent={COLORS.warning} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="True positives" value={counts.truePositive} icon="bug" accent={COLORS.danger} />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      <EuiFilterGroup>
        {FILTERS.map((f) => (
          <EuiFilterButton
            key={f.key}
            hasActiveFilters={statusFilter === f.key}
            isSelected={statusFilter === f.key}
            onClick={() => setStatusFilter(f.key)}
          >
            {f.label}
          </EuiFilterButton>
        ))}
      </EuiFilterGroup>

      <EuiSpacer size="m" />

      {error ? (
        <>
          <ErrorCallout error={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}
      {loading ? (
        <Loading label="Loading cases…" />
      ) : cases.length === 0 ? (
        <EmptyState
          iconType="securityApp"
          title={statusFilter === 'all' ? 'No cases yet' : 'No matching cases'}
          body={
            statusFilter === 'all'
              ? 'Run an investigation or enable background scans to start triaging.'
              : 'No cases match this status filter. Try "All".'
          }
        />
      ) : (
        <EuiBasicTable
          items={cases}
          columns={columns}
          rowHeader="title"
          rowProps={(c: Case) => ({
            onClick: () => setSelectedCaseId(c.case_id),
            style: { cursor: 'pointer' },
          })}
        />
      )}

      {selectedCaseId ? (
        <CaseDetailFlyout
          caseId={selectedCaseId}
          onClose={() => setSelectedCaseId(null)}
          onChanged={load}
        />
      ) : null}
    </div>
  );
};
