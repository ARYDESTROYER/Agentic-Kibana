/**
 * Cases / dashboard — the default landing surface and the entry point to the
 * core analyst workflow. Lists recent cases (GET /api/cases) with headline
 * counts, a full client-side filter bar (free-text + verdict/status/risk/rule/
 * persona/playbook/assignee/tags/time multi-selects), sortable columns (incl.
 * the collaboration columns assignee/tags/comments), and a "showing N of M"
 * count. Clicking any row opens the CaseDetailFlyout where the analyst reviews
 * evidence, the agent trace, the timeline, and takes a lifecycle action.
 * Hovering a case title surfaces a rich CaseHoverCard preview (zero-network from
 * the loaded row).
 *
 * All filtering is CLIENT-SIDE over the loaded list (a single useMemo) and the
 * filter state SELF-HEALS: any selected value that no longer exists after a
 * reload is dropped (see `healFilters`) so the list can never silently empty
 * behind an un-clearable filter. The filter bar + filter logic are intentionally
 * inlined here (and mirrored in ScansPage) rather than shared in a third module.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiBasicTable,
  EuiButton,
  EuiButtonEmpty,
  EuiComboBox,
  EuiDualRange,
  EuiFieldSearch,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiPopover,
  EuiSelect,
  EuiSpacer,
  EuiText,
  EuiToolTip,
} from '@elastic/eui';
import type {
  Criteria,
  EuiBasicTableColumn,
  EuiComboBoxOptionOption,
} from '@elastic/eui';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, riskHex, verdictHex } from '../../lib/theme';
import { humanizeAge, humanizeToken } from '../../lib/format';
import {
  EmptyState,
  ErrorCallout,
  RiskBadge,
  SectionHeader,
  Skeleton,
  StatTile,
  StatusBadge,
  VerdictBadge,
} from '../common/ui';
import { CaseDetailFlyout } from './CaseDetailFlyout';
import { CaseHoverCard } from './CaseHoverCard';

type SortField = 'title' | 'risk_score' | 'updated_at' | 'status' | 'verdict' | 'assignee';

type TimeRange = 'all' | '24h' | '7d' | '30d';

/* ------------------------------------------------------- filter primitives -- */
/* The filter MODEL + pure helpers below are kept inline (mirrored in ScansPage)
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
  for (const c of cases) {
    if (c.verdict) verdicts.add(c.verdict);
    if (c.status) statuses.add(c.status);
    for (const r of caseRules(c)) rules.add(r);
    if (c.agent_persona) personas.add(c.agent_persona);
    if (c.playbook_id) playbooks.add(c.playbook_id);
    const a = (c.assignee || '').trim();
    if (a) assignees.add(a);
    if (Array.isArray(c.tags)) for (const t of c.tags) if (t) tags.add(t);
  }
  return {
    verdicts: sortedUniq(verdicts),
    statuses: sortedUniq(statuses),
    rules: sortedUniq(rules),
    personas: sortedUniq(personas),
    playbooks: sortedUniq(playbooks),
    assignees: sortedUniq(assignees),
    tags: sortedUniq(tags),
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
  };
  // Return the same reference when nothing changed so the effect is a no-op.
  const same =
    next.verdicts === f.verdicts &&
    next.statuses === f.statuses &&
    next.rules === f.rules &&
    next.personas === f.personas &&
    next.playbooks === f.playbooks &&
    next.assignees === f.assignees &&
    next.tags === f.tags;
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

  return cases.filter((c) => {
    if (vSet.size && !vSet.has(c.verdict || '')) return false;
    if (sSet.size && !sSet.has(c.status || '')) return false;
    if (ruleSet.size && !caseRules(c).some((r) => ruleSet.has(r))) return false;
    if (pSet.size && !pSet.has(c.agent_persona || '')) return false;
    if (pbSet.size && !pbSet.has(c.playbook_id || '')) return false;

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
      // Unscored cases only survive when the band spans the full range.
      if (score === null) {
        if (f.riskMin > 0 || f.riskMax < 100) return false;
      } else if (score < f.riskMin || score > f.riskMax) {
        return false;
      }
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
    (f.unassigned ? 1 : 0) +
    (f.riskMin > 0 || f.riskMax < 100 ? 1 : 0) +
    (f.timeRange !== 'all' ? 1 : 0)
  );
}

/* ----------------------------------------------------------------- page ----- */

export const CasesPage: React.FC = () => {
  const [cases, setCases] = useState<Case[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [filters, setFilters] = useState<CaseFilters>(EMPTY_FILTERS);
  const [sortField, setSortField] = useState<SortField>('updated_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);

  /** Page-level cache shared by every CaseHoverCard so hovers never re-fetch. */
  const caseCache = useRef<Map<string, Case>>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The full list is fetched once; all narrowing happens client-side so the
      // filter bar stays instant and there is one source of truth for facets.
      const res = await api.listCases({ limit: 200 });
      setCases(res.cases);
      setTotal(res.total);
      for (const c of res.cases) {
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

  const facets = useMemo(() => buildFacets(cases), [cases]);

  // Self-heal: when the loaded rows change (e.g. after a reload) drop any
  // selected facet value that no longer exists so the list can't silently empty.
  useEffect(() => {
    setFilters((f) => healFilters(f, facets));
  }, [facets]);

  const filteredSorted = useMemo(() => {
    const rows = applyFilters(cases, filters);
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
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
  }, [cases, filters, sortField, sortDir]);

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
    <div className="socPageEnter">
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

      <CaseFilterBar
        loadedCount={cases.length}
        filters={filters}
        onChange={setFilters}
        facets={facets}
        shown={filteredSorted.length}
      />

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
      ) : filteredSorted.length === 0 ? (
        <EmptyState
          iconType="securityApp"
          title={cases.length === 0 ? 'No cases yet' : 'No cases match your filters'}
          body={
            cases.length === 0
              ? 'Run an investigation or enable background scans to start triaging.'
              : 'No loaded cases match the current filters. Clear them to see all cases.'
          }
          actions={
            cases.length > 0 ? (
              <EuiButton size="s" iconType="cross" onClick={() => setFilters(EMPTY_FILTERS)}>
                Clear filters
              </EuiButton>
            ) : undefined
          }
        />
      ) : (
        <EuiBasicTable
          items={filteredSorted}
          columns={columns}
          rowHeader="title"
          sorting={{ sort: { field: sortField, direction: sortDir } }}
          onChange={onTableChange}
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

/* ------------------------------------------------------------ filter bar ---- */

/** Map distinct facet values → humanized combo-box options (value carries the raw). */
const toOpts = (vals: string[]): Array<EuiComboBoxOptionOption<string>> =>
  vals.map((v) => ({ label: humanizeToken(v), value: v }));
const fromOpts = (sel: Array<EuiComboBoxOptionOption<string>>): string[] =>
  sel.map((o) => (o.value ?? o.label) as string);

/**
 * The shared client-side filter toolbar. Primary controls (search, verdict,
 * status) sit inline; the long-tail facets (risk band, time, rule, persona,
 * playbook, assignee, tags) live behind a "More filters" popover so the bar
 * stays uncluttered. Mirrored in idiom by the ScansPage bar.
 */
const CaseFilterBar: React.FC<{
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
    (filters.unassigned ? 1 : 0) +
    (filters.riskMin > 0 || filters.riskMax < 100 ? 1 : 0) +
    (filters.timeRange !== 'all' ? 1 : 0);

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
          aria-label="Search cases"
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
