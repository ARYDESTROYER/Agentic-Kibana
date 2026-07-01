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
  Clock,
  AlertTriangle,
  Link2,
  Tag as TagIcon,
  SlidersHorizontal,
  CircleSlash,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/lib/api';
import type { Case, CaseActionInput, SavedView } from '@/lib/types';
import { Can } from '@/soc/components/Can';
import { humanizeAge, humanizeToken, DASH } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Card } from '@/ui/card';
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

import { PageContainer } from '@/soc/components/PageContainer';
import { PageHeader } from '@/soc/components/PageHeader';
import { ConfirmDialog } from '@/soc/components/ConfirmDialog';
import {
  DataTable,
  type DataTableColumn,
  type SortState,
  type SortDir,
  type ColumnState,
} from '@/soc/components/DataTable';
import { ColumnsMenu, type ColumnMenuItem } from '@/soc/components/ColumnsMenu';
import { SavedViewsBar } from '@/soc/components/SavedViewsBar';
import { usePrefs } from '@/soc/prefs';
import { EmptyState } from '@/soc/components/EmptyState';
import { InlineCode } from '@/soc/components/CodeBlock';
import { CaseHoverCard } from '@/soc/components/CaseHoverCard';
import { DemoBadge, isDemoCase } from '@/soc/components/DemoBadge';
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

/** Stable id for the Cases table's per-user column state (Wave 7). */
const CASES_TABLE_ID = 'cases';
/** The surface scope saved views on this page belong to. */
const CASES_VIEW_SCOPE = 'cases';

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
  /** Show only cases linked across sources (F6 — related_case_ids / cross-source group). */
  relatedOnly: boolean;
}

const EMPTY_FILTERS: CaseFilters = {
  search: '',
  status: ANY,
  disposition: ANY,
  severity: ANY,
  assignee: ANY,
  timeRange: 'all',
  relatedOnly: false,
};

/** Whether a case participates in a cross-source group (F6). */
function isCrossSourceLinked(c: Case): boolean {
  const ids = c.related_case_ids;
  return (Array.isArray(ids) && ids.length > 0) || !!c.cross_source_cluster_id;
}

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
    if (f.relatedOnly && !isCrossSourceLinked(c)) return false;

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
    (f.timeRange !== 'all' ? 1 : 0) +
    (f.relatedOnly ? 1 : 0)
  );
}

/* --------------------------------------------------- saved-view (de)serialize */

/** Serialize the current filters into a saved-view `filters` bag (Wave 7). */
function filtersToView(f: CaseFilters): Record<string, unknown> {
  return {
    search: f.search,
    status: f.status,
    disposition: f.disposition,
    severity: f.severity,
    assignee: f.assignee,
    timeRange: f.timeRange,
    relatedOnly: f.relatedOnly,
  };
}

/** Hydrate filters from a saved-view `filters` bag, tolerating missing/extra keys. */
function viewToFilters(raw: Record<string, unknown> | undefined): CaseFilters {
  const r = raw ?? {};
  const str = (v: unknown, fallback: string) =>
    typeof v === 'string' && v ? v : fallback;
  const tr = str(r.timeRange, 'all');
  return {
    search: typeof r.search === 'string' ? r.search : '',
    status: str(r.status, ANY),
    disposition: str(r.disposition, ANY),
    severity: str(r.severity, ANY),
    assignee: str(r.assignee, ANY),
    timeRange: (['all', '24h', '7d', '30d'].includes(tr) ? tr : 'all') as TimeRange,
    relatedOnly: r.relatedOnly === true,
  };
}

/** Serialize a SortState into a saved-view `sort` token (e.g. '-updated_at'). */
function sortToToken(s: SortState): string {
  return `${s.dir === 'desc' ? '-' : ''}${s.id}`;
}

/** Parse a saved-view `sort` token back into a SortState (defaults sensibly). */
function tokenToSort(token: string | undefined): SortState {
  const t = (token || '').trim();
  if (!t) return { id: 'updated_at', dir: 'desc' };
  const dir: SortDir = t.startsWith('-') ? 'desc' : 'asc';
  return { id: t.replace(/^-/, ''), dir };
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

/**
 * Inline header pill count (replaces the old 4-tile KPI band — G4 density). Shows a
 * label + tabular count; clickable ones deep-link/filter. `tone` tints only the
 * count. All text is plain (UNTRUSTED-safe, #9).
 */
const CountPill: React.FC<{
  label: string;
  count: number | string;
  tone?: 'default' | 'info' | 'high' | 'critical';
  onClick?: () => void;
  testId?: string;
}> = ({ label, count, tone = 'default', onClick, testId }) => {
  const toneCls =
    tone === 'info'
      ? 'text-info'
      : tone === 'high'
        ? 'text-high'
        : tone === 'critical'
          ? 'text-critical'
          : 'text-foreground';
  const body = (
    <>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-semibold tabular-nums', toneCls)}>{count}</span>
    </>
  );
  const base =
    'inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1';
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        data-testid={testId}
        className={cn(
          base,
          'transition-colors hover:border-primary/40 hover:bg-accent/40',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )}
      >
        {body}
      </button>
    );
  }
  return (
    <span data-testid={testId} className={base}>
      {body}
    </span>
  );
};

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

  // Pervasive customization (Wave 7): terminology labels + saved views + per-table
  // column state, all keyed to the caller (the 'default' bucket when auth is off).
  const { t, tableColumns, updateTableColumns } = usePrefs();
  const columnState = tableColumns(CASES_TABLE_ID) ?? {};
  const [activeViewId, setActiveViewId] = React.useState<string | null>(null);

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

  // Bug #8: the one-click row "Close" is a destructive lifecycle action — gate it
  // behind ConfirmDialog. The close still posts through the SAME analyst action
  // endpoint (server-side decide()), never a client-side status write (#3).
  const [closeTarget, setCloseTarget] = React.useState<Case | null>(null);

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

  // A drill-through (e.g. a "Related case" link in CaseDetail) can pass a caseId;
  // open that case's detail sheet. Additive — no-op when absent.
  const routeCaseId = route.opts?.caseId;
  React.useEffect(() => {
    if (routeCaseId) setOpenCaseId(routeCaseId);
  }, [routeCaseId]);

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

  // BULK case action — POST /api/cases/bulk applies the SAME human lifecycle action
  // as the single-case POST /api/cases/{id}/action to every selected case. #3-safe:
  // this is the analyst layer (never an LLM auto-close / decide()). RBAC is enforced
  // server-side (cases:close for close/resolve, cases:write otherwise); the client
  // <Can> gates only hide the affordances. The per-id result drives a summary toast
  // + the warning alert, and the selection clears after.
  const runBulk = React.useCallback(
    async (input: CaseActionInput) => {
      const ids = selectedCases.map((c) => c.case_id);
      if (!ids.length || bulkBusy) return;
      setBulkBusy(true);
      setBulkError(null);
      try {
        const res = await api.cases.bulk(ids, input);
        const results = res.results ?? [];
        const okCount = results.filter((r) => r.ok).length;
        const failures = results.filter((r) => !r.ok);
        if (failures.length) {
          // Surface the distinct reasons (capped) so the operator sees WHY.
          const reasons = Array.from(
            new Set(failures.map((f) => f.error || 'unknown error')),
          ).slice(0, 3);
          setBulkError(
            `${failures.length} of ${results.length} case${results.length === 1 ? '' : 's'} could not be updated: ${reasons.join('; ')}`,
          );
          toast.warning(`${okCount} updated, ${failures.length} failed`);
        } else {
          toast.success(
            `${okCount} case${okCount === 1 ? '' : 's'} updated`,
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Bulk action failed.';
        setBulkError(msg);
        toast.error(msg);
      } finally {
        setSelected([]);
        await load();
        setBulkBusy(false);
      }
    },
    [selectedCases, bulkBusy, load],
  );

  // Perform the confirmed row-close. Posts the SAME `close` analyst action as the
  // bulk bar / CaseDetail close dialog — the backend's decide() adjudicates (#3).
  const confirmClose = React.useCallback(async () => {
    const target = closeTarget;
    if (!target) return;
    try {
      await api.caseActionExec(target.case_id, {
        action: 'close',
        resolution: 'Closed by analyst',
      });
      await load();
    } catch {
      setBulkError(`Could not close ${target.case_id}.`);
    }
  }, [closeTarget, load]);

  const setFilter = <K extends keyof CaseFilters>(key: K, value: CaseFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const anyActive = countActiveFilters(filters) > 0;

  /* ------------------------------------------------- saved views (Wave 7) -- */
  // Apply a saved view's stored filter/sort onto the page (null → defaults).
  const applySavedView = React.useCallback(
    (view: SavedView | null) => {
      if (!view) {
        setFilters(EMPTY_FILTERS);
        setSort({ id: 'updated_at', dir: 'desc' });
        setActiveViewId(null);
        return;
      }
      setFilters(viewToFilters(view.filters));
      setSort(tokenToSort(view.sort));
      setActiveViewId(view.id);
    },
    [],
  );

  // Capture the page's CURRENT config for the "Save view" affordance.
  const captureCurrent = React.useCallback(
    () => ({ filters: filtersToView(filters), sort: sortToToken(sort), columns: null }),
    [filters, sort],
  );

  // Clear all filters AND any applied saved view (the "Clear" affordances).
  const clearAll = React.useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setActiveViewId(null);
  }, []);

  // Persist a new column state (the table re-applies it via `columnState`).
  const handleColumnState = React.useCallback(
    (next: ColumnState) => {
      void updateTableColumns(CASES_TABLE_ID, next);
    },
    [updateTableColumns],
  );

  /* ----------------------------------------------------------- columns ---- */
  const columns: DataTableColumn<Case>[] = [
    {
      id: 'case_id',
      header: 'Case ID',
      sortable: true,
      width: '9.5rem',
      lockVisible: true,
      cell: (c) => (
        <div className="flex items-center gap-1.5">
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
          <DemoBadge show={isDemoCase(c)} iconless className="px-1 py-0 text-2xs" />
        </div>
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
            // Bug #8: confirm before this destructive one-click close.
            setCloseTarget(c);
          }}
        >
          <Trash2 className="size-4" aria-hidden />
        </Button>
      ),
    },
  ];

  // Column-menu descriptors (plain-text labels; the actions column is hideable but
  // the locked case_id column always shows). Derived from the columns above so the
  // menu and the table never drift.
  const columnMenuItems: ColumnMenuItem[] = columns.map((c) => ({
    id: c.id,
    label: typeof c.header === 'string' ? c.header : c.id,
    lockVisible: c.lockVisible,
  }));

  /* ------------------------------------------------------------- render ---- */
  return (
    <PageContainer variant="wide" className="space-y-6">
      <PageHeader
        variant="dense"
        breadcrumb={[{ label: 'Triage' }, { label: t('cases', 'Cases') }]}
        title={t('cases', 'Cases')}
        icon={Briefcase}
        meta={
          // Inline pill counts replace the old 4-tile KPI band (G4 density). They
          // read against the IN-VIEW (filtered) list, matching what's shown.
          <div className="flex flex-wrap items-center gap-1.5">
            <CountPill
              label={`Total ${t('cases', 'Cases')}`}
              count={total.toLocaleString()}
              testId="cases-count-total"
            />
            <CountPill
              label="Open"
              count={counts.open}
              tone="info"
              onClick={() => setFilter('status', 'open')}
              testId="cases-count-open"
            />
            <CountPill
              label="Needs human"
              count={counts.needsHuman}
              tone="high"
              onClick={() => setFilter('status', 'needs_human')}
              testId="cases-count-needs-human"
            />
            <CountPill
              label="True positives"
              count={counts.truePositive}
              tone="critical"
              testId="cases-count-tp"
            />
          </div>
        }
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

      {/* Filter bar — saved views + column customization now live INLINE here
          (reclaims the former standalone ~150px row above the table). Border-first
          inline toolbar (no resting shadow) via the ONE card grammar. */}
      <Card elevation="none" className="flex flex-wrap items-center gap-2 p-3">
        <SavedViewsBar
          scope={CASES_VIEW_SCOPE}
          activeViewId={activeViewId}
          onApply={applySavedView}
          getCurrent={captureCurrent}
        />

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
          variant={filters.relatedOnly ? 'default' : 'outline'}
          size="sm"
          onClick={() => setFilter('relatedOnly', !filters.relatedOnly)}
          aria-pressed={filters.relatedOnly}
          title="Show only cases linked across sources"
        >
          <Link2 className="mr-1.5 size-4" aria-hidden />
          Cross-source
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={clearAll}
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

        {/* Column customization — folded into the filter bar (formerly a standalone row). */}
        <ColumnsMenu
          columns={columnMenuItems}
          state={columnState}
          onChange={handleColumnState}
        />
      </Card>

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
        columnState={columnState}
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
                <Button variant="outline" size="sm" onClick={clearAll}>
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
        onResolve={(reason) =>
          void runBulk({ action: 'resolve', reason: reason || 'Bulk-resolved by analyst' })
        }
        onAssign={(assignee) => void runBulk({ action: 'escalate', assignee })}
        onAddTag={(tag) => void runBulk({ action: 'acknowledge', tags: [tag] })}
        onSetStatus={(status) => void runBulk({ action: 'set_status', status })}
        onSetDisposition={(disposition) =>
          void runBulk({ action: 'set_disposition', disposition })
        }
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

      {/* Bug #8: destructive one-click close confirmation. The close still posts
          through the analyst `close` action (server-side decide(), #3). */}
      <ConfirmDialog
        open={closeTarget !== null}
        onOpenChange={(next) => {
          if (!next) setCloseTarget(null);
        }}
        destructive
        title="Close this case?"
        description={
          closeTarget
            ? `Case ${closeTarget.case_number || closeTarget.case_id} will be closed. This is an analyst action; the resolution is adjudicated server-side.`
            : undefined
        }
        confirmLabel="Close case"
        onConfirm={() => {
          void confirmClose();
        }}
      />
    </PageContainer>
  );
}

/* ------------------------------------------------------------- bulk bar ---- */

/** Lifecycle statuses an analyst may bulk-set (close goes through the dedicated
 * close/resolve actions, never set_status — the backend enforces this too). */
const BULK_STATUSES: Array<{ value: string; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'investigating', label: 'Investigating' },
  { value: 'on_hold', label: 'On hold' },
  { value: 'escalated', label: 'Escalated' },
];

/** Dispositions an analyst may bulk-set. */
const BULK_DISPOSITIONS: Array<{ value: string; label: string }> = [
  { value: 'true_positive', label: 'True positive' },
  { value: 'false_positive', label: 'False positive' },
  { value: 'benign', label: 'Benign' },
  { value: 'suspicious', label: 'Suspicious' },
  { value: 'duplicate', label: 'Duplicate' },
];

const BulkActionBar: React.FC<{
  count: number;
  busy: boolean;
  onAcknowledge: () => void;
  onClose: () => void;
  onResolve: (reason: string) => void;
  onAssign: (assignee: string) => void;
  onAddTag: (tag: string) => void;
  onSetStatus: (status: string) => void;
  onSetDisposition: (disposition: string) => void;
  onClear: () => void;
}> = ({
  count,
  busy,
  onAcknowledge,
  onClose,
  onResolve,
  onAssign,
  onAddTag,
  onSetStatus,
  onSetDisposition,
  onClear,
}) => {
  const [assignOpen, setAssignOpen] = React.useState(false);
  const [assignee, setAssignee] = React.useState('');
  const [tagOpen, setTagOpen] = React.useState(false);
  const [tag, setTag] = React.useState('');

  React.useEffect(() => {
    if (count === 0) {
      setAssignOpen(false);
      setAssignee('');
      setTagOpen(false);
      setTag('');
    }
  }, [count]);

  if (count === 0) return null;

  return (
    <div
      role="region"
      aria-label="Bulk actions"
      className="fixed bottom-5 left-1/2 z-50 max-w-[94vw] -translate-x-1/2 animate-rise-in"
    >
      <Card
        elevation="none"
        className="flex flex-wrap items-center gap-2 px-3 py-2.5 shadow-elev2"
      >
        <span className="inline-flex items-center rounded-md bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
          {count} selected
        </span>

        {/* cases:write tier */}
        <Button size="sm" variant="secondary" onClick={onAcknowledge} disabled={busy}>
          <Check className="mr-1.5 size-4" aria-hidden />
          Acknowledge
        </Button>

        {/* Assign / escalate (cases:write) */}
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

        {/* Add tag (cases:write) */}
        <Popover open={tagOpen} onOpenChange={setTagOpen}>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" disabled={busy}>
              <TagIcon className="mr-1.5 size-4" aria-hidden />
              Add tag
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-60" side="top">
            <div className="space-y-2">
              <label
                htmlFor="bulk-tag"
                className="block text-xs font-medium text-muted-foreground"
              >
                Tag to add
              </label>
              <Input
                id="bulk-tag"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                placeholder="e.g. needs-review"
                aria-label="Tag to add to selected cases"
              />
              <Button
                size="sm"
                className="w-full"
                disabled={!tag.trim() || busy}
                onClick={() => {
                  onAddTag(tag.trim());
                  setTagOpen(false);
                }}
              >
                Tag {count}
              </Button>
            </div>
          </PopoverContent>
        </Popover>

        {/* Set status (cases:write) */}
        <Select value="" onValueChange={(v) => v && onSetStatus(v)} disabled={busy}>
          <SelectTrigger className="h-8 w-[9.5rem]" aria-label="Set status for selected cases">
            <span className="inline-flex items-center text-sm">
              <SlidersHorizontal className="mr-1.5 size-4" aria-hidden />
              Set status
            </span>
          </SelectTrigger>
          <SelectContent>
            {BULK_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Set disposition (cases:write) */}
        <Select value="" onValueChange={(v) => v && onSetDisposition(v)} disabled={busy}>
          <SelectTrigger
            className="h-8 w-[10.5rem]"
            aria-label="Set disposition for selected cases"
          >
            <span className="inline-flex items-center text-sm">
              <CircleSlash className="mr-1.5 size-4" aria-hidden />
              Set disposition
            </span>
          </SelectTrigger>
          <SelectContent>
            {BULK_DISPOSITIONS.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Close / resolve — cases:close. Hidden unless granted (RBAC-mirrored). */}
        <Can resource="cases" action="close">
          <Button size="sm" variant="outline" onClick={() => onResolve('')} disabled={busy}>
            <Check className="mr-1.5 size-4" aria-hidden />
            Resolve
          </Button>
          <Button size="sm" variant="destructive" onClick={onClose} disabled={busy}>
            <X className="mr-1.5 size-4" aria-hidden />
            Close
          </Button>
        </Can>

        <Button size="sm" variant="ghost" onClick={onClear} disabled={busy}>
          Clear
        </Button>
      </Card>
    </div>
  );
};
