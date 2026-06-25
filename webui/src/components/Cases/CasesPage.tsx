/**
 * Cases — the core analyst workflow surface. Rebuilt on shadcn/ui (Tailwind +
 * Radix primitives, see components/ui/*), themed via the shared token bridge to
 * match the EUI console. Lists recent cases (GET /api/cases) with headline
 * counts, status + verdict + collaboration filters, and a client-side search;
 * clicking any row opens the EUI CaseDetailFlyout where the analyst reviews
 * evidence, the agent trace, the timeline, and takes a lifecycle action.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Bug,
  Expand,
  FileText,
  MessageSquare,
  Play,
  RefreshCw,
  Search,
  User,
} from 'lucide-react';
import type { Case } from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS, riskHex, tint, verdictHex } from '../../lib/theme';
import { humanizeAge } from '../../lib/format';
import { RiskPill, StatusPill, VerdictPill } from '../common/socBadges';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { Skeleton } from '../ui/skeleton';
import { CaseDetailFlyout } from './CaseDetailFlyout';

type StatusFilter = 'all' | 'open' | 'needs_human' | 'closed';
type VerdictFilter = 'all' | 'true' | 'false' | 'needs_human';
type CollabFilter = 'all' | 'unassigned' | 'has_comments';

/** Sentinel select value meaning "no assignee filter applied". */
const ANY_ASSIGNEE = '__any__';

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'needs_human', label: 'Needs human' },
  { value: 'closed', label: 'Closed' },
];

const VERDICT_FILTERS: Array<{ value: VerdictFilter; label: string }> = [
  { value: 'all', label: 'Any' },
  { value: 'true', label: 'True positive' },
  { value: 'false', label: 'False positive' },
  { value: 'needs_human', label: 'Needs human' },
];

const COLLAB_FILTERS: Array<{ value: CollabFilter; label: string }> = [
  { value: 'all', label: 'Any' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'has_comments', label: 'Has comments' },
];

type SortField = 'title' | 'risk_score' | 'updated_at' | 'status' | 'verdict' | 'assignee';

function verdictClass(c: Case): VerdictFilter {
  const v = (c.verdict || '').toUpperCase();
  if (v.includes('TRUE')) return 'true';
  if (v.includes('FALSE')) return 'false';
  if (v.includes('NEEDS') || v.includes('INCONCLUSIVE') || v.includes('UNKNOWN')) return 'needs_human';
  return 'all';
}

const StatCard: React.FC<{ label: string; value: React.ReactNode; accent: string; icon: React.ReactNode }> = ({
  label,
  value,
  accent,
  icon,
}) => (
  <Card style={{ borderTop: `3px solid ${tint(accent, 0.85)}` }}>
    <CardContent>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">{label}</div>
          <div className="text-3xl font-bold tracking-tight leading-none text-foreground">{value}</div>
        </div>
        <span className="inline-flex items-center justify-center rounded-md shrink-0 [&_svg]:h-4 [&_svg]:w-4" style={{ width: 32, height: 32, background: tint(accent, 0.14), color: accent }}>
          {icon}
        </span>
      </div>
    </CardContent>
  </Card>
);

const FilterBlock: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="text-[11px] font-semibold text-muted-foreground mb-1">{label}</div>
    {children}
  </div>
);

const CasesInner: React.FC = () => {
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
    let open = 0, needsHuman = 0, truePositive = 0;
    for (const c of cases) {
      if (c.status === 'open') open += 1;
      if (c.status === 'needs_human') needsHuman += 1;
      if ((c.verdict || '').toUpperCase().includes('TRUE')) truePositive += 1;
    }
    return { open, needsHuman, truePositive };
  }, [cases]);

  const assigneeOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const c of cases) {
      const a = (c.assignee || '').trim();
      if (a) seen.add(a);
    }
    const names = Array.from(seen).sort((a, b) => a.localeCompare(b));
    return [{ value: ANY_ASSIGNEE, label: 'Any assignee' }, ...names.map((n) => ({ value: n, label: n }))];
  }, [cases]);

  useEffect(() => {
    if (assigneeFilter !== ANY_ASSIGNEE && !assigneeOptions.some((o) => o.value === assigneeFilter)) {
      setAssigneeFilter(ANY_ASSIGNEE);
    }
  }, [assigneeFilter, assigneeOptions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = cases;
    if (verdictFilter !== 'all') rows = rows.filter((c) => verdictClass(c) === verdictFilter);
    if (collabFilter === 'unassigned') rows = rows.filter((c) => !(c.assignee || '').trim());
    else if (collabFilter === 'has_comments') rows = rows.filter((c) => Array.isArray(c.comments) && c.comments.length > 0);
    if (assigneeFilter !== ANY_ASSIGNEE) rows = rows.filter((c) => (c.assignee || '').trim() === assigneeFilter);
    if (q) {
      rows = rows.filter((c) => {
        const hay = [c.title, c.case_id, c.entity?.value, c.entity?.type, ...(Array.isArray(c.tags) ? c.tags : [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return rows;
  }, [cases, search, verdictFilter, collabFilter, assigneeFilter]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
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
          return (a.assignee || '￿').localeCompare(b.assignee || '￿') * dir;
        case 'updated_at':
        default:
          return (a.updated_at || a.created_at || '').localeCompare(b.updated_at || b.created_at || '') * dir;
      }
    });
  }, [filtered, sortField, sortDir]);

  const toggleSort = useCallback((field: SortField) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('desc');
      return field;
    });
  }, []);

  const SortHead: React.FC<{ field: SortField; children: React.ReactNode; className?: string }> = ({ field, children, className }) => (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => toggleSort(field)}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground transition-colors"
      >
        {children}
        {sortField === field ? (sortDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : null}
      </button>
    </TableHead>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className="sn-scope socPageEnter" style={{ padding: 24 }}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h1 className="text-2xl font-bold leading-tight text-foreground m-0">Cases</h1>
            <p className="text-[13px] text-muted-foreground m-0 mt-0.5">Audited, human-reviewable triage cases.</p>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="text-xs text-muted-foreground">Updated just now</span>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : ''} /> Refresh
            </Button>
          </div>
        </div>

        {/* KPI tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <StatCard label="Total cases" value={total} accent={COLORS.primary} icon={<FileText />} />
          <StatCard label="Open (in view)" value={counts.open} accent={COLORS.semantic.operational} icon={<FileText />} />
          <StatCard label="Needs human (in view)" value={counts.needsHuman} accent={COLORS.warning} icon={<AlertTriangle />} />
          <StatCard label="True positives (in view)" value={counts.truePositive} accent={COLORS.danger} icon={<Bug />} />
        </div>

        {/* Filters */}
        <Card className="mb-4">
          <CardContent className="p-3">
            <div className="flex flex-wrap items-end gap-4">
              <FilterBlock label="SEARCH">
                <div className="relative min-w-[240px]">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                  <Input
                    className="pl-8"
                    placeholder="Search title, entity, IP, tags…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search cases"
                  />
                </div>
              </FilterBlock>
              <FilterBlock label="STATUS">
                <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
                  <TabsList>{STATUS_FILTERS.map((f) => <TabsTrigger key={f.value} value={f.value}>{f.label}</TabsTrigger>)}</TabsList>
                </Tabs>
              </FilterBlock>
              <FilterBlock label="VERDICT">
                <Tabs value={verdictFilter} onValueChange={(v) => setVerdictFilter(v as VerdictFilter)}>
                  <TabsList>{VERDICT_FILTERS.map((f) => <TabsTrigger key={f.value} value={f.value}>{f.label}</TabsTrigger>)}</TabsList>
                </Tabs>
              </FilterBlock>
              <FilterBlock label="ASSIGNMENT">
                <Tabs value={collabFilter} onValueChange={(v) => setCollabFilter(v as CollabFilter)}>
                  <TabsList>{COLLAB_FILTERS.map((f) => <TabsTrigger key={f.value} value={f.value}>{f.label}</TabsTrigger>)}</TabsList>
                </Tabs>
              </FilterBlock>
              <FilterBlock label="ASSIGNEE">
                <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
                  <SelectTrigger className="min-w-[160px] h-8"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {assigneeOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </FilterBlock>
            </div>
          </CardContent>
        </Card>

        {error ? (
          <Card className="mb-4 border-destructive/40">
            <CardContent className="flex items-center gap-2 text-sm" style={{ color: COLORS.danger }}>
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error instanceof Error ? error.message : String(error)}
            </CardContent>
          </Card>
        ) : null}

        {loading ? (
          <Card><CardContent className="flex flex-col gap-2.5">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}</CardContent></Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>
                Cases <span className="text-muted-foreground font-normal">({sorted.length}{sorted.length !== total ? ` of ${total}` : ''})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {sorted.length === 0 ? (
                <div className="text-center py-12">
                  <div className="text-sm font-semibold text-foreground mb-1">{cases.length === 0 ? 'No cases available' : 'No matching cases found'}</div>
                  <div className="text-xs text-muted-foreground mb-3">
                    {cases.length === 0 ? 'Cases appear as investigations complete, scans create findings, or alerts escalate.' : 'Clear the search / filters to see all loaded cases.'}
                  </div>
                  <Button size="sm"><Play /> Run investigation</Button>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <SortHead field="title">Title</SortHead>
                      <TableHead>Entity</TableHead>
                      <SortHead field="assignee">Assignee</SortHead>
                      <TableHead>Tags</TableHead>
                      <SortHead field="verdict">Verdict</SortHead>
                      <SortHead field="risk_score">Risk</SortHead>
                      <SortHead field="status">Status</SortHead>
                      <SortHead field="updated_at">Updated</SortHead>
                      <TableHead className="w-12" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sorted.map((c) => {
                      const accent = verdictHex(c.verdict) || riskHex(c.risk_score);
                      const tags = Array.isArray(c.tags) ? c.tags.filter(Boolean) : [];
                      const commentCount = Array.isArray(c.comments) ? c.comments.length : 0;
                      const assignee = (c.assignee || '').trim();
                      return (
                        <TableRow key={c.case_id} className="cursor-pointer" onClick={() => setSelectedCaseId(c.case_id)}>
                          <TableCell>
                            <span className="inline-flex items-center font-semibold break-words pl-2" style={{ borderLeft: `3px solid ${accent}` }}>
                              {c.title || c.case_id}
                            </span>
                          </TableCell>
                          <TableCell>
                            {c.entity ? (
                              <span className="text-sm">{c.entity.type}: <span className="socMono">{c.entity.value}</span></span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {assignee ? (
                              <Badge variant="outline" className="gap-1" style={{ color: COLORS.primary, borderColor: tint(COLORS.primary, 0.3) }}>
                                <User className="h-3 w-3" /> {assignee}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">Unassigned</Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            {!tags.length && !commentCount ? (
                              <span className="text-muted-foreground">—</span>
                            ) : (
                              <div className="flex flex-wrap items-center gap-1">
                                {tags.slice(0, 3).map((t) => <Badge key={t} variant="outline">{t}</Badge>)}
                                {tags.length > 3 ? <Badge variant="outline">+{tags.length - 3}</Badge> : null}
                                {commentCount > 0 ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge variant="outline" className="gap-1"><MessageSquare className="h-3 w-3" /> {commentCount}</Badge>
                                    </TooltipTrigger>
                                    <TooltipContent>{commentCount} analyst comment{commentCount === 1 ? '' : 's'}</TooltipContent>
                                  </Tooltip>
                                ) : null}
                              </div>
                            )}
                          </TableCell>
                          <TableCell><VerdictPill verdict={c.verdict} /></TableCell>
                          <TableCell><RiskPill score={c.risk_score} /></TableCell>
                          <TableCell><StatusPill status={c.status} /></TableCell>
                          <TableCell><span className="text-muted-foreground whitespace-nowrap">{humanizeAge(c.updated_at || c.created_at)}</span></TableCell>
                          <TableCell>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={(e) => { e.stopPropagation(); setSelectedCaseId(c.case_id); }}>
                                  <Expand className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Open case detail</TooltipContent>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        )}

        {selectedCaseId ? (
          <CaseDetailFlyout caseId={selectedCaseId} onClose={() => setSelectedCaseId(null)} onChanged={load} />
        ) : null}
      </div>
    </TooltipProvider>
  );
};

export const CasesPage: React.FC = () => <CasesInner />;
