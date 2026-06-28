/**
 * Investigate — start an ad-hoc, agentic investigation of an entity.
 *
 * Submits POST /api/investigate ({ entity, group_by, source_surface, lookback })
 * and renders the returned Case as a rich verdict card: badge row, recommended
 * action, evidence, MITRE techniques, the reproduce query, and the risk
 * breakdown. A 400 "no events" response is rendered as a neutral empty state
 * (not a scary error) with a hint to widen the lookback. Each completed run is
 * kept in a small per-session history (sessionStorage).
 *
 * SECURITY: every value derived from the backend (titles, summaries, entity
 * values, evidence text, MITRE ids, the reproduce query, rule ids) is UNTRUSTED
 * and rendered as PLAIN text or inside <CodeBlock>/<InlineCode> — never via
 * dangerouslySetInnerHTML.
 */
import * as React from 'react';
import {
  Globe,
  User as UserIcon,
  Monitor,
  Play,
  Search,
  Save,
  ExternalLink,
  Megaphone,
  GitBranch,
  Clock,
  Telescope,
  History,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { Case, Entity, Evidence } from '@/lib/types';
import { api, ApiError } from '@/lib/api';
import { DASH, fmtMoney, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Button } from '@/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/ui/alert';
import { Skeleton } from '@/ui/skeleton';

import { PageHeader } from '@/soc/components/PageHeader';
import { EmptyState } from '@/soc/components/EmptyState';
import { BarList, type BarListItem } from '@/soc/components/BarList';
import { CodeBlock, InlineCode } from '@/soc/components/CodeBlock';
import {
  VerdictBadge,
  RiskBadge,
  ConfidenceBadge,
  StatusBadge,
} from '@/soc/components/badges';

import { CaseDetail } from '@/soc/pages/CaseDetail';
import type { Navigate } from '@/soc/router';

/* ---------------------------------------------------------------- consts --- */

/** sessionStorage key for the in-session investigation history. */
const RECENT_KEY = 'tlsoc.investigate.recent';
const RECENT_CAP = 6;

type EntityType = Entity['type'];

interface EntityOption {
  id: EntityType;
  label: string;
  placeholder: string;
  icon: LucideIcon;
}

const ENTITY_OPTIONS: EntityOption[] = [
  { id: 'ip', label: 'IP', placeholder: 'e.g. 10.0.0.5', icon: Globe },
  { id: 'user', label: 'User', placeholder: 'e.g. jdoe', icon: UserIcon },
  { id: 'host', label: 'Host', placeholder: 'e.g. web-prod-01', icon: Monitor },
];

interface LookbackOption {
  value: string;
  label: string;
}

const LOOKBACK_OPTIONS: LookbackOption[] = [
  { value: 'now-24h', label: 'Last 24 hours' },
  { value: 'now-7d', label: 'Last 7 days' },
  { value: 'now-30d', label: 'Last 30 days' },
];

/** A finished run in the session history. */
interface RunRecord {
  id: string;
  entity: Entity;
  lookback: string;
  case: Case;
}

/* ------------------------------------------------------------- helpers ----- */

function entityIcon(t: EntityType): LucideIcon {
  return ENTITY_OPTIONS.find((o) => o.id === t)?.icon ?? Telescope;
}

function lookbackLabelFor(value: string): string {
  return LOOKBACK_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

/** Round a factor to at most two decimals for the bar-list value label. */
function roundFactor(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Pull a numeric risk-factor map off the case (if the backend included one) and
 *  shape it as ranked rows for the shared `BarList`. */
function riskFactors(c: Case): BarListItem[] {
  const candidates = [
    c['risk_factors'],
    c['risk_breakdown'],
    c['risk_components'],
  ];
  for (const raw of candidates) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const out: BarListItem[] = [];
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        const n = typeof v === 'number' ? v : Number(v);
        if (!Number.isNaN(n)) {
          out.push({ label: humanizeToken(k), value: n });
        }
      }
      if (out.length) return out.sort((a, b) => b.value - a.value);
    }
  }
  return [];
}

/* ------------------------------------------------------------ result view -- */

const ResultCard: React.FC<{ c: Case; onOpen?: (caseId: string) => void }> = ({
  c,
  onOpen,
}) => {
  const entityLabel = c.entity
    ? `${humanizeToken(c.entity.type)} · ${c.entity.value}`
    : DASH;
  const evidence: Evidence[] = Array.isArray(c.evidence) ? c.evidence : [];
  const mitre: string[] = Array.isArray(c.mitre) ? c.mitre : [];
  const factors = riskFactors(c);
  const ruleIds: string[] = Array.isArray(c.rule_ids) ? c.rule_ids : [];

  return (
    <Card className="overflow-hidden">
      {/* Accent top bar tinted to the risk band */}
      <div className="h-1 w-full bg-accent-bar" aria-hidden />
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-lg">
            {c.title || `Investigation: ${entityLabel}`}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {c.entity ? (
              <>
                <span className="font-medium text-foreground">
                  {humanizeToken(c.entity.type)}
                </span>{' '}
                <InlineCode value={c.entity.value} />
              </>
            ) : (
              DASH
            )}
            <span className="mx-2 text-muted-foreground/50">·</span>
            updated {humanizeAge(c.updated_at || c.created_at)}
          </p>
        </div>
        {onOpen && c.case_id ? (
          <Button size="sm" onClick={() => onOpen(c.case_id)}>
            <ExternalLink className="h-4 w-4" />
            Open case
          </Button>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-5">
        {/* Badge row */}
        <div className="flex flex-wrap items-center gap-2">
          <VerdictBadge verdict={c.verdict} />
          <RiskBadge score={c.risk_score} />
          <ConfidenceBadge confidence={c.confidence} />
          <StatusBadge status={c.status} />
        </div>

        {/* Summary */}
        {c.summary ? (
          <p className="whitespace-pre-wrap text-sm text-foreground">{c.summary}</p>
        ) : null}

        {/* Recommended action */}
        {c.recommended_action ? (
          <Alert>
            <Megaphone className="h-4 w-4" />
            <AlertTitle>Recommended action</AlertTitle>
            <AlertDescription>
              <p className="whitespace-pre-wrap text-foreground">
                {c.recommended_action}
              </p>
            </AlertDescription>
          </Alert>
        ) : null}

        {/* Evidence */}
        {evidence.length ? (
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">Evidence</h4>
            <ul className="space-y-2">
              {evidence.map((ev, i) => (
                <li
                  key={i}
                  className="flex items-start gap-3 rounded-md border border-border bg-muted/30 px-3 py-2"
                >
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary"
                    aria-hidden
                  />
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm text-foreground">{ev.summary}</p>
                    {ev.event_ids && ev.event_ids.length ? (
                      <p className="text-xs text-muted-foreground">
                        {ev.event_ids.length} event
                        {ev.event_ids.length === 1 ? '' : 's'}
                      </p>
                    ) : null}
                    {ev.query ? (
                      <CodeBlock value={ev.query} caption="query" wrap />
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* MITRE */}
        {mitre.length ? (
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">
              MITRE ATT&amp;CK
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {mitre.map((m) => (
                <span
                  key={m}
                  className="inline-flex items-center gap-1 rounded border border-border bg-muted px-2 py-0.5 font-mono text-xs text-foreground"
                >
                  <GitBranch className="h-3 w-3 text-muted-foreground" aria-hidden />
                  {m}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {/* Risk breakdown */}
        {factors.length ? (
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">Risk breakdown</h4>
            <BarList items={factors} format={(n) => String(roundFactor(n))} />
          </section>
        ) : null}

        {/* Reproduce query */}
        {c.reproduce_query ? (
          <section className="space-y-2">
            <h4 className="text-sm font-semibold text-foreground">Reproduce query</h4>
            <CodeBlock value={c.reproduce_query} caption="reproduce" wrap />
          </section>
        ) : null}

        {/* Facts grid */}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 border-t border-border pt-4 text-sm sm:grid-cols-2">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Case ID</dt>
            <dd className="min-w-0 truncate text-right">
              <InlineCode value={c.case_id} />
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Entity</dt>
            <dd className="min-w-0 truncate text-right text-foreground">
              {entityLabel}
            </dd>
          </div>
          {ruleIds.length ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">Rules</dt>
              <dd className="min-w-0 truncate text-right">
                <InlineCode value={ruleIds.join(', ')} />
              </dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Members</dt>
            <dd className="text-right text-foreground">
              {String(c.member_event_ids?.length ?? 0)} events
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Token cost</dt>
            <dd className="text-right font-mono tabular-nums text-foreground">
              {fmtMoney(c.token_cost)}
            </dd>
          </div>
        </dl>

        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Save className="h-3.5 w-3.5" aria-hidden />
          Saved to the case queue — review it on the Cases tab.
        </p>
      </CardContent>
    </Card>
  );
};

/* ---------------------------------------------------------------- page ----- */

export interface InvestigateProps {
  onNavigate?: Navigate;
}

export default function Investigate({ onNavigate }: InvestigateProps = {}) {
  const [entityType, setEntityType] = React.useState<EntityType>('ip');
  const [entityValue, setEntityValue] = React.useState('');
  const [lookback, setLookback] = React.useState<string>('now-24h');

  const [result, setResult] = React.useState<Case | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<unknown>(null);
  const [noEvents, setNoEvents] = React.useState<{
    entity: Entity;
    lookback: string;
  } | null>(null);
  const [runningEntity, setRunningEntity] = React.useState<Entity | null>(null);
  const [emptySubmit, setEmptySubmit] = React.useState(false);
  const [openCaseId, setOpenCaseId] = React.useState<string | null>(null);

  // Hydrate the in-session history from sessionStorage so it survives a soft
  // navigation away and back within the same tab.
  const [recent, setRecent] = React.useState<RunRecord[]>(() => {
    try {
      const raw = sessionStorage.getItem(RECENT_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed)
        ? (parsed as RunRecord[]).slice(0, RECENT_CAP)
        : [];
    } catch {
      return [];
    }
  });

  // Persist the history whenever it changes (best-effort; quota-safe).
  React.useEffect(() => {
    try {
      sessionStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_CAP)));
    } catch {
      /* private mode / quota — history is non-essential. */
    }
  }, [recent]);

  // Seed the lookback from prefs.investigate_lookback once (best-effort).
  React.useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((s) => {
        if (cancelled) return;
        const lb = s?.prefs?.investigate_lookback;
        if (typeof lb === 'string' && LOOKBACK_OPTIONS.some((o) => o.value === lb)) {
          setLookback(lb);
        }
      })
      .catch(() => {
        /* advisory seed; keep the default lookback. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = React.useMemo(
    () => ENTITY_OPTIONS.find((o) => o.id === entityType) ?? ENTITY_OPTIONS[0],
    [entityType],
  );

  const run = React.useCallback(async () => {
    const value = entityValue.trim();
    if (!value) {
      setEmptySubmit(true);
      return;
    }
    if (loading) return;
    setEmptySubmit(false);
    const entity: Entity = { type: entityType, value };
    setLoading(true);
    setError(null);
    setResult(null);
    setNoEvents(null);
    setRunningEntity(entity);

    try {
      const c = await api.investigate({
        entity,
        group_by: entityType,
        source_surface: 'investigate',
        lookback,
      });
      setResult(c);
      setRecent((prev) =>
        [{ id: `${Date.now()}`, entity, lookback, case: c }, ...prev].slice(
          0,
          RECENT_CAP,
        ),
      );
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        // Neutral "no in-scope events" outcome, not a failure.
        setNoEvents({ entity, lookback });
      } else {
        setError(e);
      }
    } finally {
      setLoading(false);
      setRunningEntity(null);
    }
  }, [entityType, entityValue, lookback, loading]);

  const widenLookback = React.useCallback(() => {
    const idx = LOOKBACK_OPTIONS.findIndex((o) => o.value === lookback);
    const next = LOOKBACK_OPTIONS[Math.min(idx + 1, LOOKBACK_OPTIONS.length - 1)];
    setLookback(next.value);
    setNoEvents(null);
  }, [lookback]);

  const replayRecent = React.useCallback((r: RunRecord) => {
    setEntityType(r.entity.type);
    setEntityValue(r.entity.value);
    setLookback(r.lookback);
    setResult(r.case);
    setNoEvents(null);
    setError(null);
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void run();
  };

  const isLastLookback =
    lookback === LOOKBACK_OPTIONS[LOOKBACK_OPTIONS.length - 1].value;
  const errMessage =
    error instanceof Error ? error.message : 'Something went wrong.';

  return (
    <div className="animate-fade-in space-y-6">
      <PageHeader
        icon={Telescope}
        eyebrow="Ad-hoc triage"
        title="Investigate"
        description="Run an ad-hoc, agentic investigation on an IP, user, or host."
        actions={
          onNavigate ? (
            <Button variant="outline" size="sm" onClick={() => onNavigate('cases')}>
              View cases
            </Button>
          ) : undefined
        }
      />

      {/* Form */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-12 md:items-end">
            {/* Entity type */}
            <div className="space-y-1.5 md:col-span-4">
              <Label>Entity type</Label>
              <div
                role="radiogroup"
                aria-label="Entity type"
                className="inline-flex w-full rounded-md border border-border p-0.5"
              >
                {ENTITY_OPTIONS.map((o) => {
                  const Icon = o.icon;
                  const active = o.id === entityType;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setEntityType(o.id)}
                      className={cn(
                        'inline-flex flex-1 items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active
                          ? 'bg-primary text-primary-foreground shadow-elev1'
                          : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                      )}
                    >
                      <Icon className="h-4 w-4" aria-hidden />
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Entity value */}
            <div className="space-y-1.5 md:col-span-4">
              <Label htmlFor="investigate-entity">{selected.label} value</Label>
              <Input
                id="investigate-entity"
                placeholder={selected.placeholder}
                value={entityValue}
                onChange={(e) => {
                  setEntityValue(e.target.value);
                  if (emptySubmit && e.target.value.trim()) setEmptySubmit(false);
                }}
                onKeyDown={onKeyDown}
                aria-invalid={emptySubmit || undefined}
                aria-label={`${selected.label} to investigate`}
                className={cn(emptySubmit && 'border-critical focus-visible:ring-critical')}
              />
              {emptySubmit ? (
                <p className="text-xs text-critical">
                  Enter a {selected.label.toLowerCase()} value to investigate.
                </p>
              ) : null}
            </div>

            {/* Lookback */}
            <div className="space-y-1.5 md:col-span-2">
              <Label>Lookback</Label>
              <Select value={lookback} onValueChange={setLookback}>
                <SelectTrigger aria-label="Lookback window">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOOKBACK_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Run */}
            <div className="md:col-span-2">
              <Button
                className="w-full"
                onClick={() => void run()}
                disabled={loading || (!entityValue.trim() && !emptySubmit)}
              >
                <Play className="h-4 w-4" />
                {loading ? 'Running…' : 'Run investigation'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Loading */}
      {loading ? (
        <Card>
          <CardContent className="space-y-4 pt-6">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Search className="h-4 w-4 animate-pulse" aria-hidden />
              Investigating{' '}
              <span className="font-medium text-foreground">
                {runningEntity?.value ?? selected.label}
              </span>{' '}
              … correlating events, enriching, reasoning
            </div>
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      ) : null}

      {/* Hard error */}
      {!loading && error ? (
        <Alert variant="destructive">
          <AlertTitle>Investigation failed</AlertTitle>
          <AlertDescription>{errMessage}</AlertDescription>
        </Alert>
      ) : null}

      {/* Neutral no-events empty state */}
      {!loading && noEvents ? (
        <Card>
          <EmptyState
            icon={Search}
            title={`No in-scope events for ${noEvents.entity.type}:${noEvents.entity.value}`}
            description={`Nothing matched in ${lookbackLabelFor(
              noEvents.lookback,
            )}. The activity may be older, or outside the configured scope. Try widening the lookback window.`}
            action={
              !isLastLookback ? (
                <Button variant="outline" onClick={widenLookback}>
                  <Clock className="h-4 w-4" />
                  Widen lookback
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : null}

      {/* Result */}
      {!loading && result ? (
        <ResultCard c={result} onOpen={setOpenCaseId} />
      ) : null}

      {/* Idle empty state */}
      {!loading && !result && !error && !noEvents ? (
        <Card>
          <EmptyState
            icon={Telescope}
            title="Investigate an entity"
            description={`Pick an entity type, enter a value (e.g. ${selected.placeholder.replace(
              'e.g. ',
              '',
            )}), and run an investigation over ${lookbackLabelFor(
              lookback,
            ).toLowerCase()}.`}
          />
        </Card>
      ) : null}

      {/* Recent (this session) */}
      {recent.length ? (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" aria-hidden />
            <h3 className="text-sm font-semibold text-foreground">
              Recent investigations (this session)
            </h3>
          </div>
          <ul className="space-y-2">
            {recent.map((r) => {
              const Icon = entityIcon(r.entity.type);
              return (
                <li key={r.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => replayRecent(r)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        replayRecent(r);
                      }
                    }}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 shadow-elev1 transition-colors',
                      'hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    )}
                  >
                    <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-primary">
                      <Icon className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">
                        {humanizeToken(r.entity.type)}:{r.entity.value}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {r.case.title || r.case.case_id} ·{' '}
                        {lookbackLabelFor(r.lookback)}
                      </p>
                    </div>
                    <VerdictBadge verdict={r.case.verdict} />
                    <RiskBadge score={r.case.risk_score} />
                    {r.case.case_id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenCaseId(r.case.case_id);
                        }}
                        aria-label={`Open case ${r.case.case_id}`}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Case detail sheet — opened from the result card or a recent row. */}
      <CaseDetail
        caseId={openCaseId}
        onClose={() => setOpenCaseId(null)}
        onNavigate={onNavigate}
      />
    </div>
  );
}
