/**
 * Automated Scans — the board of cases the agent opened from background scanning.
 *
 * Fetches GET /api/scans and renders KPI trend stats (scanned / needs-human /
 * auto-investigated / candidates, derived from the returned cases) above a
 * responsive grid of case cards. A status filter mirrors the Cases page. Each
 * card opens the CaseDetailFlyout on click (it was previously a dead affordance)
 * and shows a rich CaseHoverCard preview on hover/focus.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiFilterButton,
  EuiFilterGroup,
  EuiFlexGroup,
  EuiFlexItem,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { DASH, humanizeAge } from '../../lib/format';
import { COLORS, riskHex, verdictHex } from '../../lib/theme';
import {
  Card,
  EmptyState,
  ErrorCallout,
  Loading,
  RiskBadge,
  SectionHeader,
  StatusBadge,
  TrendStat,
  VerdictBadge,
} from '../common/ui';
import { CaseDetailFlyout } from '../Cases/CaseDetailFlyout';
import { CaseHoverCard } from '../Cases/CaseHoverCard';

type StatusFilter = 'all' | 'open' | 'needs_human' | 'closed';

const STATUS_FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'needs_human', label: 'Needs human' },
  { key: 'closed', label: 'Closed' },
];

/** True when a case verdict reads as a true/likely positive. */
function isTruePositive(c: Case): boolean {
  return (c.verdict || '').toUpperCase().includes('TRUE');
}

/** True when the case still wants a human (status or verdict signals it). */
function needsHuman(c: Case): boolean {
  const s = (c.status || '').toLowerCase();
  const v = (c.verdict || '').toUpperCase();
  return s === 'needs_human' || v.includes('NEEDS_HUMAN') || v.includes('INCONCLUSIVE');
}

/** A case the agent ran the investigator on (it produced a verdict). */
function isInvestigated(c: Case): boolean {
  return Boolean(c.verdict) && (c.verdict || '').toUpperCase() !== 'UNKNOWN';
}

export const ScansPage: React.FC = () => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  /** Page-level cache shared by every CaseHoverCard so hovers never re-fetch. */
  const caseCache = useRef<Map<string, Case>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.scans(50);
      const list = Array.isArray(res?.cases) ? res.cases : [];
      setCases(list);
      for (const c of list) {
        if (!caseCache.current.has(c.case_id)) caseCache.current.set(c.case_id, c);
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const kpis = useMemo(() => {
    const total = cases.length;
    const human = cases.filter(needsHuman).length;
    const investigated = cases.filter(isInvestigated).length;
    const candidates = cases.filter(isTruePositive).length;
    return { total, human, investigated, candidates };
  }, [cases]);

  const visible = useMemo(() => {
    if (statusFilter === 'all') return cases;
    return cases.filter((c) => (c.status || '').toLowerCase() === statusFilter);
  }, [cases, statusFilter]);

  return (
    <div className="socPageEnter">
      <SectionHeader
        icon="reportingApp"
        title="Automated scans"
        description="Cases the agent opened and triaged from background scanning."
        actions={
          <EuiButton size="s" iconType="refresh" onClick={() => void load()} isLoading={loading}>
            Refresh
          </EuiButton>
        }
      />

      {error ? (
        <>
          <ErrorCallout error={error} title="Could not load scan cases" />
          <EuiSpacer size="m" />
        </>
      ) : null}

      {loading ? (
        <Loading label="Loading scans…" />
      ) : (
        <>
          <EuiFlexGroup gutterSize="m" wrap>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="Scanned cases"
                value={kpis.total}
                icon="reportingApp"
                accent={COLORS.primary}
                sub="from background scans"
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="Needs human"
                value={kpis.human}
                icon="userAvatar"
                accent={COLORS.warning}
                sub="awaiting analyst review"
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="Auto-investigated"
                value={kpis.investigated}
                icon="inspect"
                accent={COLORS.success}
                sub="agent produced a verdict"
              />
            </EuiFlexItem>
            <EuiFlexItem style={{ minWidth: 220 }}>
              <TrendStat
                label="True-positive candidates"
                value={kpis.candidates}
                icon="alert"
                accent={COLORS.danger}
                sub="never auto-closed"
              />
            </EuiFlexItem>
          </EuiFlexGroup>

          <EuiSpacer size="l" />

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

          <EuiSpacer size="m" />

          {cases.length === 0 ? (
            <EmptyState
              iconType="reportingApp"
              title="No scan cases yet"
              body="Background scans are off or no clusters yet. Enable background scans in Settings to populate this board."
            />
          ) : visible.length === 0 ? (
            <EmptyState
              iconType="reportingApp"
              title="No scan cases match this filter"
              body="No cases match the current status filter. Try 'All'."
            />
          ) : (
            <div className="socGrid socGrid--cards">
              {visible.map((c) => (
                <ScanCard
                  key={c.case_id}
                  c={c}
                  cache={caseCache}
                  onOpen={() => setSelectedCaseId(c.case_id)}
                />
              ))}
            </div>
          )}
        </>
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

/* ----------------------------------------------------------------- card ---- */

const ScanCard: React.FC<{
  c: Case;
  cache: React.MutableRefObject<Map<string, Case>>;
  onOpen: () => void;
}> = ({ c, cache, onOpen }) => {
  const accent = verdictHex(c.verdict) || riskHex(c.risk_score);
  const entity = c.entity ? `${c.entity.type}: ${c.entity.value}` : DASH;
  const rules = Array.isArray(c.rule_ids) ? c.rule_ids.filter(Boolean) : [];

  const cardBody = (
    <Card
      clickable
      onClick={onOpen}
      accentLeft={accent}
      paddingSize="m"
    >
      <div
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
        aria-label={`Open case ${c.title || c.case_id}`}
        style={{ outline: 'none' }}
      >
        <EuiFlexGroup gutterSize="s" alignItems="baseline" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiText size="xs" color="subdued">
              <span>{entity}</span>
            </EuiText>
          </EuiFlexItem>
          <EuiFlexItem grow={false} style={{ marginLeft: 'auto' }}>
            <EuiText size="xs" color="subdued">
              <span>{humanizeAge(c.created_at)}</span>
            </EuiText>
          </EuiFlexItem>
        </EuiFlexGroup>

        <EuiSpacer size="xs" />

        <EuiText size="s">
          <strong style={{ wordBreak: 'break-word' }}>{c.title || c.case_id}</strong>
        </EuiText>

        <EuiSpacer size="s" />

        <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
          <EuiFlexItem grow={false}>
            <RiskBadge score={c.risk_score} />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <VerdictBadge verdict={c.verdict} />
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            <StatusBadge status={c.status} />
          </EuiFlexItem>
        </EuiFlexGroup>

        {rules.length ? (
          <>
            <EuiSpacer size="s" />
            <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
              {rules.slice(0, 4).map((r) => (
                <EuiFlexItem grow={false} key={r}>
                  <EuiBadge color="hollow" iconType="tag">
                    {r}
                  </EuiBadge>
                </EuiFlexItem>
              ))}
              {rules.length > 4 ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color="hollow">+{rules.length - 4}</EuiBadge>
                </EuiFlexItem>
              ) : null}
            </EuiFlexGroup>
          </>
        ) : null}
      </div>
    </Card>
  );

  return (
    <CaseHoverCard
      caseId={c.case_id}
      preloaded={c}
      cache={cache}
      anchor={cardBody}
      display="block"
    />
  );
};
