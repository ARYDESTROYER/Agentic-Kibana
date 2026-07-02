/**
 * Scans — the board of cases the agent opened from background scanning (new
 * command-center UI). Fetches GET /api/scans and renders:
 *   - accent-topped KPI tiles (scanned / needs-human / auto-investigated /
 *     true-positive candidates), derived from the loaded cases,
 *   - a client-side filter bar (search + verdict + source selects + clear),
 *   - quick status tab PILLS (All / Open / Needs human / Closed) with counts,
 *   - a sort selector, and
 *   - a responsive CARD GRID of polished case cards (cascaded with <Stagger>),
 *     each opening the shared CaseDetail sheet on click.
 *
 * A "N new" pill (api.scanNotifications + a localStorage watermark) surfaces
 * cases created since the operator last looked; "Mark all seen" advances it.
 *
 * All filtering is CLIENT-SIDE over the loaded list and SELF-HEALS: any selected
 * facet value that no longer exists after a reload is dropped so the grid can
 * never silently empty behind an un-clearable filter.
 *
 * SECURITY: every case-derived value (title, entity, IPs, rules, source names,
 * persona) is UNTRUSTED — rendered as plain text or inside <InlineCode>, never
 * as markup.
 */
import * as React from 'react';
import {
  AlertTriangle,
  Bell,
  Bot,
  Check,
  Database,
  RefreshCw,
  ScanSearch,
  Search,
  Tag,
  UserRound,
  X,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { Case } from '@/lib/types';
import { DASH, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Badge } from '@/ui/badge';
import { Card } from '@/ui/card';
import { Skeleton } from '@/ui/skeleton';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/ui/select';

import { PageHeader } from '@/soc/components/PageHeader';
import { PageContainer } from '@/soc/components/PageContainer';
import { KpiTile, type KpiAccent } from '@/soc/components/KpiTile';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';
import { SegmentedControl } from '@/soc/components/SegmentedControl';
import { Stagger } from '@/soc/components/Stagger';
import { InlineCode } from '@/soc/components/CodeBlock';
import { CaseHoverCard } from '@/soc/components/CaseHoverCard';
import {
  VerdictBadge,
  StatusBadge,
  RiskBadge,
  ConfidenceBadge,
} from '@/soc/components/badges';

import { CaseDetail } from '@/soc/pages/CaseDetail';
import type { Navigate } from '@/soc/router';

/* --------------------------------------------------------------- contracts -- */

type StatusTab = 'all' | 'open' | 'needs_human' | 'closed';
type SortOption =
  | 'newest'
  | 'oldest'
  | 'updated_newest'
  | 'risk'
  | 'risk_low'
  | 'verdict'
  | 'status';

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
  { value: 'risk', text: 'Highest risk' },
  { value: 'risk_low', text: 'Lowest risk' },
  { value: 'verdict', text: 'Verdict (A→Z)' },
  { value: 'status', text: 'Status (A→Z)' },
];

/** Sentinel facet value for cases with no originating source recorded. */
const UNKNOWN_SOURCE = '__unknown_source__';
const UNKNOWN_SOURCE_LABEL = 'Unknown source';
/** Sentinel "any" value for the verdict/source single-selects. */
const ANY = '__any__';

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

/** True when the case still wants a human (status or verdict signals it). */
function needsHuman(c: Case): boolean {
  const s = (c.status || '').toLowerCase();
  const v = (c.verdict || '').toUpperCase();
  return s === 'needs_human' || v.includes('NEEDS_HUMAN') || v.includes('INCONCLUSIVE');
}

/** A terminal (closed/resolved/auto-closed) case, across the extended taxonomy. */
function isClosed(c: Case): boolean {
  const s = (c.status || '').toLowerCase();
  return s === 'closed' || s === 'resolved' || s === 'auto_closed';
}

/**
 * The status tab a case belongs to. The three buckets PARTITION every case
 * (closed → needs-human → open) so the pill counts always sum to "All", and
 * "Open" captures the extended taxonomy (new/investigating/escalated/on_hold),
 * not just the literal 'open' status.
 */
function statusBucket(c: Case): Exclude<StatusTab, 'all'> {
  if (isClosed(c)) return 'closed';
  if (needsHuman(c)) return 'needs_human';
  return 'open';
}

/** A case the agent ran the investigator on (it produced a real verdict). */
function isInvestigated(c: Case): boolean {
  return Boolean(c.verdict) && (c.verdict || '').toUpperCase() !== 'UNKNOWN';
}

/** True when a case verdict reads as a true/likely positive. */
function isTruePositive(c: Case): boolean {
  return (c.verdict || '').toUpperCase().includes('TRUE');
}

const sortedUniq = (vals: Iterable<string>): string[] =>
  Array.from(new Set(vals)).sort((a, b) => a.localeCompare(b));

/* --------------------------------------------------------- watermark (new) -- */

/** localStorage key for the operator's last-seen scan timestamp ("N new" pill). */
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

/* ----------------------------------------------------------------- page ----- */

export interface ScansPageProps {
  onNavigate?: Navigate;
}

export const ScansPage: React.FC<ScansPageProps> = () => {
  const [cases, setCases] = React.useState<Case[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const [statusTab, setStatusTab] = React.useState<StatusTab>('all');
  const [sortBy, setSortBy] = React.useState<SortOption>('newest');
  const [search, setSearch] = React.useState('');
  const [verdict, setVerdict] = React.useState<string>(ANY);
  const [source, setSource] = React.useState<string>(ANY);

  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);

  /**
   * Watermark for "new" cases — cases created strictly after this timestamp get
   * a "New" flag + count toward the header pill. Seeded from localStorage so it
   * survives reloads; advanced to "now" when the operator marks all seen. Held
   * in a ref so re-renders don't re-derive the new-set mid-session.
   */
  const lastSeenRef = React.useRef<string | null>(readLastSeen());
  const [newCount, setNewCount] = React.useState(0);
  const [newIds, setNewIds] = React.useState<Set<string>>(() => new Set());

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.scans(50);
      const list = Array.isArray(res?.cases) ? res.cases : [];
      setCases(list);
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
  const refreshNotifications = React.useCallback(async () => {
    try {
      const res = await api.scanNotifications(lastSeenRef.current || undefined);
      setNewCount(typeof res?.new_count === 'number' ? res.new_count : 0);
    } catch {
      // Best-effort badge — failures leave the prior count untouched.
    }
  }, []);

  /** Operator acknowledged the new cases: advance the watermark to "now". */
  const markAllSeen = React.useCallback(() => {
    const now = new Date().toISOString();
    lastSeenRef.current = now;
    writeLastSeen(now);
    setNewCount(0);
    setNewIds(new Set());
  }, []);

  React.useEffect(() => {
    void load();
    void refreshNotifications();
  }, [load, refreshNotifications]);

  /* ------------------------------------------------------------ derived --- */

  const kpis = React.useMemo(() => {
    const total = cases.length;
    // Count with the SAME bucket predicate the "Needs human" tab filters on, so
    // clicking the tile lands on a grid whose row/pill count matches the tile.
    const human = cases.filter((c) => statusBucket(c) === 'needs_human').length;
    const investigated = cases.filter(isInvestigated).length;
    const candidates = cases.filter(isTruePositive).length;
    return { total, human, investigated, candidates };
  }, [cases]);

  // Per-tab counts over the loaded rows (drives the "All N · Open …" pills).
  const tabCounts = React.useMemo<Record<StatusTab, number>>(() => {
    const counts: Record<StatusTab, number> = {
      all: cases.length,
      open: 0,
      needs_human: 0,
      closed: 0,
    };
    for (const c of cases) {
      counts[statusBucket(c)] += 1;
    }
    return counts;
  }, [cases]);

  // Facet values present in the loaded rows (drive the selects).
  const verdictFacets = React.useMemo(
    () => sortedUniq(cases.map((c) => c.verdict || '').filter(Boolean)),
    [cases],
  );
  const sourceFacets = React.useMemo(() => {
    const keys = new Set<string>();
    const labels: Record<string, string> = {};
    for (const c of cases) {
      const k = caseSourceKey(c);
      keys.add(k);
      if (k !== UNKNOWN_SOURCE && !labels[k]) labels[k] = caseSourceLabel(c);
    }
    if (keys.has(UNKNOWN_SOURCE)) labels[UNKNOWN_SOURCE] = UNKNOWN_SOURCE_LABEL;
    const sorted = Array.from(keys).sort((a, b) => {
      if (a === UNKNOWN_SOURCE) return 1;
      if (b === UNKNOWN_SOURCE) return -1;
      return (labels[a] || a).localeCompare(labels[b] || b);
    });
    return { keys: sorted, labels };
  }, [cases]);

  // Self-heal: drop a stale selected facet value when the loaded rows change.
  React.useEffect(() => {
    if (verdict !== ANY && !verdictFacets.includes(verdict)) setVerdict(ANY);
  }, [verdict, verdictFacets]);
  React.useEffect(() => {
    if (source !== ANY && !sourceFacets.keys.includes(source)) setSource(ANY);
  }, [source, sourceFacets]);

  const visible = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = cases;
    if (statusTab !== 'all') {
      rows = rows.filter((c) => statusBucket(c) === statusTab);
    }
    rows = rows.filter((c) => {
      if (verdict !== ANY && (c.verdict || '') !== verdict) return false;
      if (source !== ANY && caseSourceKey(c) !== source) return false;
      if (q) {
        const hay = [
          c.title,
          c.case_id,
          c.entity?.value,
          c.entity?.type,
          ...(Array.isArray(c.rule_ids) ? c.rule_ids : []),
          ...(Array.isArray(c.tags) ? c.tags : []),
          c.source_name,
          c.agent_persona,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const out = [...rows];
    out.sort((a, b) => {
      switch (sortBy) {
        case 'oldest':
          return (a.created_at || '').localeCompare(b.created_at || '');
        case 'updated_newest':
          return (b.updated_at || b.created_at || '').localeCompare(
            a.updated_at || a.created_at || '',
          );
        case 'risk':
          return (b.risk_score ?? -1) - (a.risk_score ?? -1);
        case 'risk_low':
          return (a.risk_score ?? -1) - (b.risk_score ?? -1);
        case 'verdict':
          return (a.verdict || '￿').localeCompare(b.verdict || '￿');
        case 'status':
          return (a.status || '￿').localeCompare(b.status || '￿');
        case 'newest':
        default:
          return (b.created_at || '').localeCompare(a.created_at || '');
      }
    });
    return out;
  }, [cases, statusTab, search, verdict, source, sortBy]);

  const anyFilterActive =
    search.trim() !== '' || verdict !== ANY || source !== ANY || statusTab !== 'all';

  const clearFilters = React.useCallback(() => {
    setSearch('');
    setVerdict(ANY);
    setSource(ANY);
    setStatusTab('all');
  }, []);

  /* ------------------------------------------------------------- render --- */

  return (
    <PageContainer variant="wide" className="space-y-8 animate-fade-in">
      <PageHeader
        eyebrow="AUTOMATION"
        icon={ScanSearch}
        title="Automated scans"
        description="Cases the agent opened and triaged from background scanning."
        actions={
          <>
            {newCount > 0 ? (
              <Button
                variant="outline"
                size="sm"
                onClick={markAllSeen}
                aria-label={`${newCount} new scan cases since you last looked — mark all as seen`}
              >
                <Bell className="h-4 w-4 text-primary" />
                <span className="inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
                  {newCount}
                </span>
                new
              </Button>
            ) : null}
            <Button
              size="sm"
              onClick={() => {
                void load();
                void refreshNotifications();
              }}
              disabled={loading}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              Refresh
            </Button>
          </>
        }
      />

      {/* On a fetch failure show ONLY the error — not zeroed KPIs, a "0 of 0"
          toolbar, and a "scans are off" empty state that misattributes the cause. */}
      {error ? (
        <LoadError
          error={error}
          title="Could not load scan cases"
          fallback="Something went wrong loading scans."
          onRetry={() => void load()}
        />
      ) : (
        <>
      {/* ---------------------------------------------------------- KPIs */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[7.5rem] w-full rounded-lg" />
          ))
        ) : (
          <>
            <KpiTile
              label="Scanned cases"
              value={kpis.total}
              icon={ScanSearch}
              accent="primary"
              sub="from background scans"
            />
            <KpiTile
              label="Needs human"
              value={kpis.human}
              icon={UserRound}
              accent="high"
              sub="awaiting analyst review"
              onClick={() => setStatusTab('needs_human')}
            />
            <KpiTile
              label="Auto-investigated"
              value={kpis.investigated}
              icon={Bot}
              accent="success"
              sub="agent produced a verdict"
            />
            <KpiTile
              label="True-positive candidates"
              value={kpis.candidates}
              icon={AlertTriangle}
              accent="critical"
              sub="never auto-closed"
            />
          </>
        )}
      </div>

      {/* ----------------------------------------------- controls toolbar */}
      {loading && cases.length === 0 ? (
        // Skeleton while the first fetch is in flight — never flash "0 of 0" or
        // all-zero tab counts next to the KPI/grid skeletons.
        <Skeleton className="h-[6.5rem] w-full rounded-lg" />
      ) : (
      <Card className="space-y-4 p-4">
        {/* status tab filter + result count. SegmentedControl (Radix Tabs) gives
            roving arrow-key focus + role=tab/aria-selected for free — the counts
            ride along as plain-text badges inside each option label. */}
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl<StatusTab>
            size="sm"
            value={statusTab}
            onValueChange={setStatusTab}
            aria-label="Status filter"
            options={STATUS_TABS.map((t) => ({
              value: t.key,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {t.label}
                  <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-muted px-1 text-[0.6875rem] font-semibold tabular-nums text-muted-foreground">
                    {tabCounts[t.key]}
                  </span>
                </span>
              ),
            }))}
          />
          <span className="ml-auto text-xs text-muted-foreground">
            Showing <span className="font-semibold tabular-nums text-foreground">{visible.length}</span> of{' '}
            <span className="tabular-nums">{cases.length}</span>
          </span>
        </div>

        {/* search + facet selects + sort */}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <div className="relative min-w-[14rem] flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Search title, entity, IP, rule, tags…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search scan cases"
            />
          </div>

          <Select value={verdict} onValueChange={setVerdict}>
            <SelectTrigger className="h-9 w-[11rem]" aria-label="Filter by verdict">
              <SelectValue placeholder="Verdict" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any verdict</SelectItem>
              {verdictFacets.map((v) => (
                <SelectItem key={v} value={v}>
                  {humanizeToken(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {sourceFacets.keys.length > 1 ? (
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger className="h-9 w-[12rem]" aria-label="Filter by source">
                <SelectValue placeholder="Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any source</SelectItem>
                {sourceFacets.keys.map((k) => (
                  <SelectItem key={k} value={k}>
                    {sourceFacets.labels[k] ||
                      (k === UNKNOWN_SOURCE ? UNKNOWN_SOURCE_LABEL : k)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}

          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            disabled={!anyFilterActive}
          >
            <X className="h-4 w-4" /> Clear
          </Button>

          <div className="ml-auto">
            <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
              <SelectTrigger className="h-9 w-[12rem]" aria-label="Sort scan cases">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </Card>
      )}

      {/* --------------------------------------------------- card grid */}
      {loading ? (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 w-full rounded-lg" />
          ))}
        </div>
      ) : cases.length === 0 ? (
        <EmptyState
          icon={ScanSearch}
          title="No scan cases yet"
          description="Background scans are off or there are no clusters yet. Enable background scans in Settings to populate this board."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No scan cases match your filters"
          description="No loaded cases match the current tab + filters. Clear them to see all scan cases."
          action={
            <Button size="sm" variant="outline" onClick={clearFilters}>
              <X className="h-4 w-4" /> Clear filters
            </Button>
          }
        />
      ) : (
        <Stagger className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((c) => (
            <ScanCard
              key={c.case_id}
              c={c}
              isNew={newIds.has(c.case_id)}
              onOpen={() => setOpenCaseId(c.case_id)}
            />
          ))}
        </Stagger>
      )}
        </>
      )}

      <CaseDetail
        caseId={openCaseId}
        onClose={() => {
          setOpenCaseId(null);
          // A lifecycle action inside the sheet may have changed the board.
          void load();
        }}
      />
    </PageContainer>
  );
};

export default ScansPage;

/* ----------------------------------------------------------------- card ---- */

const ACCENT_BORDER: Record<KpiAccent, string> = {
  primary: 'border-l-primary',
  critical: 'border-l-critical',
  high: 'border-l-high',
  medium: 'border-l-medium',
  low: 'border-l-low',
  info: 'border-l-info',
  success: 'border-l-success',
};

/** Pick a left-accent colour for a card from its verdict, falling back to risk. */
function cardAccent(c: Case): KpiAccent {
  const v = (c.verdict || '').toLowerCase();
  if (v === 'true_positive') return 'critical';
  if (v === 'false_positive' || v === 'benign') return 'success';
  if (v === 'needs_human') return 'high';
  const r = typeof c.risk_score === 'number' ? c.risk_score : -1;
  if (r >= 80) return 'critical';
  if (r >= 60) return 'high';
  if (r >= 35) return 'medium';
  if (r >= 15) return 'low';
  return 'info';
}

const ScanCard: React.FC<{
  c: Case;
  isNew?: boolean;
  onOpen: () => void;
}> = ({ c, isNew, onOpen }) => {
  const accent = cardAccent(c);
  const entity = c.entity ? `${c.entity.type}: ${c.entity.value}` : DASH;
  const rules = Array.isArray(c.rule_ids) ? c.rule_ids.filter(Boolean) : [];
  const persona = (c.agent_persona || '').trim();
  const hasSource = caseSourceKey(c) !== UNKNOWN_SOURCE;
  const sourceLabel = caseSourceLabel(c);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      aria-label={`Open case ${c.title || c.case_id}`}
      className={cn(
        'group relative flex w-full cursor-pointer flex-col gap-3 border-l-4 p-6 text-left transition-colors',
        'hover:border-primary/40 hover:bg-accent/30',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        ACCENT_BORDER[accent],
      )}
    >
      {/* header (entity · age · new) + title — wrapped in the hover preview */}
      <CaseHoverCard case={c}>
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-2">
            {/* UNTRUSTED entity — inside InlineCode. */}
            <InlineCode className="max-w-[70%] truncate text-xs">{entity}</InlineCode>
            <div className="flex shrink-0 items-center gap-2">
              {isNew ? (
                <Badge variant="info" className="gap-1">
                  New
                </Badge>
              ) : null}
              <span className="text-xs text-muted-foreground">{humanizeAge(c.created_at)}</span>
            </div>
          </div>

          {/* title — UNTRUSTED plain text */}
          <h3 className="line-clamp-2 break-words text-sm font-semibold leading-snug text-foreground">
            {c.title || c.case_id}
          </h3>
        </div>
      </CaseHoverCard>

      {/* verdict / status / risk / confidence */}
      <div className="flex flex-wrap items-center gap-1.5">
        <RiskBadge score={c.risk_score} />
        <VerdictBadge verdict={c.verdict} />
        <StatusBadge status={c.status} />
        {typeof c.confidence === 'number' ? (
          <ConfidenceBadge confidence={c.confidence} />
        ) : null}
      </div>

      {/* persona / source */}
      {persona || hasSource ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {persona ? (
            <Badge variant="outline" className="gap-1">
              <Check className="h-3 w-3" />
              {humanizeToken(persona)}
            </Badge>
          ) : null}
          {hasSource ? (
            <Badge variant="outline" className="gap-1">
              <Database className="h-3 w-3" />
              {/* UNTRUSTED source label — plain text node inside controlled Badge. */}
              <span className="max-w-[10rem] truncate">{sourceLabel}</span>
            </Badge>
          ) : null}
        </div>
      ) : null}

      {/* rule chips */}
      {rules.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {rules.slice(0, 4).map((r) => (
            <Badge key={r} variant="secondary" className="gap-1">
              <Tag className="h-3 w-3" />
              {/* UNTRUSTED rule id — plain text node. */}
              <span className="max-w-[10rem] truncate">{r}</span>
            </Badge>
          ))}
          {rules.length > 4 ? (
            <Badge variant="secondary">+{rules.length - 4}</Badge>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
};
