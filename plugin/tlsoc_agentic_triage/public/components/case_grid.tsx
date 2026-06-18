/**
 * Shared case grid: the KPI strip + controls (count, sort, refresh, filters),
 * removable active-filter chips, and the auto-filling card grid. Investigate and
 * Automated Scans both wrap this so the two surfaces behave identically; only the
 * data source and the page header differ.
 */
import React, { useMemo, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiCheckbox,
  EuiFlexGroup,
  EuiFlexItem,
  EuiHorizontalRule,
  EuiLoadingSpinner,
  EuiNotificationBadge,
  EuiPopover,
  EuiSelect,
  EuiSpacer,
  EuiText,
  EuiTitle,
  htmlIdGenerator,
} from '@elastic/eui';
import type { Case } from '../../common';
import {
  applyControls,
  CaseFilters,
  EMPTY_FILTERS,
  filtersActiveCount,
  riskBand,
  riskBandLabel,
  RISK_BANDS,
  type RiskBand,
  SORT_OPTIONS,
  type SortKey,
  type VerdictKey,
  verdictKeyLabel,
} from '../lib/cases';
import { COLORS, EmptyState, StatTile } from './ui';
import { CaseCard } from './case_card';

interface CaseGridProps {
  cases: Case[];
  loading?: boolean;
  onRefresh: () => void;
  selectedCaseId?: string | null;
  onOpenCase: (id: string) => void;
  /** Section heading above the controls (default "Active Cases"). */
  headerTitle?: string;
  /** Noun for the count line: "Reviewing N {noun}…" (default "cases"). */
  countNoun?: string;
  showKpis?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
}

const STATUS_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'needs_human', label: 'Needs human' },
  { id: 'closed', label: 'Closed' },
];
const VERDICT_OPTIONS: VerdictKey[] = ['true_positive', 'false_positive', 'inconclusive', 'unverdicted'];

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

export const CaseGrid: React.FC<CaseGridProps> = ({
  cases,
  loading,
  onRefresh,
  selectedCaseId,
  onOpenCase,
  headerTitle = 'Active Cases',
  countNoun = 'cases',
  showKpis = true,
  emptyTitle = 'No cases yet',
  emptyBody = 'Cases will appear here as the agent opens them.',
}) => {
  const [sort, setSort] = useState<SortKey>('risk_desc');
  const [filters, setFilters] = useState<CaseFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const idGen = useMemo(() => htmlIdGenerator('tlsocFilter'), []);

  const visible = useMemo(() => applyControls(cases, filters, sort), [cases, filters, sort]);
  const activeCount = filtersActiveCount(filters);

  // KPI roll-up over the full (unfiltered) set so the headline numbers are stable.
  const kpis = useMemo(() => {
    let open = 0;
    let needsHuman = 0;
    let critical = 0;
    for (const c of cases) {
      const s = (c.status || '').toLowerCase();
      if (s === 'open') open += 1;
      else if (s === 'needs_human') needsHuman += 1;
      if (riskBand(c.risk_score) === 'critical') critical += 1;
    }
    return { total: cases.length, open, needsHuman, critical };
  }, [cases]);

  const setStatus = (id: string) => setFilters((f) => ({ ...f, statuses: toggle(f.statuses, id) }));
  const setRisk = (b: RiskBand) => setFilters((f) => ({ ...f, riskBands: toggle(f.riskBands, b) }));
  const setVerdict = (v: VerdictKey) => setFilters((f) => ({ ...f, verdicts: toggle(f.verdicts, v) }));

  // Active-filter chips (removable) — flattened from all three dimensions.
  const chips: Array<{ key: string; label: string; remove: () => void }> = [
    ...filters.statuses.map((s) => ({
      key: `s-${s}`,
      label: STATUS_OPTIONS.find((o) => o.id === s)?.label || s,
      remove: () => setStatus(s),
    })),
    ...filters.riskBands.map((b) => ({
      key: `r-${b}`,
      label: `${riskBandLabel(b)} risk`,
      remove: () => setRisk(b),
    })),
    ...filters.verdicts.map((v) => ({
      key: `v-${v}`,
      label: verdictKeyLabel(v),
      remove: () => setVerdict(v),
    })),
  ];

  const checkbox = (group: 'status' | 'risk' | 'verdict', value: string, label: string, checked: boolean) => (
    <EuiCheckbox
      id={idGen(`${group}-${value}`)}
      label={label}
      checked={checked}
      onChange={() => {
        if (group === 'status') setStatus(value);
        else if (group === 'risk') setRisk(value as RiskBand);
        else setVerdict(value as VerdictKey);
      }}
    />
  );

  return (
    <div>
      {/* KPI strip. */}
      {showKpis ? (
        <>
          <EuiFlexGroup gutterSize="m" responsive wrap>
            <EuiFlexItem>
              <StatTile label="Total cases" value={kpis.total} icon="folderOpen" accent={COLORS.primary} />
            </EuiFlexItem>
            <EuiFlexItem>
              <StatTile label="Open" value={kpis.open} icon="dot" accent={COLORS.primary} />
            </EuiFlexItem>
            <EuiFlexItem>
              <StatTile label="Needs human" value={kpis.needsHuman} icon="user" accent={COLORS.warning} />
            </EuiFlexItem>
            <EuiFlexItem>
              <StatTile label="Critical risk" value={kpis.critical} icon="alert" accent={COLORS.danger} />
            </EuiFlexItem>
          </EuiFlexGroup>
          <EuiSpacer size="l" />
        </>
      ) : null}

      {/* Controls bar: heading + count (left); sort / refresh / filters (right). */}
      <EuiFlexGroup justifyContent="spaceBetween" alignItems="flexEnd" gutterSize="m" responsive={false} wrap>
        <EuiFlexItem grow={false}>
          <EuiTitle size="s">
            <h3>{headerTitle}</h3>
          </EuiTitle>
          <EuiText size="s" color="subdued">
            <span>
              {loading
                ? 'Loading…'
                : `Reviewing ${visible.length}${
                    visible.length !== cases.length ? ` of ${cases.length}` : ''
                  } prioritized ${countNoun}${activeCount ? ' (filtered)' : ''}.`}
            </span>
          </EuiText>
        </EuiFlexItem>
        <EuiFlexItem grow={false}>
          <EuiFlexGroup gutterSize="s" responsive={false} alignItems="center">
            <EuiFlexItem grow={false} style={{ minWidth: 190 }}>
              <EuiSelect
                compressed
                prepend="Sort"
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                options={SORT_OPTIONS}
                aria-label="Sort cases"
              />
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiButton size="s" iconType="refresh" onClick={onRefresh} isLoading={loading}>
                Refresh
              </EuiButton>
            </EuiFlexItem>
            <EuiFlexItem grow={false}>
              <EuiPopover
                isOpen={filtersOpen}
                closePopover={() => setFiltersOpen(false)}
                anchorPosition="downRight"
                panelPaddingSize="m"
                button={
                  <EuiButton size="s" iconType="filter" onClick={() => setFiltersOpen((o) => !o)}>
                    Filters
                    {activeCount > 0 ? (
                      <>
                        {' '}
                        <EuiNotificationBadge color="subdued">{activeCount}</EuiNotificationBadge>
                      </>
                    ) : null}
                  </EuiButton>
                }
              >
                <div style={{ minWidth: 220 }}>
                  <EuiText size="xs" color="subdued"><strong>Status</strong></EuiText>
                  <EuiSpacer size="xs" />
                  {STATUS_OPTIONS.map((o) => (
                    <div key={o.id} style={{ marginBottom: 6 }}>
                      {checkbox('status', o.id, o.label, filters.statuses.includes(o.id))}
                    </div>
                  ))}
                  <EuiHorizontalRule margin="s" />
                  <EuiText size="xs" color="subdued"><strong>Risk band</strong></EuiText>
                  <EuiSpacer size="xs" />
                  {RISK_BANDS.map((b) => (
                    <div key={b} style={{ marginBottom: 6 }}>
                      {checkbox('risk', b, `${riskBandLabel(b)} risk`, filters.riskBands.includes(b))}
                    </div>
                  ))}
                  <EuiHorizontalRule margin="s" />
                  <EuiText size="xs" color="subdued"><strong>Verdict</strong></EuiText>
                  <EuiSpacer size="xs" />
                  {VERDICT_OPTIONS.map((v) => (
                    <div key={v} style={{ marginBottom: 6 }}>
                      {checkbox('verdict', v, verdictKeyLabel(v), filters.verdicts.includes(v))}
                    </div>
                  ))}
                  {activeCount > 0 ? (
                    <>
                      <EuiHorizontalRule margin="s" />
                      <EuiButtonEmpty size="xs" iconType="cross" onClick={() => setFilters(EMPTY_FILTERS)}>
                        Clear all filters
                      </EuiButtonEmpty>
                    </>
                  ) : null}
                </div>
              </EuiPopover>
            </EuiFlexItem>
          </EuiFlexGroup>
        </EuiFlexItem>
      </EuiFlexGroup>

      {/* Active-filter chips. */}
      {chips.length ? (
        <>
          <EuiSpacer size="s" />
          <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
            {chips.map((c) => (
              <EuiFlexItem grow={false} key={c.key}>
                <EuiBadge
                  color="hollow"
                  iconType="cross"
                  iconSide="right"
                  iconOnClick={c.remove}
                  iconOnClickAriaLabel={`Remove ${c.label} filter`}
                >
                  {c.label}
                </EuiBadge>
              </EuiFlexItem>
            ))}
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty size="xs" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear
              </EuiButtonEmpty>
            </EuiFlexItem>
          </EuiFlexGroup>
        </>
      ) : null}

      <EuiSpacer size="m" />

      {/* Grid / loading / empty. */}
      {loading && cases.length === 0 ? (
        <EuiFlexGroup justifyContent="center" alignItems="center" style={{ minHeight: 200 }}>
          <EuiFlexItem grow={false}>
            <EuiLoadingSpinner size="xl" />
          </EuiFlexItem>
        </EuiFlexGroup>
      ) : visible.length === 0 ? (
        <EmptyState
          iconType="search"
          title={cases.length === 0 ? emptyTitle : 'No cases match the current filters'}
          body={cases.length === 0 ? emptyBody : 'Try removing a filter to widen the results.'}
        />
      ) : (
        <div className="tlsocCaseGrid">
          {visible.map((c) => (
            <CaseCard
              key={c.case_id || JSON.stringify(c.entity)}
              theCase={c}
              selected={!!c.case_id && c.case_id === selectedCaseId}
              onOpen={() => {
                if (c.case_id) onOpenCase(c.case_id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
};
