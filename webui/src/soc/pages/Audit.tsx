/**
 * Audit log viewer (Round-2 W7c) — a read-only window onto the append-only audit
 * (#2). Reads GET /api/audit (filterable, bounded, NEWEST first) and renders the
 * records in a dense table with a filter bar (actor / action / surface / case id /
 * search) and a deep-link to the related case.
 *
 * The whole page is gated by the `audit:view` grant (admin / auditor / soc_manager
 * by default) via <ProtectedRoute>; the rail item is likewise RBAC-hidden. There is
 * NO write/update/delete affordance here — the audit index is immutable (#2).
 *
 * SECURITY (#9): every audit field is system/operator/LOG-derived and is rendered
 * as PLAIN text. `result_summary`, `query_text`, `prompt_excerpt` and
 * `tool_output_summary` can carry fenced UNTRUSTED log excerpts, so they render via
 * <InlineCode>/<CodeBlock> only — never as markup.
 */
import * as React from 'react';
import {
  ScrollText,
  RefreshCw,
  Search,
  X,
  ArrowUpRight,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { AuditRecord, AuditQuery } from '@/lib/types';
import { humanizeAge, humanizeToken, formatTimestamp, DASH } from '@/lib/format';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Badge } from '@/ui/badge';
import { Card } from '@/ui/card';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';

import { PageHeader } from '@/soc/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { InlineCode } from '@/soc/components/CodeBlock';
import { ProtectedRoute } from '@/soc/components/Can';
import type { Navigate } from '@/soc/router';
import { useRoute } from '@/soc/router';

const LIST_LIMIT = 200;

/** Sentinel for "any" in the single-select filters (Radix Select forbids ""). */
const ANY = '__any__';

type TimeRange = 'all' | '24h' | '7d' | '30d';

const TIME_RANGE_MS: Record<Exclude<TimeRange, 'all'>, number> = {
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

/** The one-line, UNTRUSTED-safe summary for a row (whatever the backend recorded). */
function rowSummary(r: AuditRecord): string {
  return (
    (r.result_summary || r.tool_output_summary || r.query_text || r.prompt_excerpt || '') ?? ''
  );
}

export interface AuditProps {
  onNavigate?: Navigate;
}

function AuditViewer({ onNavigate }: AuditProps) {
  const route = useRoute();
  const navigate = onNavigate ?? route.navigate;

  const [records, setRecords] = React.useState<AuditRecord[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  // Server-side filters (re-fetch) vs client-side search (over the loaded window).
  const [actor, setActor] = React.useState('');
  const [action, setAction] = React.useState(ANY);
  const [surface, setSurface] = React.useState(ANY);
  const [caseId, setCaseId] = React.useState('');
  const [timeRange, setTimeRange] = React.useState<TimeRange>('all');
  const [search, setSearch] = React.useState('');

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const now = Date.now();
      const params: AuditQuery = { limit: LIST_LIMIT };
      if (actor.trim()) params.actor = actor.trim();
      if (action !== ANY) params.action = action;
      if (surface !== ANY) params.surface = surface;
      if (caseId.trim()) params.case_id = caseId.trim();
      if (timeRange !== 'all') {
        params.from = new Date(now - TIME_RANGE_MS[timeRange]).toISOString();
      }
      const res = await api.audit.list(params);
      setRecords(res.records ?? []);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [actor, action, surface, caseId, timeRange]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // A drill-through (e.g. "view case audit") can seed a case-id filter.
  const routeCaseId = route.opts?.caseId;
  React.useEffect(() => {
    if (routeCaseId) setCaseId(routeCaseId);
  }, [routeCaseId]);

  // Facets for the dropdowns derived from the loaded window (self-describing).
  const surfaces = React.useMemo(() => {
    const s = new Set<string>();
    for (const r of records) if (r.surface) s.add(String(r.surface));
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [records]);

  const actions = React.useMemo(() => {
    const s = new Set<string>();
    for (const r of records) if (r.action_type) s.add(String(r.action_type));
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [records]);

  // Client-side search narrows the loaded window across actor/summary/case/etc.
  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return records;
    return records.filter((r) => {
      const hay = [
        r.actor,
        r.action_type,
        r.surface,
        r.case_id,
        r.model,
        r.tool_name,
        rowSummary(r),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [records, search]);

  const clearAll = React.useCallback(() => {
    setActor('');
    setAction(ANY);
    setSurface(ANY);
    setCaseId('');
    setTimeRange('all');
    setSearch('');
  }, []);

  const anyActive =
    !!actor.trim() ||
    action !== ANY ||
    surface !== ANY ||
    !!caseId.trim() ||
    timeRange !== 'all' ||
    !!search.trim();

  const columns: DataTableColumn<AuditRecord>[] = [
    {
      id: 'ts',
      header: 'Time',
      width: '9rem',
      cell: (r) => (
        <span
          className="whitespace-nowrap text-sm text-muted-foreground"
          title={formatTimestamp(r.ts)}
        >
          {humanizeAge(r.ts)}
        </span>
      ),
    },
    {
      id: 'action',
      header: 'Action',
      width: '9rem',
      cell: (r) =>
        r.action_type ? (
          <Badge variant="outline" className="font-normal">
            {humanizeToken(String(r.action_type))}
          </Badge>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'actor',
      header: 'Actor',
      width: '10rem',
      cell: (r) =>
        r.actor ? (
          <span className="text-sm text-foreground">{String(r.actor)}</span>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'surface',
      header: 'Surface',
      width: '8rem',
      cell: (r) =>
        r.surface ? (
          <span className="text-sm text-muted-foreground">
            {humanizeToken(String(r.surface))}
          </span>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'case',
      header: 'Case',
      width: '9rem',
      cell: (r) =>
        r.case_id ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              navigate('cases', { caseId: String(r.case_id) });
            }}
            className="inline-flex items-center gap-1 rounded-sm font-mono text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="max-w-[7rem] truncate">{String(r.case_id)}</span>
            <ArrowUpRight className="size-3 shrink-0" aria-hidden />
          </button>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        ),
    },
    {
      id: 'summary',
      header: 'Detail',
      cell: (r) => {
        const s = rowSummary(r);
        return s ? (
          <InlineCode className="block max-w-[34rem] truncate">{s}</InlineCode>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Platform"
        title="Audit log"
        description="Read-only, append-only record of every agent and analyst action."
        icon={ScrollText}
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-1.5 size-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            Refresh
          </Button>
        }
      />

      {/* Filter bar */}
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-[14rem] flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search actor, detail, case, tool…"
            aria-label="Search audit records"
            className="pl-9"
          />
        </div>

        <Input
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          placeholder="Actor"
          aria-label="Filter by actor"
          className="w-[10rem]"
        />

        <Select value={action} onValueChange={setAction}>
          <SelectTrigger className="w-[11rem]" aria-label="Filter by action">
            <SelectValue placeholder="Action" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All actions</SelectItem>
            {actions.map((a) => (
              <SelectItem key={a} value={a}>
                {humanizeToken(a)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {surfaces.length ? (
          <Select value={surface} onValueChange={setSurface}>
            <SelectTrigger className="w-[10rem]" aria-label="Filter by surface">
              <SelectValue placeholder="Surface" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>All surfaces</SelectItem>
              {surfaces.map((s) => (
                <SelectItem key={s} value={s}>
                  {humanizeToken(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}

        <Input
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
          placeholder="Case ID"
          aria-label="Filter by case id"
          className="w-[11rem] font-mono text-xs"
        />

        <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
          <SelectTrigger className="w-[9.5rem]" aria-label="Filter by time">
            <SelectValue placeholder="Any time" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Any time</SelectItem>
            <SelectItem value="24h">Last 24 hours</SelectItem>
            <SelectItem value="7d">Last 7 days</SelectItem>
            <SelectItem value="30d">Last 30 days</SelectItem>
          </SelectContent>
        </Select>

        <Button variant="ghost" size="sm" onClick={clearAll} disabled={!anyActive}>
          <X className="mr-1.5 size-4" aria-hidden />
          Clear
        </Button>

        <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
          Showing <strong className="text-foreground">{filtered.length}</strong> of{' '}
          {records.length}
        </span>
      </Card>

      {error ? (
        <LoadError
          error={error}
          title="Could not load the audit log"
          fallback="An unexpected error occurred."
          onRetry={() => void load()}
        />
      ) : null}

      <DataTable<AuditRecord>
        ariaLabel="Audit log"
        columns={columns}
        rows={filtered}
        getRowId={(r, i) => `${r.ts ?? ''}-${r.action_type ?? ''}-${r.case_id ?? ''}-${i}`}
        loading={loading}
        loadingRows={10}
        density="compact"
        empty={
          <EmptyState
            compact
            icon={ScrollText}
            title={records.length === 0 ? 'No audit records' : 'No records match your filters'}
            description={
              records.length === 0
                ? 'Agent and analyst actions will appear here as they happen.'
                : 'Clear or widen the filters to see more records.'
            }
            action={
              records.length > 0 && anyActive ? (
                <Button variant="outline" size="sm" onClick={clearAll}>
                  <X className="mr-1.5 size-4" aria-hidden />
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        }
      />
    </div>
  );
}

/** Page-level guard: only `audit:view` principals can see the audit log. */
export default function Audit({ onNavigate }: AuditProps) {
  return (
    <ProtectedRoute resource="audit" action="view">
      <AuditViewer onNavigate={onNavigate} />
    </ProtectedRoute>
  );
}
