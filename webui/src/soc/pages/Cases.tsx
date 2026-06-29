/**
 * Cases — the analyst triage surface (new command-center UI).
 *
 * Lists recent cases (GET /api/cases, single capped fetch) in a dense DataTable
 * with a filter bar (search + Status/Severity/Assignee selects), client-side
 * sort, pagination, row-selection with a bulk-action bar, and an honest "N of M"
 * count. Clicking a row opens the shared CaseDetail sheet (held via openCaseId).
 *
 * All narrowing is CLIENT-SIDE over the loaded list. Filter state SELF-HEALS: any
 * selected facet value that no longer exists after a reload is dropped so the list
 * can never silently empty behind an un-clearable filter.
 *
 * SECURITY: every case-derived value (title, entity, IPs, rules, tags, assignee,
 * source, model keys) is UNTRUSTED — rendered as plain text or via <InlineCode>,
 * never as markup.
 */
import * as React from 'react';
import {
  Briefcase,
  RefreshCw,
  SortAsc,
  Search,
  X,
  Trash2,
  Check,
  UserPlus,
  Layers,
  Clock,
  Sparkles,
  AlertTriangle,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { Case, CaseActionInput } from '@/lib/types';
import { humanizeAge, humanizeToken, DASH } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/ui/popover';

import { PageHeader } from '@/soc/components/PageHeader';
import { KpiTile } from '@/soc/components/KpiTile';
import { DataTable, type DataTableColumn, type SortState } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { InlineCode } from '@/soc/components/CodeBlock';
import { CaseHoverCard } from '@/soc/components/CaseHoverCard';
import {
  StatusBadge,
  VerdictBadge,
  DispositionBadge,
  RiskBadge,
  SeverityBadge,
  ConfidenceBadge,
  CategoryBadge,
  UrgencyPill,
} from '@/soc/components/badges';

import type { Navigate } from '@/soc/router';
import { useRoute } from '@/soc/router';
import { CaseDetail } from '@/soc/pages/CaseDetail';

/* --------------------------------------------------------------- helpers --- */

const LIST_LIMIT = 200;

/** Sentinel for "any" in the single-select filters (Radix Select forbids ""). */
const ANY = '__any__';
/** Sentinel facet value for cases with no originating source recorded. */
const UNASSIGNED = '__unassigned__';

type TimeRange = 'all' | '24h' | '7d' | '30d';

/** All rule ids/names on a case (handles rule_ids[] and a scalar `rule`). */
function caseRules(c: Case): string[] {
  const out: string[] = [];
  if (Array.isArray(c.rule_ids)) out.push(...c.rule_ids.filter(Boolean).map(String));
  const scalar = (c as Record<string, unknown>).rule;
  if (typeof scalar === 'string' && scalar.trim()) out.push(scalar.trim());
  return out;
}

/** Count of related alerts/events on a case (best-effort over loose fields). */
function alertCount(c: Case): number {
  if (Array.isArray(c.member_event_ids)) return c.member_event_ids.length;
  if (Array.isArray(c.evidence)) {
    return c.evidence.reduce(
      (n, e) => n + (Array.isArray(e.event_ids) ? e.event_ids.length : 0),
      0,
    );
  }
  return 0;
}

/** Count of playbooks attached to a case (0 or 1 in the current model). */
function playbookCount(c: Case): number {
  return c.playbook_id ? 1 : 0;
}

/** Count of enrichment artefacts surfaced on a case (evidence entries proxy). */
function enrichmentCount(c: Case): number {
  return Array.isArray(c.evidence) ? c.evidence.length : 0;
}

/** Category label for a case (entity_type → first rule → undefined). */
function caseCategory(c: Case): string | undefined {
  const et = (c.entity_type || c.entity?.type || '').trim();
  if (et) return et;
  return undefined;
}

/** AI-derived severity proxy: the normalised risk score (0..100). */
function aiSeverity(c: Case): number | null {
  return typeof c.risk_score === 'number' ? c.risk_score : null;
}

/** Severity proxy from the source: highest event/rule severity, else risk band. */
function caseSeverity(c: Case): number | string | null {
  const sev = (c as Record<string, unknown>).severity;
  if (typeof sev === 'number' || typeof sev === 'string') return sev;
  return typeof c.risk_score === 'number' ? c.risk_score : null;
}

const TIME_RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

/* ----------------------------------------------------------------- filters - */

interface CaseFilters {
  search: string;
  status: string; // ANY | a status value
  disposition: string; // ANY | a disposition value
  severity: string; // ANY | 'critical'|'high'|'medium'|'low'|'info'
  assignee: string; // ANY | UNASSIGNED | a name
  timeRange: TimeRange;
}

const EMPTY_FILTERS: CaseFilters = {
  search: '',
  status: ANY,
  disposition: ANY,
  severity: ANY,
  assignee: ANY,
  timeRange: 'all',
};

interface Facets {
  statuses: string[];
  dispositions: string[];
  assignees: string[];
}

const sortedUniq = (vals: Iterable<string>): string[] =>
  Array.from(new Set(vals)).sort((a, b) => a.localeCompare(b));

function buildFacets(cases: Case[]): Facets {
  const statuses = new Set<string>();
  const dispositions = new Set<string>();
  const assignees = new Set<string>();
  for (const c of cases) {
    if (c.status) statuses.add(c.status);
    if (typeof c.disposition === 'string' && c.disposition) dispositions.add(c.disposition);
    const a = (c.assignee || '').trim();
    if (a) assignees.add(a);
  }
  return {
    statuses: sortedUniq(statuses),
    dispositions: sortedUniq(dispositions),
    assignees: sortedUniq(assignees),
  };
}

/** Drop a single-select facet value no longer present (self-healing). */
function healFilters(f: CaseFilters, facets: Facets): CaseFilters {
  let next = f;
  if (f.status !== ANY && !facets.statuses.includes(f.status)) {
    next = { ...next, status: ANY };
  }
  if (f.disposition !== ANY && !facets.dispositions.includes(f.disposition)) {
    next = { ...next, disposition: ANY };
  }
  if (
    f.assignee !== ANY &&
    f.assignee !== UNASSIGNED &&
    !facets.assignees.includes(f.assignee)
  ) {
    next = { ...next, assignee: ANY };
  }
  return next;
}

/** Map a numeric/string severity onto a coarse band for filtering. */
function severityBandKey(severity: number | string | null): string | null {
  if (severity === null) return null;
  let n: number;
  if (typeof severity === 'string') {
    const t = severity.trim().toLowerCase();
    if (['critical', 'high', 'medium', 'low', 'info'].includes(t)) return t;
    const asNum = Number(t);
    if (Number.isNaN(asNum)) return null;
    n = asNum;
  } else {
    n = severity;
  }
  const scaled = n <= 5 ? (n / 5) * 100 : n <= 15 ? (n / 15) * 100 : n;
  if (scaled >= 80) return 'critical';
  if (scaled >= 60) return 'high';
  if (scaled >= 35) return 'medium';
  if (scaled >= 15) return 'low';
  return 'info';
}

function applyFilters(cases: Case[], f: CaseFilters): Case[] {
  const q = f.search.trim().toLowerCase();
  const now = Date.now();
  const horizon = f.timeRange === 'all' ? 0 : now - TIME_RANGE_MS[f.timeRange];

  return cases.filter((c) => {
    if (f.status !== ANY && (c.status || '') !== f.status) return false;
    if (f.disposition !== ANY && (c.disposition || '') !== f.disposition) return false;

    if (f.severity !== ANY) {
      if (severityBandKey(caseSeverity(c)) !== f.severity) return false;
    }

    if (f.assignee !== ANY) {
      const assignee = (c.assignee || '').trim();
      if (f.assignee === UNASSIGNED) {
        if (assignee) return false;
      } else if (assignee !== f.assignee) {
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
        c.summary,
        c.entity?.value,
        c.entity?.type,
        ...caseRules(c),
        ...(Array.isArray(c.tags) ? c.tags : []),
        c.assignee,
        c.source_name,
        c.cluster_signature,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function countActiveFilters(f: CaseFilters): number {
  return (
    (f.search.trim() ? 1 : 0) +
    (f.status !== ANY ? 1 : 0) +
    (f.disposition !== ANY ? 1 : 0) +
    (f.severity !== ANY ? 1 : 0) +
    (f.assignee !== ANY ? 1 : 0) +
    (f.timeRange !== 'all' ? 1 : 0)
  );
}

/* ------------------------------------------------------------------- sort -- */

type SortId =
  | 'case_id'
  | 'title'
  | 'status'
  | 'disposition'
  | 'category'
  | 'severity'
  | 'severity_ai'
  | 'confidence'
  | 'updated_at';

const sortComparators: Record<SortId, (a: Case, b: Case) => number> = {
  case_id: (a, b) =>
    (a.case_number || a.case_id).localeCompare(b.case_number || b.case_id),
  title: (a, b) => (a.title || a.case_id).localeCompare(b.title || b.case_id),
  status: (a, b) => (a.status || '').localeCompare(b.status || ''),
  disposition: (a, b) =>
    (a.disposition || '￿').localeCompare(b.disposition || '￿'),
  category: (a, b) => (caseCategory(a) || '￿').localeCompare(caseCategory(b) || '￿'),
  severity: (a, b) => {
    const order = ['info', 'low', 'medium', 'high', 'critical'];
    return (
      order.indexOf(severityBandKey(caseSeverity(a)) || 'info') -
      order.indexOf(severityBandKey(caseSeverity(b)) || 'info')
    );
  },
  severity_ai: (a, b) => (aiSeverity(a) ?? -1) - (aiSeverity(b) ?? -1),
  confidence: (a, b) => (a.confidence ?? -1) - (b.confidence ?? -1),
  updated_at: (a, b) =>
    (a.updated_at || a.created_at || '').localeCompare(b.updated_at || b.created_at || ''),
};

/* -------------------------------------------------------------------- page - */

export interface CasesProps {
  onNavigate?: Navigate;
  /** Seed the status filter on mount (e.g. from a drill-through). */
  initialStatus?: string;
}

const CountLink: React.FC<{ count: number; onClick?: () => void }> = ({ count, onClick }) => {
  const enabled = count > 0 && !!onClick;
  return (
    <button
      type="button"
      disabled={!enabled}
      onClick={
        enabled
          ? (e) => {
              e.stopPropagation();
              onClick?.();
            }
          : undefined
      }
      className={cn(
        'inline-flex items-center gap-1 rounded-sm text-sm transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        enabled
          ? 'text-primary hover:underline'
          : 'cursor-default text-muted-foreground',
      )}
    >
      View ({count})
    </button>
  );
};

export default function Cases({ onNavigate, initialStatus: initialStatusProp }: CasesProps) {
  const route = useRoute();
  const navigate = onNavigate ?? route.navigate;
  const initialStatus = initialStatusProp ?? route.opts?.status;

  const [cases, setCases] = React.useState<Case[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const [filters, setFilters] = React.useState<CaseFilters>(() =>
    initialStatus ? { ...EMPTY_FILTERS, status: initialStatus } : EMPTY_FILTERS,
  );
  const [sort, setSort] = React.useState<SortState>({ id: 'updated_at', dir: 'desc' });
  const [pageSize, setPageSize] = React.useState(50);
  const [page, setPage] = React.useState(1);

  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);

  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkError, setBulkError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listCases({ limit: LIST_LIMIT });
      setCases(res.cases);
      setTotal(res.total);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A drill-through can change `initialStatus` while mounted; reseed the filter.
  React.useEffect(() => {
    if (initialStatus) setFilters((f) => ({ ...f, status: initialStatus }));
  }, [initialStatus]);

  const facets = React.useMemo(() => buildFacets(cases), [cases]);

  // Self-heal selected facet values when the loaded rows change.
  React.useEffect(() => {
    setFilters((f) => healFilters(f, facets));
  }, [facets]);

  const filtered = React.useMemo(() => applyFilters(cases, filters), [cases, filters]);

  const filteredSorted = React.useMemo(() => {
    const dir = sort.dir === 'asc' ? 1 : -1;
    const cmp = sortComparators[sort.id as SortId] ?? sortComparators.updated_at;
    return [...filtered].sort((a, b) => cmp(a, b) * dir);
  }, [filtered, sort]);

  // Reset to page 1 whenever the filtered set or page size changes.
  React.useEffect(() => {
    setPage(1);
  }, [filters, pageSize]);

  const pageCount = Math.max(1, Math.ceil(filteredSorted.length / pageSize));
  React.useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const pageRows = React.useMemo(() => {
    const start = (page - 1) * pageSize;
    return filteredSorted.slice(start, start + pageSize);
  }, [filteredSorted, page, pageSize]);

  // KPI counts over the IN-VIEW (filtered) list so they match what's shown.
  const counts = React.useMemo(() => {
    let open = 0;
    let needsHuman = 0;
    let truePositive = 0;
    for (const c of filteredSorted) {
      if (c.status === 'open') open += 1;
      if (c.status === 'needs_human') needsHuman += 1;
      if ((c.verdict || '').toUpperCase().includes('TRUE')) truePositive += 1;
    }
    return { open, needsHuman, truePositive };
  }, [filteredSorted]);

  const truncated = total > cases.length;

  // Drop any selection no longer visible so the bulk bar can't act on hidden rows.
  React.useEffect(() => {
    setSelected((sel) => {
      if (!sel.length) return sel;
      const visible = new Set(filteredSorted.map((c) => c.case_id));
      const next = sel.filter((id) => visible.has(id));
      return next.length === sel.length ? sel : next;
    });
  }, [filteredSorted]);

  const selectedCases = React.useMemo(() => {
    const set = new Set(selected);
    return filteredSorted.filter((c) => set.has(c.case_id));
  }, [selected, filteredSorted]);

  const runBulk = React.useCallback(
    async (input: CaseActionInput) => {
      if (!selectedCases.length || bulkBusy) return;
      setBulkBusy(true);
      setBulkError(null);
      const targets = selectedCases.slice();
      let failures = 0;
      for (const c of targets) {
        try {
          await api.caseActionExec(c.case_id, input);
        } catch {
          failures += 1;
        }
      }
      if (failures) {
        setBulkError(
          `${failures} of ${targets.length} case${targets.length === 1 ? '' : 's'} could not be updated.`,
        );
      }
      setSelected([]);
      await load();
      setBulkBusy(false);
    },
    [selectedCases, bulkBusy, load],
  );

  const setFilter = <K extends keyof CaseFilters>(key: K, value: CaseFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const anyActive = countActiveFilters(filters) > 0;

  /* ----------------------------------------------------------- columns ---- */
  const columns: DataTableColumn<Case>[] = [
    {
      id: 'case_id',
      header: 'Case ID',
      sortable: true,
      width: '9.5rem',
      cell: (c) => (
        <CaseHoverCard case={c}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpenCaseId(c.case_id);
            }}
            className="rounded-sm font-mono text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {c.case_number || c.case_id}
          </button>
        </CaseHoverCard>
      ),
    },
    {
      id: 'title',
      header: 'Title',
      sortable: true,
      cell: (c) => (
        <CaseHoverCard case={c}>
          <span className="block max-w-[26rem] cursor-pointer truncate font-medium text-foreground">
            {c.title || c.case_id}
          </span>
        </CaseHoverCard>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      sortable: true,
      width: '9rem',
      cell: (c) => <StatusBadge status={c.status} />,
    },
    {
      id: 'disposition',
      header: 'Disposition',
      sortable: true,
      width: '8rem',
      cell: (c) => <DispositionBadge disposition={c.disposition ?? null} />,
    },
    {
      id: 'alerts',
      header: 'Alerts',
      align: 'left',
      width: '6.5rem',
      cell: (c) => (
        <CountLink
          count={alertCount(c)}
          onClick={alertCount(c) > 0 ? () => setOpenCaseId(c.case_id) : undefined}
        />
      ),
    },
    {
      id: 'playbooks',
      header: 'Playbooks',
      align: 'left',
      width: '6.5rem',
      cell: (c) => (
        <CountLink
          count={playbookCount(c)}
          onClick={playbookCount(c) > 0 ? () => setOpenCaseId(c.case_id) : undefined}
        />
      ),
    },
    {
      id: 'enrichments',
      header: 'Enrichments',
      align: 'left',
      width: '7rem',
      cell: (c) => (
        <CountLink
          count={enrichmentCount(c)}
          onClick={enrichmentCount(c) > 0 ? () => setOpenCaseId(c.case_id) : undefined}
        />
      ),
    },
    {
      id: 'category',
      header: 'Category',
      sortable: true,
      width: '7rem',
      cell: (c) => <CategoryBadge category={caseCategory(c)} />,
    },
    {
      id: 'severity',
      header: 'Severity',
      sortable: true,
      width: '7rem',
      cell: (c) => <SeverityBadge severity={caseSeverity(c)} />,
    },
    {
      id: 'severity_ai',
      header: 'Severity (AI)',
      sortable: true,
      width: '7.5rem',
      cell: (c) => {
        const s = aiSeverity(c);
        return s === null ? (
          <span className="text-muted-foreground">{DASH}</span>
        ) : (
          <SeverityBadge severity={s} />
        );
      },
    },
    {
      id: 'confidence',
      header: 'Confidence',
      sortable: true,
      width: '7rem',
      cell: (c) => <ConfidenceBadge confidence={c.confidence} />,
    },
    {
      id: 'verdict',
      header: 'Verdict',
      width: '8rem',
      cell: (c) => <VerdictBadge verdict={c.verdict} />,
    },
    {
      id: 'risk',
      header: 'Risk',
      width: '6rem',
      cell: (c) => <RiskBadge score={c.risk_score} />,
    },
    {
      id: 'urgency',
      header: 'Urgency',
      width: '6rem',
      cell: (c) => (
        <UrgencyPill createdAt={c.created_at} riskScore={c.risk_score} status={c.status} />
      ),
    },
    {
      id: 'entity',
      header: 'Entity',
      width: '11rem',
      cell: (c) =>
        c.entity ? (
          <span className="text-sm text-foreground">
            <span className="text-muted-foreground">{c.entity.type}:</span>{' '}
            <InlineCode>{c.entity.value}</InlineCode>
          </span>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'updated_at',
      header: 'Updated',
      sortable: true,
      width: '7rem',
      cell: (c) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {humanizeAge(c.updated_at || c.created_at)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      align: 'right',
      width: '5rem',
      cell: (c) => (
        <Button
          variant="ghost"
          size="icon"
          className="size-8 text-critical hover:text-critical"
          aria-label={`Close case ${c.case_id}`}
          onClick={(e) => {
            e.stopPropagation();
            void api
              .caseActionExec(c.case_id, { action: 'close', resolution: 'Closed by analyst' })
              .then(() => load())
              .catch(() => setBulkError(`Could not close ${c.case_id}.`));
          }}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      ),
    },
  ];

  /* ------------------------------------------------------------- render ---- */
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Triage"
        title="Cases"
        description="Audited, human-reviewable triage cases."
        icon={Briefcase}
        actions={
          <>
            <Button
              variant={
                sort.id === 'updated_at' && sort.dir === 'asc' ? 'default' : 'outline'
              }
              size="sm"
              onClick={() => setSort({ id: 'updated_at', dir: 'asc' })}
            >
              <SortAsc className="mr-1.5 size-4" aria-hidden />
              Oldest first
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn('mr-1.5 size-4', loading && 'animate-spin')} aria-hidden />
              Refresh
            </Button>
          </>
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiTile
          label="Total cases"
          value={total.toLocaleString()}
          icon={Briefcase}
          accent="primary"
          sub={truncated ? `${cases.length.toLocaleString()} loaded` : undefined}
        />
        <KpiTile
          label="Open (in view)"
          value={counts.open}
          icon={Layers}
          accent="info"
          onClick={() => setFilter('status', 'open')}
        />
        <KpiTile
          label="Needs human (in view)"
          value={counts.needsHuman}
          icon={AlertTriangle}
          accent="high"
          onClick={() => setFilter('status', 'needs_human')}
        />
        <KpiTile
          label="True positives (in view)"
          value={counts.truePositive}
          icon={Sparkles}
          accent="critical"
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)}
            placeholder="Search Case ID, title, summary, entity, rule, tags…"
            aria-label="Search cases"
            className="pl-9"
          />
        </div>

        <Select value={filters.status} onValueChange={(v) => setFilter('status', v)}>
          <SelectTrigger className="w-[11rem]" aria-label="Filter by status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All statuses</SelectItem>
            {facets.statuses.map((s) => (
              <SelectItem key={s} value={s}>
                {s === 'needs_human' ? 'Open · awaiting analyst' : humanizeToken(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {facets.dispositions.length ? (
          <Select
            value={filters.disposition}
            onValueChange={(v) => setFilter('disposition', v)}
          >
            <SelectTrigger className="w-[11rem]" aria-label="Filter by disposition">
              <SelectValue placeholder="Disposition" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All dispositions</SelectItem>
              {facets.dispositions.map((d) => (
                <SelectItem key={d} value={d}>
                  {humanizeToken(d)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Select value={filters.severity} onValueChange={(v) => setFilter('severity', v)}>
          <SelectTrigger className="w-[10rem]" aria-label="Filter by severity">
            <SelectValue placeholder="Severity" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All severities</SelectItem>
            <SelectItem value="critical">Critical</SelectItem>
            <SelectItem value="high">High</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="info">Info</SelectItem>
          </SelectContent>
        </Select>

        <Select value={filters.assignee} onValueChange={(v) => setFilter('assignee', v)}>
          <SelectTrigger className="w-[11rem]" aria-label="Filter by assignee">
            <SelectValue placeholder="Assignee" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All assignees</SelectItem>
            <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
            {facets.assignees.map((a) => (
              <SelectItem key={a} value={a}>
                {a}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Clock className="mr-1.5 size-4" aria-hidden />
              {filters.timeRange === 'all'
                ? 'Any time'
                : `Last ${filters.timeRange}`}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56" align="start">
            <div className="space-y-1">
              <p className="px-1 pb-1 text-xs font-medium text-muted-foreground">
                Created within
              </p>
              {(
                [
                  ['all', 'Any time'],
                  ['24h', 'Last 24 hours'],
                  ['7d', 'Last 7 days'],
                  ['30d', 'Last 30 days'],
                ] as Array<[TimeRange, string]>
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setFilter('timeRange', val)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm transition-colors',
                    'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    filters.timeRange === val
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground',
                  )}
                >
                  {label}
                  {filters.timeRange === val ? <Check className="size-4" aria-hidden /> : null}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFilters(EMPTY_FILTERS)}
          disabled={!anyActive}
        >
          <X className="mr-1.5 size-4" aria-hidden />
          Clear
        </Button>

        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
          Showing <strong className="text-foreground">{filteredSorted.length}</strong> of{' '}
          {cases.length}
          {total > cases.length ? ` (of ${total} total)` : ''}
        </span>
      </div>

      {/* Truncation note */}
      {truncated ? (
        <Alert>
          <AlertTitle>
            Showing the first {cases.length.toLocaleString()} of {total.toLocaleString()} cases
          </AlertTitle>
          <AlertDescription>
            Only the most recent {cases.length.toLocaleString()} cases are loaded for fast
            client-side filtering. Narrow the time range or use search to find older cases.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Bulk error */}
      {bulkError ? (
        <Alert variant="warning">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>Some actions failed</AlertTitle>
          <AlertDescription>{bulkError}</AlertDescription>
        </Alert>
      ) : null}

      {/* Load error */}
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" aria-hidden />
          <AlertTitle>Could not load cases</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'An unexpected error occurred.'}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Table */}
      <DataTable<Case>
        ariaLabel="Cases"
        columns={columns}
        rows={pageRows}
        getRowId={(c) => c.case_id}
        sort={sort}
        onSortChange={setSort}
        page={page}
        pageSize={pageSize}
        total={filteredSorted.length}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[25, 50, 100]}
        selectable
        selected={selected}
        onSelectedChange={setSelected}
        onRowClick={(c) => setOpenCaseId(c.case_id)}
        loading={loading}
        loadingRows={8}
        density="compact"
        empty={
          <EmptyState
            compact
            icon={Briefcase}
            title={cases.length === 0 ? 'No cases yet' : 'No cases match your filters'}
            description={
              cases.length === 0
                ? 'Run an investigation or enable background scans to start triaging.'
                : 'No loaded cases match the current filters. Clear them to see all cases.'
            }
            action={
              cases.length > 0 ? (
                <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                  <X className="mr-1.5 size-4" aria-hidden />
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        }
      />

      {/* Bulk action bar */}
      <BulkActionBar
        count={selectedCases.length}
        busy={bulkBusy}
        onAcknowledge={() => void runBulk({ action: 'acknowledge' })}
        onClose={() => void runBulk({ action: 'close', resolution: 'Bulk-closed by analyst' })}
        onAssign={(assignee) => void runBulk({ action: 'escalate', assignee })}
        onClear={() => setSelected([])}
      />

      {/* Case detail sheet */}
      <CaseDetail
        caseId={openCaseId}
        onClose={() => {
          setOpenCaseId(null);
          void load();
        }}
        onNavigate={navigate}
      />
    </div>
  );
}

/* ------------------------------------------------------------- bulk bar ---- */

const BulkActionBar: React.FC<{
  count: number;
  busy: boolean;
  onAcknowledge: () => void;
  onClose: () => void;
  onAssign: (assignee: string) => void;
  onClear: () => void;
}> = ({ count, busy, onAcknowledge, onClose, onAssign, onClear }) => {
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [assignee, setAssignee] = React.useState('');

  React.useEffect(() => {
    if (count === 0) {
      setAssignOpen(false);
      setAssignee('');
    }
  }, [count]);

  if (count === 0) return null;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="fixed bottom-5 left-1/2 z-50 max-w-[94vw] -translate-x-1/2 animate-rise-in"
    >
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2.5 shadow-elev2">
        <span className="inline-flex items-center rounded-md bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
          {count} selected
        </span>
        <Button size="sm" variant="secondary" onClick={onAcknowledge} disabled={busy}>
          <Check className="mr-1.5 size-4" aria-hidden />
          Acknowledge
        </Button>
        <Button size="sm" variant="destructive" onClick={onClose} disabled={busy}>
          <X className="mr-1.5 size-4" aria-hidden />
          Close
        </Button>
        <Popover open={assignOpen} onOpenChange={setAssignOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" disabled={busy}>
              <UserPlus className="mr-1.5 size-4" aria-hidden />
              Assign
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-60" side="top">
            <div className="space-y-2">
              <label
                htmlFor="bulk-assignee"
                className="block text-xs font-medium text-muted-foreground"
              >
                Escalate to
              </label>
              <Input
                id="bulk-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                placeholder="Analyst or team"
                aria-label="Assignee for bulk escalation"
              />
              <Button
                size="sm"
                className="w-full"
                disabled={!assignee.trim() || busy}
                onClick={() => {
                  onAssign(assignee.trim());
                  setAssignOpen(false);
                }}
              >
                Escalate {count}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
          Clear
        </Button>
      </div>
    </div>
  );
};
