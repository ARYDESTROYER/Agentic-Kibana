/**
 * Cases / dashboard — the default landing surface and the entry point to the
 * core analyst workflow. Lists recent cases (GET /api/cases) with headline
 * counts, status + verdict filters, and a client-side search; clicking any row
 * opens the CaseDetailFlyout where the analyst reviews evidence, the agent trace,
 * the timeline, and takes a lifecycle action. Hovering a case title surfaces a
 * rich CaseHoverCard preview (zero-network from the loaded row).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiFieldSearch,
  EuiFilterButton,
  EuiFilterGroup,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiToolTip,
} from '@elastic/eui';
import type { Criteria, EuiBasicTableColumn } from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, riskHex, verdictHex } from '../../lib/theme';
import { humanizeAge } from '../../lib/format';
import {
  ErrorCallout,
  RiskBadge,
  Skeleton,
  StatTile,
  StatusBadge,
  VerdictBadge,
} from '../common/ui';
import { CaseDetailFlyout } from './CaseDetailFlyout';
import { CaseHoverCard } from './CaseHoverCard';

type StatusFilter = 'all' | 'open' | 'needs_human' | 'closed';
type VerdictFilter = 'all' | 'true' | 'false' | 'needs_human';
/** Collaboration quick filters (over the loaded rows). */
type CollabFilter = 'all' | 'unassigned' | 'has_comments';

/** Sentinel select value meaning "no assignee filter applied". */
const ANY_ASSIGNEE = '__any__';

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'needs_human', label: 'Needs human' },
  { key: 'closed', label: 'Closed' },
];

const VERDICT_FILTERS: Array<{ key: VerdictFilter; label: string }> = [
  { key: 'all', label: 'Any verdict' },
  { key: 'true', label: 'True positive' },
  { key: 'false', label: 'False positive' },
  { key: 'needs_human', label: 'Needs human' },
];

const COLLAB_FILTERS: Array<{ key: CollabFilter; label: string }> = [
  { key: 'all', label: 'Any' },
  { key: 'unassigned', label: 'Unassigned' },
  { key: 'has_comments', label: 'Has comments' },
];

type SortField = 'title' | 'risk_score' | 'updated_at' | 'status' | 'verdict' | 'assignee';

function verdictClass(c: Case): VerdictFilter {
  const v = (c.verdict || '').toUpperCase();
  if (v.includes('TRUE')) return 'true';
  if (v.includes('FALSE')) return 'false';
  if (v.includes('NEEDS') || v.includes('INCONCLUSIVE') || v.includes('UNKNOWN')) {
    return 'needs_human';
  }
  return 'all';
}

export const CasesPage: React.FC = () => {
  const [cases, setCases] = useState<Case[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>('all');
  const [collabFilter, setCollabFilter] = useState<CollabFilter>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>(ANY_ASSIGNEE);
  const [search, setSearch] = useState('');
  const [sortField, setSortField] = useState<SortField>('updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  /** Page-level cache shared by every CaseHoverCard so hovers never re-fetch. */
  const caseCache = useRef<Map<string, Case>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query: Record<string, unknown> = { limit: 50 };
      if (statusFilter !== 'all') query.status = statusFilter;
      const res = await api.listCases(query);
      setCases(res.cases);
      setTotal(res.total);
      // Seed the hover cache with the freshly loaded list rows.
      for (const c of res.cases) {
        if (!caseCache.current.has(c.case_id)) caseCache.current.set(c.case_id, c);
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Counts are over the full fetched list (not the in-view filtered subset).
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

  // Distinct assignees over the loaded rows → options for the assignee <select>.
  const assigneeOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const c of cases) {
      const a = (c.assignee || '').trim();
      if (a) seen.add(a);
    }
    const names = Array.from(seen).sort((a, b) => a.localeCompare(b));
    return [
      { value: ANY_ASSIGNEE, text: 'Any assignee' },
      ...names.map((n) => ({ value: n, text: n })),
    ];
  }, [cases]);

  // If the active assignee filter no longer exists in the loaded rows
  // (e.g. after a reload), drop it so the list doesn't silently empty out.
  useEffect(() => {
    if (
      assigneeFilter !== ANY_ASSIGNEE &&
      !assigneeOptions.some((o) => o.value === assigneeFilter)
    ) {
      setAssigneeFilter(ANY_ASSIGNEE);
    }
  }, [assigneeFilter, assigneeOptions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = cases;
    if (verdictFilter !== 'all') {
      rows = rows.filter((c) => verdictClass(c) === verdictFilter);
    }
    if (collabFilter === 'unassigned') {
      rows = rows.filter((c) => !(c.assignee || '').trim());
    } else if (collabFilter === 'has_comments') {
      rows = rows.filter((c) => Array.isArray(c.comments) && c.comments.length > 0);
    }
    if (assigneeFilter !== ANY_ASSIGNEE) {
      rows = rows.filter((c) => (c.assignee || '').trim() === assigneeFilter);
    }
    if (q) {
      rows = rows.filter((c) => {
        const hay = [
          c.title,
          c.case_id,
          c.entity?.value,
          c.entity?.type,
          ...(Array.isArray(c.tags) ? c.tags : []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    const sorted = [...rows].sort((a, b) => {
      switch (sortField) {
        case 'risk_score':
          return ((a.risk_score ?? -1) - (b.risk_score ?? -1)) * dir;
        case 'title':
          return (a.title || a.case_id).localeCompare(b.title || b.case_id) * dir;
        case 'status':
          return (a.status || '').localeCompare(b.status || '') * dir;
        case 'verdict':
          return (a.verdict || '').localeCompare(b.verdict || '') * dir;
        case 'assignee':
          // Unassigned (empty) sorts after assigned names within each direction.
          return (a.assignee || '￿').localeCompare(b.assignee || '￿') * dir;
        case 'updated_at':
        default:
          return (
            (a.updated_at || a.created_at || '').localeCompare(
              b.updated_at || b.created_at || '',
            ) * dir
          );
      }
    });
    return sorted;
  }, [cases, search, verdictFilter, collabFilter, assigneeFilter, sortField, sortDir]);

  const onTableChange = useCallback(({ sort }: Criteria<Case>) => {
    if (sort) {
      setSortField(sort.field as SortField);
      setSortDir(sort.direction);
    }
  }, []);

  const columns: Array<EuiBasicTableColumn<Case>> = [
    {
      field: 'title',
      name: 'Title',
      sortable: true,
      render: (_: unknown, c: Case) => {
        const accent = verdictHex(c.verdict) || riskHex(c.risk_score);
        return (
          <CaseHoverCard
            caseId={c.case_id}
            preloaded={c}
            cache={caseCache}
            anchor={
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  borderLeft: `3px solid ${accent}`,
                  paddingLeft: 8,
                  fontWeight: 600,
                  wordBreak: 'break-word',
                }}
              >
                {c.title || c.case_id}
              </span>
            }
          />
        );
      },
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
      field: 'assignee',
      name: 'Assignee',
      sortable: true,
      render: (_: unknown, c: Case) => {
        const assignee = (c.assignee || '').trim();
        if (!assignee) {
          return <EuiBadge color="hollow">Unassigned</EuiBadge>;
        }
        return (
          <EuiBadge color={COLORS.primary} iconType="user">
            {assignee}
          </EuiBadge>
        );
      },
    },
    {
      field: 'tags',
      name: 'Tags',
      render: (_: unknown, c: Case) => {
        const tags = Array.isArray(c.tags) ? c.tags.filter(Boolean) : [];
        const commentCount = Array.isArray(c.comments) ? c.comments.length : 0;
        if (!tags.length && !commentCount) {
          return <span style={{ color: COLORS.subdued }}>—</span>;
        }
        return (
          <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
            {tags.slice(0, 3).map((t) => (
              <EuiFlexItem grow={false} key={t}>
                <EuiBadge color="hollow">{t}</EuiBadge>
              </EuiFlexItem>
            ))}
            {tags.length > 3 ? (
              <EuiFlexItem grow={false}>
                <EuiBadge color="hollow">+{tags.length - 3}</EuiBadge>
              </EuiFlexItem>
            ) : null}
            {commentCount > 0 ? (
              <EuiFlexItem grow={false}>
                <EuiToolTip
                  content={`${commentCount} analyst comment${commentCount === 1 ? '' : 's'}`}
                >
                  <EuiBadge color="hollow" iconType="editorComment">
                    {commentCount}
                  </EuiBadge>
                </EuiToolTip>
              </EuiFlexItem>
            ) : null}
          </EuiFlexGroup>
        );
      },
    },
    {
      field: 'verdict',
      name: 'Verdict',
      sortable: true,
      render: (_: unknown, c: Case) => <VerdictBadge verdict={c.verdict} />,
    },
    {
      field: 'risk_score',
      name: 'Risk',
      sortable: true,
      render: (_: unknown, c: Case) => <RiskBadge score={c.risk_score} />,
    },
    {
      field: 'status',
      name: 'Status',
      sortable: true,
      render: (_: unknown, c: Case) => <StatusBadge status={c.status} />,
    },
    {
      field: 'updated_at',
      name: 'Updated',
      sortable: true,
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
    <div className="socPageEnter" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 8 }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 600, color: 'var(--text-primary)' }}>Cases</h1>
          <p style={{ margin: '5px 0 0', fontSize: 13, color: 'var(--text-secondary)' }}>Audited, human-reviewable triage cases.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={load} style={{ display: 'flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px', border: '1px solid var(--border-input)', background: 'var(--bg-card)', color: 'var(--text-primary)', borderRadius: 6, fontFamily: 'inherit', fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
            Refresh
          </button>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Updated just now</span>
        </div>
      </div>

      <EuiFlexGroup gutterSize="m">
        <EuiFlexItem>
          <StatTile label="Total cases" value={total} icon="documents" accent={COLORS.primary} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="Open (in view)" value={counts.open} icon="dot" accent={COLORS.primary} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="Needs human (in view)" value={counts.needsHuman} icon="alert" accent={COLORS.warning} />
        </EuiFlexItem>
        <EuiFlexItem>
          <StatTile label="True positives (in view)" value={counts.truePositive} icon="bug" accent={COLORS.danger} />
        </EuiFlexItem>
      </EuiFlexGroup>

      <EuiSpacer size="l" />

      {/* Search + Filters with visual grouping */}
      <div className="socFilterRow">
        {/* Search — 40-50% width */}
        <div className="socFilterGroup socFilterGroup--search">
          <span className="socFilterLabel">Search</span>
          <div className="socSearchWrap">
            <span className="socSearchIcon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
              </svg>
            </span>
            <EuiFieldSearch
              placeholder="Search title, entity, IP, tags…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              isClearable
              fullWidth
              compressed={false}
              aria-label="Search cases"
            />
            <span className="socSearchShortcut">Ctrl+K</span>
          </div>
        </div>

        {/* Status */}
        <div className="socFilterGroup">
          <span className="socFilterLabel">Status</span>
          <EuiFilterGroup>
            {STATUS_FILTERS.map((f) => (
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
        </div>

        {/* Verdict */}
        <div className="socFilterGroup">
          <span className="socFilterLabel">Verdict</span>
          <EuiFilterGroup>
            {VERDICT_FILTERS.map((f) => (
              <EuiFilterButton
                key={f.key}
                hasActiveFilters={verdictFilter === f.key}
                isSelected={verdictFilter === f.key}
                onClick={() => setVerdictFilter(f.key)}
              >
                {f.label}
              </EuiFilterButton>
            ))}
          </EuiFilterGroup>
        </div>

        {/* Assignment */}
        <div className="socFilterGroup">
          <span className="socFilterLabel">Assignment</span>
          <EuiFilterGroup>
            {COLLAB_FILTERS.map((f) => (
              <EuiFilterButton
                key={f.key}
                hasActiveFilters={collabFilter === f.key}
                isSelected={collabFilter === f.key}
                onClick={() => setCollabFilter(f.key)}
              >
                {f.label}
              </EuiFilterButton>
            ))}
          </EuiFilterGroup>
        </div>

        {/* Assignee */}
        <div className="socFilterGroup">
          <span className="socFilterLabel">Assignee</span>
          <select
            className="socAssigneeSelect"
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            aria-label="Filter cases by assignee"
          >
            {assigneeOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.text}</option>
            ))}
          </select>
        </div>
      </div>

      <EuiSpacer size="m" />

      {error ? (
        <>
          <ErrorCallout error={error} />
          <EuiSpacer size="m" />
        </>
      ) : null}
      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} height={44} radius={8} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="socEmptyTable">
          {/* Cases count header — visually part of the table */}
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-table-header)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Cases</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>(0)</span>
          </div>
          {/* Table column header */}
          <div className="socEmptyTableHeader" style={{ gridTemplateColumns: '2fr 1.2fr 1fr 1fr 1fr 0.8fr 0.6fr' }}>
            <span>Title</span>
            <span>Entity</span>
            <span>Assignee</span>
            <span>Verdict</span>
            <span>Risk</span>
            <span>Status</span>
            <span>Updated</span>
          </div>
          {/* Empty rows for structure */}
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="socEmptyTableRow" style={{ gridTemplateColumns: '2fr 1.2fr 1fr 1fr 1fr 0.8fr 0.6fr', opacity: 0.3 }}>
              <span style={{ height: 10, borderRadius: 4, background: 'var(--bg-skeleton)', width: '60%' }} />
              <span style={{ height: 10, borderRadius: 4, background: 'var(--bg-skeleton)', width: '70%' }} />
              <span style={{ height: 10, borderRadius: 4, background: 'var(--bg-skeleton)', width: '50%' }} />
              <span style={{ height: 10, borderRadius: 4, background: 'var(--bg-skeleton)', width: '60%' }} />
              <span style={{ height: 10, borderRadius: 4, background: 'var(--bg-skeleton)', width: '40%' }} />
              <span style={{ height: 10, borderRadius: 4, background: 'var(--bg-skeleton)', width: '50%' }} />
              <span style={{ height: 10, borderRadius: 4, background: 'var(--bg-skeleton)', width: '50%' }} />
            </div>
          ))}
          {/* Empty state message */}
          <div style={{ padding: '24px 16px', textAlign: 'center', borderTop: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
              {cases.length === 0
                ? 'No cases available'
                : 'No matching cases found'}
            </div>
            {cases.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 360, margin: '0 auto', lineHeight: 1.6, textAlign: 'left' }}>
                <div style={{ marginBottom: 6 }}>Cases appear when:</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ color: 'var(--status-info)' }}>•</span> Manual investigations complete
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                  <span style={{ color: 'var(--status-info)' }}>•</span> Automated scans create findings
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: 'var(--status-info)' }}>•</span> Alerts are escalated
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                No cases match the current search / verdict filter. Clear them to see all loaded cases.
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <EuiButton size="s" fill iconType="play" onClick={() => {/* navigate to investigate */}}>
                Run Investigation
              </EuiButton>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ border: '1px solid var(--border-default)', borderRadius: 12, overflow: 'hidden', background: 'var(--bg-card)' }}>
          {/* Cases count header — visually part of the table */}
          <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-table-header)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Cases</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>({filtered.length}{filtered.length !== total ? ` of ${total}` : ''})</span>
          </div>
          <EuiBasicTable
            items={filtered}
            columns={columns}
            rowHeader="title"
            sorting={{ sort: { field: sortField, direction: sortDir } }}
            onChange={onTableChange}
            rowProps={(c: Case) => ({
              onClick: () => setSelectedCaseId(c.case_id),
              style: { cursor: 'pointer' },
            })}
          />
        </div>
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
