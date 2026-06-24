/**
 * Automated Scans — the board of cases the agent opened from background scanning.
 *
 * Fetches GET /api/scans and renders KPI trend stats (scanned / needs-human /
 * auto-investigated / candidates, derived from the returned cases) above a full
 * client-side filter bar + quick status tabs + a sort selector, then a responsive
 * grid of polished case cards. Each card opens the CaseDetailFlyout on click and
 * shows a rich CaseHoverCard preview on hover/focus.
 *
 * All filtering is CLIENT-SIDE over the loaded list (a single useMemo) and the
 * filter state SELF-HEALS: any selected value that no longer exists after a
 * reload is dropped (see `healFilters`) so the grid can never silently empty
 * behind an un-clearable filter. The filter bar + filter logic are intentionally
 * inlined here (and mirrored in CasesPage) rather than shared in a third module.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiButton,
  EuiButtonEmpty,
  EuiComboBox,
  EuiDualRange,
  EuiFieldSearch,
  EuiFilterButton,
  EuiFilterGroup,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiNotificationBadge,
  EuiPopover,
  EuiSelect,
  EuiSpacer,
  EuiText,
} from '@elastic/eui';
import type { EuiComboBoxOptionOption } from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { DASH, humanizeAge, humanizeToken } from '../../lib/format';
import { COLORS, riskHex, verdictHex } from '../../lib/theme';
import {
  Card,
  ConfidenceBadge,
  EmptyState,
  ErrorCallout,
  Loading,
  PageHeader,
  RiskBadge,
  StatusBadge,
  TrendStat,
  VerdictBadge,
} from '../common/ui';
import { CaseDetailFlyout } from '../Cases/CaseDetailFlyout';
import { CaseHoverCard } from '../Cases/CaseHoverCard';

type StatusTab = 'all' | 'open' | 'needs_human' | 'closed';
type SortOption =
  | 'newest'
  | 'oldest'
  | 'updated_newest'
  | 'updated_oldest'
  | 'risk'
  | 'risk_low'
  | 'verdict'
  | 'status'
  | 'entity'
  | 'source';
type TimeRange = 'all' | '24h' | '7d' | '30d';

const STATUS_TABS: Array<{ key: StatusTab; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'needs_human', label: 'Needs human' },
  { key: 'closed', label: 'Closed' },
];

const SORT_OPTIONS: Array<{ value: SortOption; text: string }> = [
  { value: 'newest', text: 'Newest (created)' },
  { value: 'oldest', text: 'Oldest (created)' },
  { value: 'updated_newest', text: 'Recently updated' },
  { value: 'updated_oldest', text: 'Least recently updated' },
  { value: 'risk', text: 'Highest risk' },
  { value: 'risk_low', text: 'Lowest risk' },
  { value: 'verdict', text: 'Verdict (A→Z)' },
  { value: 'status', text: 'Status (A→Z)' },
  { value: 'entity', text: 'Entity (A→Z)' },
  { value: 'source', text: 'Source (A→Z)' },
];

/** Sentinel facet value for cases with no originating source recorded. */
const UNKNOWN_SOURCE = '__unknown_source__';
const UNKNOWN_SOURCE_LABEL = 'Unknown source';

/** Stable facet key for a case's originating source (null → sentinel). */
function caseSourceKey(c: Case): string {
  const id = (c.source_id || '').trim();
  return id || UNKNOWN_SOURCE;
}

/** Human display name for a case's source (name → id → "Unknown source"). */
function caseSourceLabel(c: Case): string {
  const name = (c.source_name || '').trim();
  if (name) return name;
  const id = (c.source_id || '').trim();
  return id || UNKNOWN_SOURCE_LABEL;
}

/** Sort key for a case's entity (e.g. "ip:1.2.3.4"); empty sorts last. */
function caseEntityKey(c: Case): string {
  if (!c.entity) return '';
  return `${c.entity.type || ''}:${c.entity.value || ''}`;
}

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

/* ------------------------------------------------------- filter primitives -- */
/* The filter MODEL + pure helpers below are kept inline (mirrored in CasesPage)
 * so the two pages never depend on a third shared module another agent edits. */

/** The complete client-side filter state. Everything narrows the loaded rows. */
interface CaseFilters {
  search: string;
  /** Multi-select facets — empty array == "any". */
  verdicts: string[];
  statuses: string[];
  rules: string[];
  personas: string[];
  playbooks: string[];
  assignees: string[];
  tags: string[];
  /** Originating source (by source_id; UNKNOWN_SOURCE bucket for null). */
  sources: string[];
  /** Risk band over the normalised 0..100 score. */
  riskMin: number;
  riskMax: number;
  /** Created-within window. */
  timeRange: TimeRange;
  /** Pseudo-assignee: rows with no assignee. */
  unassigned: boolean;
}

const EMPTY_FILTERS: CaseFilters = {
  search: '',
  verdicts: [],
  statuses: [],
  rules: [],
  personas: [],
  playbooks: [],
  assignees: [],
  tags: [],
  sources: [],
  riskMin: 0,
  riskMax: 100,
  timeRange: 'all',
  unassigned: false,
};

/** Distinct facet values present in the loaded rows (drives the multi-selects). */
interface Facets {
  verdicts: string[];
  statuses: string[];
  rules: string[];
  personas: string[];
  playbooks: string[];
  assignees: string[];
  tags: string[];
  /** Distinct source keys (source_id, or UNKNOWN_SOURCE for null). */
  sources: string[];
  /** source key → display label (source_name, fall back to id / "Unknown source"). */
  sourceLabels: Record<string, string>;
}

const sortedUniq = (vals: Iterable<string>): string[] =>
  Array.from(new Set(vals)).sort((a, b) => a.localeCompare(b));

/** All rule ids/name on a case (handles both rule_ids[] and a scalar `rule`). */
function caseRules(c: Case): string[] {
  const out: string[] = [];
  if (Array.isArray(c.rule_ids)) out.push(...c.rule_ids.filter(Boolean).map(String));
  const scalar = (c as Record<string, unknown>).rule;
  if (typeof scalar === 'string' && scalar.trim()) out.push(scalar.trim());
  return out;
}

function buildFacets(cases: Case[]): Facets {
  const verdicts = new Set<string>();
  const statuses = new Set<string>();
  const rules = new Set<string>();
  const personas = new Set<string>();
  const playbooks = new Set<string>();
  const assignees = new Set<string>();
  const tags = new Set<string>();
  const sources = new Set<string>();
  const sourceLabels: Record<string, string> = {};
  for (const c of cases) {
    if (c.verdict) verdicts.add(c.verdict);
    if (c.status) statuses.add(c.status);
    for (const r of caseRules(c)) rules.add(r);
    if (c.agent_persona) personas.add(c.agent_persona);
    if (c.playbook_id) playbooks.add(c.playbook_id);
    const a = (c.assignee || '').trim();
    if (a) assignees.add(a);
    if (Array.isArray(c.tags)) for (const t of c.tags) if (t) tags.add(t);
    const sk = caseSourceKey(c);
    sources.add(sk);
    // First non-sentinel label wins; the sentinel keeps its fixed label.
    if (sk !== UNKNOWN_SOURCE && !sourceLabels[sk]) sourceLabels[sk] = caseSourceLabel(c);
  }
  if (sources.has(UNKNOWN_SOURCE)) sourceLabels[UNKNOWN_SOURCE] = UNKNOWN_SOURCE_LABEL;
  // Sort by label so the picker reads naturally; the sentinel sinks to the end.
  const sortedSources = Array.from(sources).sort((a, b) => {
    if (a === UNKNOWN_SOURCE) return 1;
    if (b === UNKNOWN_SOURCE) return -1;
    return (sourceLabels[a] || a).localeCompare(sourceLabels[b] || b);
  });
  return {
    verdicts: sortedUniq(verdicts),
    statuses: sortedUniq(statuses),
    rules: sortedUniq(rules),
    personas: sortedUniq(personas),
    playbooks: sortedUniq(playbooks),
    assignees: sortedUniq(assignees),
    tags: sortedUniq(tags),
    sources: sortedSources,
    sourceLabels,
  };
}

/** Drop any selected value no longer present in the facets (self-healing). */
function healFilters(f: CaseFilters, facets: Facets): CaseFilters {
  const keep = (sel: string[], avail: string[]) => {
    const set = new Set(avail);
    const next = sel.filter((v) => set.has(v));
    return next.length === sel.length ? sel : next;
  };
  const next: CaseFilters = {
    ...f,
    verdicts: keep(f.verdicts, facets.verdicts),
    statuses: keep(f.statuses, facets.statuses),
    rules: keep(f.rules, facets.rules),
    personas: keep(f.personas, facets.personas),
    playbooks: keep(f.playbooks, facets.playbooks),
    assignees: keep(f.assignees, facets.assignees),
    tags: keep(f.tags, facets.tags),
    sources: keep(f.sources, facets.sources),
  };
  const same =
    next.verdicts === f.verdicts &&
    next.statuses === f.statuses &&
    next.rules === f.rules &&
    next.personas === f.personas &&
    next.playbooks === f.playbooks &&
    next.assignees === f.assignees &&
    next.tags === f.tags &&
    next.sources === f.sources;
  return same ? f : next;
}

const TIME_RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

/** Apply every active filter to the loaded rows (pure; one pass). */
function applyFilters(cases: Case[], f: CaseFilters): Case[] {
  const q = f.search.trim().toLowerCase();
  const now = Date.now();
  const horizon = f.timeRange === 'all' ? 0 : now - TIME_RANGE_MS[f.timeRange];
  const vSet = new Set(f.verdicts);
  const sSet = new Set(f.statuses);
  const ruleSet = new Set(f.rules);
  const pSet = new Set(f.personas);
  const pbSet = new Set(f.playbooks);
  const aSet = new Set(f.assignees);
  const tagSet = new Set(f.tags);
  const srcSet = new Set(f.sources);

  return cases.filter((c) => {
    if (vSet.size && !vSet.has(c.verdict || '')) return false;
    if (sSet.size && !sSet.has(c.status || '')) return false;
    if (ruleSet.size && !caseRules(c).some((r) => ruleSet.has(r))) return false;
    if (pSet.size && !pSet.has(c.agent_persona || '')) return false;
    if (pbSet.size && !pbSet.has(c.playbook_id || '')) return false;
    if (srcSet.size && !srcSet.has(caseSourceKey(c))) return false;

    const assignee = (c.assignee || '').trim();
    const assigneeFilterActive = aSet.size > 0 || f.unassigned;
    if (assigneeFilterActive) {
      const matchesNamed = aSet.has(assignee);
      const matchesUnassigned = f.unassigned && !assignee;
      if (!matchesNamed && !matchesUnassigned) return false;
    }

    if (tagSet.size) {
      const ct = Array.isArray(c.tags) ? c.tags : [];
      if (!ct.some((t) => tagSet.has(t))) return false;
    }

    const score = typeof c.risk_score === 'number' ? c.risk_score : null;
    if (f.riskMin > 0 || f.riskMax < 100) {
      if (score === null) return false;
      if (score < f.riskMin || score > f.riskMax) return false;
    }

    if (horizon) {
      const ts = Date.parse(c.created_at || c.updated_at || '');
      if (Number.isNaN(ts) || ts < horizon) return false;
    }

    if (q) {
      const hay = [
        c.title,
        c.case_id,
        c.entity?.value,
        c.entity?.type,
        ...caseRules(c),
        ...(Array.isArray(c.tags) ? c.tags : []),
        c.assignee,
        c.source_name,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Count the active (non-default) filter dimensions — drives "Clear". */
function countActiveFilters(f: CaseFilters): number {
  return (
    (f.search.trim() ? 1 : 0) +
    f.verdicts.length +
    f.statuses.length +
    f.rules.length +
    f.personas.length +
    f.playbooks.length +
    f.assignees.length +
    f.tags.length +
    f.sources.length +
    (f.unassigned ? 1 : 0) +
    (f.riskMin > 0 || f.riskMax < 100 ? 1 : 0) +
    (f.timeRange !== 'all' ? 1 : 0)
  );
}

/* ----------------------------------------------------------------- page ----- */

/** localStorage key for the operator's last-seen scan timestamp (the "N new" pill). */
const LAST_SEEN_KEY = 'tlsoc.scans.lastSeen';

function readLastSeen(): string | null {
  try {
    return window.localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

function writeLastSeen(ts: string): void {
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, ts);
  } catch {
    /* private mode / quota — the pill simply won't persist. */
  }
}

export const ScansPage: React.FC = () => {
  const [cases, setCases] = useState<Case[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [statusTab, setStatusTab] = useState<StatusTab>('all');
  const [sortBy, setSortBy] = useState<SortOption>('newest');
  const [filters, setFilters] = useState<CaseFilters>(EMPTY_FILTERS);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  /**
   * The watermark for "new" cases — cases created strictly after this timestamp
   * get a "New" flag + count toward the header pill. Seeded from localStorage so
   * it survives reloads; cleared (advanced to "now") when the operator marks all
   * as seen. Held in a ref so re-renders don't re-derive the new-set mid-session.
   */
  const lastSeenRef = useRef<string | null>(readLastSeen());
  const [newCount, setNewCount] = useState(0);
  const [newIds, setNewIds] = useState<Set<string>>(() => new Set());

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
      // Mark which loaded cards are new (created after the last-seen watermark).
      const since = lastSeenRef.current;
      const sinceMs = since ? Date.parse(since) : NaN;
      const fresh = new Set<string>();
      if (!Number.isNaN(sinceMs)) {
        for (const c of list) {
          const ts = Date.parse(c.created_at || '');
          if (!Number.isNaN(ts) && ts > sinceMs) fresh.add(c.case_id);
        }
      }
      setNewIds(fresh);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  /** Poll the backend for the authoritative "new since last-seen" count. */
  const refreshNotifications = useCallback(async () => {
    try {
      const res = await api.scanNotifications(lastSeenRef.current || undefined);
      setNewCount(typeof res?.new_count === 'number' ? res.new_count : 0);
    } catch {
      // Best-effort badge — failures leave the prior count untouched.
    }
  }, []);

  /** Operator acknowledged the new cases: advance the watermark to "now". */
  const markAllSeen = useCallback(() => {
    const now = new Date().toISOString();
    lastSeenRef.current = now;
    writeLastSeen(now);
    setNewCount(0);
    setNewIds(new Set());
  }, []);

  useEffect(() => {
    void load();
    void refreshNotifications();
  }, [load, refreshNotifications]);

  const kpis = useMemo(() => {
    const total = cases.length;
    const human = cases.filter(needsHuman).length;
    const investigated = cases.filter(isInvestigated).length;
    const candidates = cases.filter(isTruePositive).length;
    return { total, human, investigated, candidates };
  }, [cases]);

  // Per-tab counts over the loaded rows (drives the "All 50 · Open …" pills).
  const tabCounts = useMemo<Record<StatusTab, number>>(() => {
    const counts: Record<StatusTab, number> = { all: cases.length, open: 0, needs_human: 0, closed: 0 };
    for (const c of cases) {
      const s = (c.status || '').toLowerCase();
      if (s === 'open') counts.open += 1;
      else if (s === 'needs_human') counts.needs_human += 1;
      else if (s === 'closed') counts.closed += 1;
    }
    return counts;
  }, [cases]);

  const facets = useMemo(() => buildFacets(cases), [cases]);

  // Self-heal: when the loaded rows change drop any stale selected facet value.
  useEffect(() => {
    setFilters((f) => healFilters(f, facets));
  }, [facets]);

  const visible = useMemo(() => {
    // The quick tab is a coarse pre-filter; the bar narrows further; then sort.
    let rows = cases;
    if (statusTab !== 'all') {
      rows = rows.filter((c) => (c.status || '').toLowerCase() === statusTab);
    }
    rows = applyFilters(rows, filters);
    const out = [...rows];
    out.sort((a, b) => {
      switch (sortBy) {
        case 'oldest':
          return (a.created_at || '').localeCompare(b.created_at || '');
        case 'updated_newest':
          return (b.updated_at || b.created_at || '').localeCompare(
            a.updated_at || a.created_at || '',
          );
        case 'updated_oldest':
          return (a.updated_at || a.created_at || '').localeCompare(
            b.updated_at || b.created_at || '',
          );
        case 'risk':
          return (b.risk_score ?? -1) - (a.risk_score ?? -1);
        case 'risk_low':
          return (a.risk_score ?? -1) - (b.risk_score ?? -1);
        case 'verdict':
          return (a.verdict || '￿').localeCompare(b.verdict || '￿');
        case 'status':
          return (a.status || '￿').localeCompare(b.status || '￿');
        case 'entity':
          // Cases with no entity sort last.
          return (caseEntityKey(a) || '￿').localeCompare(caseEntityKey(b) || '￿');
        case 'source':
          // Unknown/missing source sorts last.
          return (caseSourceLabel(a) === UNKNOWN_SOURCE_LABEL ? '￿' : caseSourceLabel(a)).localeCompare(
            caseSourceLabel(b) === UNKNOWN_SOURCE_LABEL ? '￿' : caseSourceLabel(b),
          );
        case 'newest':
        default:
          return (b.created_at || '').localeCompare(a.created_at || '');
      }
    });
    return out;
  }, [cases, statusTab, filters, sortBy]);

  return (
    <div className="socPageEnter">
      <PageHeader
        eyebrow="AUTOMATION"
        icon="reportingApp"
        title="Automated scans"
        description="Cases the agent opened and triaged from background scanning."
        actions={
          <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
            {newCount > 0 ? (
              <EuiFlexItem grow={false}>
                <EuiButtonEmpty
                  size="s"
                  iconType="bell"
                  onClick={markAllSeen}
                  aria-label={`${newCount} new scan cases since you last looked — mark all as seen`}
                >
                  <EuiFlexGroup gutterSize="xs" alignItems="center" responsive={false}>
                    <EuiFlexItem grow={false}>
                      <EuiNotificationBadge color="accent">{newCount}</EuiNotificationBadge>
                    </EuiFlexItem>
                    <EuiFlexItem grow={false}>new</EuiFlexItem>
                  </EuiFlexGroup>
                </EuiButtonEmpty>
              </EuiFlexItem>
            ) : null}
            <EuiFlexItem grow={false}>
              <EuiButton
                size="s"
                iconType="refresh"
                onClick={() => {
                  void load();
                  void refreshNotifications();
                }}
                isLoading={loading}
              >
                Refresh
              </EuiButton>
            </EuiFlexItem>
          </EuiFlexGroup>
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

          <ScanFilterBar
            loadedCount={cases.length}
            filters={filters}
            onChange={setFilters}
            facets={facets}
            shown={visible.length}
          />

          <EuiSpacer size="m" />

          <EuiFlexGroup gutterSize="m" alignItems="center" responsive={false} wrap>
            <EuiFlexItem grow={false}>
              <EuiFilterGroup>
                {STATUS_TABS.map((f) => (
                  <EuiFilterButton
                    key={f.key}
                    hasActiveFilters={statusTab === f.key}
                    isSelected={statusTab === f.key}
                    onClick={() => setStatusTab(f.key)}
                    numFilters={tabCounts[f.key]}
                    numActiveFilters={statusTab === f.key ? tabCounts[f.key] : undefined}
                  >
                    {f.label}
                  </EuiFilterButton>
                ))}
              </EuiFilterGroup>
            </EuiFlexItem>
            <EuiFlexItem grow={false} style={{ minWidth: 180, marginLeft: 'auto' }}>
              <EuiSelect
                compressed
                prepend="Sort"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortOption)}
                options={SORT_OPTIONS}
                aria-label="Sort scan cases"
              />
            </EuiFlexItem>
          </EuiFlexGroup>

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
              title="No scan cases match your filters"
              body="No loaded cases match the current tab + filters. Clear them to see all scan cases."
              actions={
                <EuiButton
                  size="s"
                  iconType="cross"
                  onClick={() => {
                    setFilters(EMPTY_FILTERS);
                    setStatusTab('all');
                  }}
                >
                  Clear filters
                </EuiButton>
              }
            />
          ) : (
            <div className="socGrid socGrid--cards">
              {visible.map((c) => (
                <ScanCard
                  key={c.case_id}
                  c={c}
                  cache={caseCache}
                  isNew={newIds.has(c.case_id)}
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

/* ------------------------------------------------------------ filter bar ---- */

const toOpts = (vals: string[]): Array<EuiComboBoxOptionOption<string>> =>
  vals.map((v) => ({ label: humanizeToken(v), value: v }));
const fromOpts = (sel: Array<EuiComboBoxOptionOption<string>>): string[] =>
  sel.map((o) => (o.value ?? o.label) as string);

/**
 * The shared client-side filter toolbar (same idiom as CasesPage). Primary
 * controls (search, verdict, status) inline; the long-tail facets behind a
 * "More filters" popover.
 */
const ScanFilterBar: React.FC<{
  loadedCount: number;
  filters: CaseFilters;
  onChange: (next: CaseFilters) => void;
  facets: Facets;
  shown: number;
}> = ({ loadedCount, filters, onChange, facets, shown }) => {
  const [moreOpen, setMoreOpen] = useState(false);

  const set = <K extends keyof CaseFilters>(key: K, value: CaseFilters[K]) =>
    onChange({ ...filters, [key]: value });

  const anyActive = countActiveFilters(filters) > 0;

  const moreActive =
    filters.rules.length +
    filters.personas.length +
    filters.playbooks.length +
    filters.assignees.length +
    filters.tags.length +
    filters.sources.length +
    (filters.unassigned ? 1 : 0) +
    (filters.riskMin > 0 || filters.riskMax < 100 ? 1 : 0) +
    (filters.timeRange !== 'all' ? 1 : 0);

  // Source options carry the stable source key as `value` and the display label.
  const sourceOpts = (keys: string[]): Array<EuiComboBoxOptionOption<string>> =>
    keys.map((k) => ({
      label: facets.sourceLabels[k] || (k === UNKNOWN_SOURCE ? UNKNOWN_SOURCE_LABEL : k),
      value: k,
    }));

  return (
    <EuiFlexGroup gutterSize="s" alignItems="center" responsive={false} wrap>
      <EuiFlexItem grow={false} style={{ minWidth: 240 }}>
        <EuiFieldSearch
          placeholder="Search title, entity, IP, rule, tags…"
          value={filters.search}
          onChange={(e) => set('search', e.target.value)}
          isClearable
          fullWidth
          compressed
          aria-label="Search scan cases"
        />
      </EuiFlexItem>

      <EuiFlexItem grow={false} style={{ minWidth: 180, maxWidth: 280 }}>
        <EuiComboBox
          compressed
          placeholder="Verdict"
          aria-label="Filter by verdict"
          options={toOpts(facets.verdicts)}
          selectedOptions={toOpts(filters.verdicts)}
          onChange={(sel) => set('verdicts', fromOpts(sel))}
          isClearable
        />
      </EuiFlexItem>

      <EuiFlexItem grow={false} style={{ minWidth: 180, maxWidth: 280 }}>
        <EuiComboBox
          compressed
          placeholder="Status"
          aria-label="Filter by status"
          options={toOpts(facets.statuses)}
          selectedOptions={toOpts(filters.statuses)}
          onChange={(sel) => set('statuses', fromOpts(sel))}
          isClearable
        />
      </EuiFlexItem>

      <EuiFlexItem grow={false}>
        <EuiPopover
          isOpen={moreOpen}
          closePopover={() => setMoreOpen(false)}
          anchorPosition="downLeft"
          panelPaddingSize="m"
          button={
            <EuiButton
              size="s"
              iconType="filter"
              iconSide="left"
              onClick={() => setMoreOpen((o) => !o)}
            >
              More filters{moreActive ? ` (${moreActive})` : ''}
            </EuiButton>
          }
        >
          <div style={{ width: 320, maxWidth: '90vw' }}>
            <EuiFormRow label="Risk score" fullWidth>
              <EuiDualRange
                min={0}
                max={100}
                step={1}
                value={[filters.riskMin, filters.riskMax]}
                onChange={([lo, hi]) =>
                  onChange({ ...filters, riskMin: Number(lo), riskMax: Number(hi) })
                }
                showInput="inputWithPopover"
                showTicks={false}
                aria-label="Filter by risk score range"
                fullWidth
                compressed
              />
            </EuiFormRow>

            <EuiFormRow label="Created within" fullWidth>
              <EuiSelect
                compressed
                fullWidth
                value={filters.timeRange}
                onChange={(e) => set('timeRange', e.target.value as TimeRange)}
                options={[
                  { value: 'all', text: 'Any time' },
                  { value: '24h', text: 'Last 24 hours' },
                  { value: '7d', text: 'Last 7 days' },
                  { value: '30d', text: 'Last 30 days' },
                ]}
                aria-label="Filter by created time"
              />
            </EuiFormRow>

            {facets.sources.length ? (
              <EuiFormRow label="Source" fullWidth>
                <EuiComboBox
                  compressed
                  fullWidth
                  placeholder="Any source"
                  aria-label="Filter by originating source"
                  options={sourceOpts(facets.sources)}
                  selectedOptions={sourceOpts(filters.sources)}
                  onChange={(sel) => set('sources', fromOpts(sel))}
                  isClearable
                />
              </EuiFormRow>
            ) : null}

            {facets.rules.length ? (
              <EuiFormRow label="Rule / module" fullWidth>
                <EuiComboBox
                  compressed
                  fullWidth
                  placeholder="Any rule"
                  options={toOpts(facets.rules)}
                  selectedOptions={toOpts(filters.rules)}
                  onChange={(sel) => set('rules', fromOpts(sel))}
                  isClearable
                />
              </EuiFormRow>
            ) : null}

            {facets.personas.length ? (
              <EuiFormRow label="Persona" fullWidth>
                <EuiComboBox
                  compressed
                  fullWidth
                  placeholder="Any persona"
                  options={toOpts(facets.personas)}
                  selectedOptions={toOpts(filters.personas)}
                  onChange={(sel) => set('personas', fromOpts(sel))}
                  isClearable
                />
              </EuiFormRow>
            ) : null}

            {facets.playbooks.length ? (
              <EuiFormRow label="Playbook" fullWidth>
                <EuiComboBox
                  compressed
                  fullWidth
                  placeholder="Any playbook"
                  options={toOpts(facets.playbooks)}
                  selectedOptions={toOpts(filters.playbooks)}
                  onChange={(sel) => set('playbooks', fromOpts(sel))}
                  isClearable
                />
              </EuiFormRow>
            ) : null}

            <EuiFormRow label="Assignee" fullWidth>
              <EuiComboBox
                compressed
                fullWidth
                placeholder="Any assignee"
                options={[
                  { label: 'Unassigned', value: '__unassigned__' },
                  ...toOpts(facets.assignees),
                ]}
                selectedOptions={[
                  ...(filters.unassigned
                    ? [{ label: 'Unassigned', value: '__unassigned__' }]
                    : []),
                  ...toOpts(filters.assignees),
                ]}
                onChange={(sel) => {
                  const vals = fromOpts(sel);
                  onChange({
                    ...filters,
                    unassigned: vals.includes('__unassigned__'),
                    assignees: vals.filter((v) => v !== '__unassigned__'),
                  });
                }}
                isClearable
              />
            </EuiFormRow>

            {facets.tags.length ? (
              <EuiFormRow label="Tags" fullWidth>
                <EuiComboBox
                  compressed
                  fullWidth
                  placeholder="Any tag"
                  options={toOpts(facets.tags)}
                  selectedOptions={toOpts(filters.tags)}
                  onChange={(sel) => set('tags', fromOpts(sel))}
                  isClearable
                />
              </EuiFormRow>
            ) : null}
          </div>
        </EuiPopover>
      </EuiFlexItem>

      <EuiFlexItem grow={false}>
        <EuiButtonEmpty
          size="s"
          iconType="cross"
          onClick={() => onChange(EMPTY_FILTERS)}
          isDisabled={!anyActive}
        >
          Clear filters
        </EuiButtonEmpty>
      </EuiFlexItem>

      <EuiFlexItem grow={false} style={{ marginLeft: 'auto' }}>
        <EuiText size="xs" color="subdued">
          <span>
            Showing <strong>{shown}</strong> of {loadedCount}
          </span>
        </EuiText>
      </EuiFlexItem>
    </EuiFlexGroup>
  );
};

/* ----------------------------------------------------------------- card ---- */

const ScanCard: React.FC<{
  c: Case;
  cache: React.MutableRefObject<Map<string, Case>>;
  isNew?: boolean;
  onOpen: () => void;
}> = ({ c, cache, isNew, onOpen }) => {
  const accent = verdictHex(c.verdict) || riskHex(c.risk_score);
  const entity = c.entity ? `${c.entity.type}: ${c.entity.value}` : DASH;
  const rules = Array.isArray(c.rule_ids) ? c.rule_ids.filter(Boolean) : [];
  const persona = (c.agent_persona || '').trim();
  const hasSource = caseSourceKey(c) !== UNKNOWN_SOURCE;
  const sourceLabel = caseSourceLabel(c);

  const cardBody = (
    <Card clickable onClick={onOpen} accentLeft={accent} paddingSize="m">
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
              <span className="socMono">{entity}</span>
            </EuiText>
          </EuiFlexItem>
          {isNew ? (
            <EuiFlexItem grow={false} style={{ marginLeft: 'auto' }}>
              <EuiBadge color="accent">New</EuiBadge>
            </EuiFlexItem>
          ) : null}
          <EuiFlexItem grow={false} style={isNew ? undefined : { marginLeft: 'auto' }}>
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
          {typeof c.confidence === 'number' ? (
            <EuiFlexItem grow={false}>
              <ConfidenceBadge confidence={c.confidence} />
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>

        {persona || hasSource ? (
          <>
            <EuiSpacer size="s" />
            <EuiFlexGroup gutterSize="xs" wrap responsive={false} alignItems="center">
              {persona ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color="hollow" iconType="userAvatar">
                    {humanizeToken(persona)}
                  </EuiBadge>
                </EuiFlexItem>
              ) : null}
              {hasSource ? (
                <EuiFlexItem grow={false}>
                  <EuiBadge color="hollow" iconType="index">
                    {sourceLabel}
                  </EuiBadge>
                </EuiFlexItem>
              ) : null}
            </EuiFlexGroup>
          </>
        ) : null}

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
