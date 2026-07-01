/**
 * CaseDetail — Overview panel (Coupling-D split).
 *
 * The default tab: run-meta strip, four honest triage chips (#12), verdict/confidence
 * headlines, incident digest, affected assets + IOC indicators, evidence findings,
 * recommended action + risk breakdown, MITRE, related cases + source breakdown (F6),
 * threshold automation applied (F10), and the append-only status timeline (F8).
 *
 * SECURITY (#9): every case-derived value (title, summary, entity, IPs, rules,
 * queries, evidence, tags, source ids, enrichment) is UNTRUSTED — rendered as plain
 * text or inside <CodeBlock>/badges, never as markup or a CSS/href value.
 * #3: this panel is read-only; it never decides or mutates the case.
 */
import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  BookOpen,
  CheckCircle2,
  Crosshair,
  FileText,
  Gauge,
  GitBranch,
  Globe,
  History,
  Info,
  Link2,
  Lock,
  Search,
  Shield,
  Tag,
  Target,
  User,
  Zap,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { Case } from '@/lib/types';
import { DASH, fmtMoney, formatTimestamp, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';
import { Separator } from '@/ui/separator';

import { BarList, type BarListItem } from '@/soc/components/BarList';
import { EmptyState } from '@/soc/components/EmptyState';
import { CodeBlock } from '@/soc/components/CodeBlock';
import {
  VerdictBadge,
  StatusBadge,
  DispositionBadge,
  RiskBadge,
  ConfidenceBadge,
} from '@/soc/components/badges';
import { CaseTriageHeader } from '@/soc/components/CaseTriageHeader';
import type { TriageChips } from '@/soc/pages/CaseDetail.api';
import type { Navigate } from '@/soc/router';

import {
  type FpPolicy,
  type ScoreTone,
  HeadlinePanel,
  MetaItem,
  PanelCard,
  SectionHeading,
  confidenceCalibration,
  confidenceHeadline,
  verdictHeadline,
} from './shared';

const RULED_OUT_RE =
  /\b(no\s+(match|evidence|sign|indicat|hit|result)|not\s+(malicious|found|present|observed)|ruled\s+out|clean|benign|negative|nothing\s+(found|suspicious)|false\s+positive|cleared)\b/i;

function isRuledOut(summary?: string): boolean {
  return !!summary && RULED_OUT_RE.test(summary);
}

/* ------------------------------------------------------- status timeline -- */

/** Append-only lifecycle transition trail (F8). `by`/`reason` are operator/agent
 *  text — rendered as plain text (#9). Renders nothing when empty. */
const StatusTimeline: React.FC<{
  history?: Case['status_history'];
  statusReason?: string;
}> = ({ history, statusReason }) => {
  const entries = Array.isArray(history) ? history : [];
  if (!entries.length && !statusReason) return null;
  // Newest last (chronological), reversed for newest-first display.
  const ordered = [...entries].reverse();
  return (
    <PanelCard>
      <SectionHeading icon={History}>
        Status timeline
      </SectionHeading>
      {statusReason ? (
        <p className="mb-3 text-xs text-muted-foreground">
          {/* UNTRUSTED status reason — plain text. */}
          Current reason: <span className="text-foreground/90">{statusReason}</span>
        </p>
      ) : null}
      {ordered.length ? (
        <ol className="relative space-y-4 border-l border-border pl-5">
          {ordered.map((e, i) => (
            <li key={`${e.at}-${i}`} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[1.4rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-card bg-primary"
              />
              <div className="flex flex-wrap items-center gap-2">
                {e.from_status ? <StatusBadge status={e.from_status} /> : null}
                <span className="text-xs text-muted-foreground">{DASH}</span>
                <StatusBadge status={e.to_status} />
                <span className="text-xs text-muted-foreground">
                  {e.at ? humanizeAge(e.at) : ''}
                  {e.by ? <> · {humanizeToken(e.by)}</> : null}
                </span>
              </div>
              {e.reason ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {/* UNTRUSTED — plain text. */}
                  {e.reason}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No lifecycle transitions recorded yet.</p>
      )}
    </PanelCard>
  );
};

/* ----------------------------------------- related cases + source breakdown */

/**
 * Cross-source linkage panel (F6). Renders RELATED cases (never merged) + a source
 * breakdown when present. Related-case titles are fetched best-effort for nicer
 * labels; all case-derived text is UNTRUSTED → plain text. Renders nothing when no
 * cross-source data is present, so it is fully additive to the overview.
 */
const RelatedCrossSource: React.FC<{ c: Case; onNavigate?: Navigate }> = ({ c, onNavigate }) => {
  const relatedIds = React.useMemo(
    () =>
      (Array.isArray(c.related_case_ids) ? c.related_case_ids : []).filter(
        (rid): rid is string => typeof rid === 'string' && !!rid && rid !== c.case_id,
      ),
    [c.related_case_ids, c.case_id],
  );
  const breakdown = React.useMemo(() => {
    const b = c.source_breakdown;
    if (!b || typeof b !== 'object') return [] as Array<[string, number]>;
    return Object.entries(b)
      .filter(([, v]) => typeof v === 'number')
      .sort((a, bb) => bb[1] - a[1]);
  }, [c.source_breakdown]);

  // Best-effort titles for the related case ids (fetch the recent list, map by id).
  const [titles, setTitles] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    if (!relatedIds.length) return;
    let cancelled = false;
    void api
      .listCases({ limit: 200 })
      .then((res) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const rc of res.cases) {
          if (relatedIds.includes(rc.case_id)) {
            map[rc.case_id] = rc.title || rc.case_number || rc.case_id;
          }
        }
        setTitles(map);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [relatedIds]);

  if (!relatedIds.length && !breakdown.length && !c.cross_source_cluster_id) return null;

  const openRelated = (rid: string) => {
    if (onNavigate) onNavigate('cases', { caseId: rid });
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <PanelCard>
        <SectionHeading icon={GitBranch}>
          Related cases
        </SectionHeading>
        {relatedIds.length ? (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              Grouped by a shared entity across sources within the cross-source window. These are
              RELATED — they are never merged into this case.
            </p>
            <ul className="space-y-2">
              {relatedIds.map((rid) => (
                <li key={rid} className="flex items-center gap-2">
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <button
                    type="button"
                    onClick={() => openRelated(rid)}
                    disabled={!onNavigate}
                    className={cn(
                      'truncate rounded-sm text-left text-sm',
                      onNavigate
                        ? 'text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                        : 'cursor-default text-foreground',
                    )}
                    title={titles[rid] || rid}
                  >
                    {/* UNTRUSTED title / id — plain text. */}
                    {titles[rid] || rid}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No related cases.</p>
        )}
        {c.cross_source_cluster_id ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Cross-source group{' '}
            {/* UNTRUSTED id — plain text, mono. */}
            <span className="font-mono text-foreground/80">{c.cross_source_cluster_id}</span>
          </p>
        ) : null}
      </PanelCard>

      <PanelCard>
        <SectionHeading icon={Globe}>
          Source breakdown
        </SectionHeading>
        {breakdown.length ? (
          <dl className="divide-y divide-border">
            {breakdown.map(([sid, count]) => (
              <div
                key={sid}
                className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
              >
                {/* UNTRUSTED source id — plain text, truncated. */}
                <dt className="truncate font-mono text-xs text-foreground" title={sid}>
                  {sid}
                </dt>
                <dd className="shrink-0">
                  <Badge variant="outline" className="tabular-nums">
                    {count}
                  </Badge>
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">Single source.</p>
        )}
      </PanelCard>
    </div>
  );
};

/* ----------------------------------------------- threshold automation (F10) */

/** Map an automation action verb → label + icon + tone. */
const AUTOMATION_META: Record<
  string,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: ScoreTone }
> = {
  tag: { label: 'Tagged', icon: Tag, tone: 'info' },
  recommend: { label: 'Recommendation', icon: Info, tone: 'medium' },
  notify: { label: 'Notified', icon: Bell, tone: 'info' },
  run_playbook: { label: 'Queued playbook', icon: BookOpen, tone: 'low' },
  request_approval: { label: 'Proposed (needs approval)', icon: Lock, tone: 'high' },
};

/**
 * Shows the SAFE actions threshold automation applied to this case (F10). Renders
 * nothing when none ran. These are non-binding: automation can tag / recommend /
 * notify / queue a re-investigation / draft a Proposal, but NEVER sets the case
 * status or auto-closes — the close/escalate decision is always deterministic. All
 * detail text is operator/agent-authored → plain text (#9).
 */
const AutomationApplied: React.FC<{ c: Case }> = ({ c }) => {
  const actions = Array.isArray(c.automation_actions) ? c.automation_actions : [];
  if (!actions.length) return null;
  return (
    <PanelCard>
      <SectionHeading icon={Zap}>
        Automation applied
      </SectionHeading>
      <p className="mb-3 text-xs text-muted-foreground">
        Threshold-automation actions taken after the deterministic decision. These are
        non-binding — automation can tag, recommend, notify, queue a re-investigation, or draft a
        proposal, but it never changes the lifecycle status or auto-closes a case.
      </p>
      <ul className="space-y-2">
        {actions.map((a, i) => {
          const meta = AUTOMATION_META[String(a.action || '')] || {
            label: humanizeToken(String(a.action || 'Action')),
            icon: Zap,
            tone: 'info' as ScoreTone,
          };
          const Icon = meta.icon;
          return (
            <li
              key={`${a.rule_id || a.action || i}-${i}`}
              className="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm"
            >
              <Badge variant={meta.tone === 'low' ? 'success' : meta.tone} className="shrink-0 gap-1">
                <Icon className="h-3 w-3" />
                {meta.label}
              </Badge>
              <div className="min-w-0 flex-1">
                {a.detail ? (
                  /* UNTRUSTED — plain text. */
                  <p className="whitespace-pre-wrap text-foreground/90">{a.detail}</p>
                ) : null}
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {a.rule_id ? <span className="font-mono">rule {a.rule_id}</span> : null}
                  {a.proposal_id ? (
                    <span className="font-mono">proposal {a.proposal_id}</span>
                  ) : null}
                  {a.at ? <span>{humanizeAge(a.at)}</span> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </PanelCard>
  );
};

export const OverviewPanel: React.FC<{
  c: Case;
  fpPolicy: FpPolicy;
  triage: TriageChips | null;
  triageLoading: boolean;
  onNavigate?: Navigate;
}> = ({ c, fpPolicy, triage, triageLoading, onNavigate }) => {
  const trigger = c.trigger_reason as { sentence?: string } | undefined;
  const triggerSentence = trigger?.sentence;
  const allEvidence = c.evidence || [];
  const ruledOut = allEvidence.filter((e) => isRuledOut(e.summary));
  const evidence = allEvidence.filter((e) => !isRuledOut(e.summary));
  const mitre = c.mitre || [];

  const ruleIds = (c.rule_ids || []).filter((r) => typeof r === 'string' && r.trim());

  // Verdict + confidence headline panels (kept). Severity / impact / priority are now
  // the four-chip CaseTriageHeader (#12) — honestly distinct, no longer all = risk.
  const verdictH = verdictHeadline(c.verdict);
  const confH = confidenceHeadline(c.confidence);

  // Affected assets (entity + enrichment KV).
  const caseEnrichment =
    c.enrichment && typeof c.enrichment === 'object'
      ? (c.enrichment as Record<string, unknown>)
      : null;
  const entityType = c.entity?.type || c.entity_type || null;

  // Run-meta strip values (best-effort, UNTRUSTED).
  const startedAt = c.created_at;
  const completedAt = c.updated_at;
  const profile = c.playbook_id || (c.agent_persona && c.agent_persona !== 'generalist'
    ? humanizeToken(c.agent_persona)
    : null);

  // Auto-close explanation line.
  const autoCloseLine = ((): string | null => {
    if (!fpPolicy || typeof fpPolicy.min_confidence !== 'number') return null;
    const v = (c.verdict || '').toLowerCase();
    const isFp = v.includes('false') || v === 'fp' || v.includes('benign');
    if (!fpPolicy.enabled) {
      return 'False-positive auto-close is disabled — this case was held for a human regardless of confidence.';
    }
    if (!isFp) {
      return 'NEEDS_HUMAN and true-positive verdicts never auto-close — the auto-close bar applies to false positives only.';
    }
    const conf = typeof c.confidence === 'number' ? c.confidence : null;
    const risk = typeof c.risk_score === 'number' ? c.risk_score : null;
    const confOk = conf !== null && conf >= fpPolicy.min_confidence;
    const riskOk =
      typeof fpPolicy.max_risk_score !== 'number' ||
      (risk !== null && risk <= fpPolicy.max_risk_score);
    const bar = fpPolicy.min_confidence.toFixed(2);
    if (confOk && riskOk) {
      return `Eligible for auto-close: confidence is at/above the ${bar} bar and risk is within the policy ceiling.`;
    }
    if (!confOk) return `Below the ${bar} auto-close confidence bar — held for a human.`;
    return 'Above the confidence bar but risk exceeds the auto-close ceiling — held for a human.';
  })();

  const rb = c.risk_breakdown as
    | {
        volume?: number;
        velocity?: number;
        reputation?: number;
        diversity?: number;
        asset_criticality?: number;
        total?: number;
      }
    | undefined;

  const riskItems = React.useMemo<BarListItem[]>(() => {
    if (!rb) return [];
    const comps: Array<{ label: string; value: number }> = [
      { label: 'Volume', value: rb.volume ?? 0 },
      { label: 'Velocity', value: rb.velocity ?? 0 },
      { label: 'Reputation', value: rb.reputation ?? 0 },
      { label: 'Diversity', value: rb.diversity ?? 0 },
      { label: 'Asset criticality', value: rb.asset_criticality ?? 0 },
    ];
    const barColor = (n: number) =>
      n >= 80 ? 'bg-critical' : n >= 60 ? 'bg-high' : n >= 35 ? 'bg-medium' : 'bg-low';
    return comps.map((x) => ({ ...x, color: barColor(x.value) }));
  }, [rb]);

  // Affected-asset KV rows (hostname/user from entity + enrichment scalars).
  const assetRows: Array<{ k: string; v: string }> = [];
  if (c.entity) {
    assetRows.push({
      k: entityType === 'host' ? 'Hostname' : entityType === 'user' ? 'User Name' : entityType === 'ip' ? 'IP Address' : humanizeToken(entityType || 'Entity'),
      v: c.entity.value,
    });
  }
  if (caseEnrichment) {
    for (const [k, v] of Object.entries(caseEnrichment)) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      assetRows.push({ k: humanizeToken(k), v: String(v) });
    }
  }

  return (
    <div className="space-y-6 p-6">
      {/* ----------------------------------------------- run-meta strip */}
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
        <MetaItem label="Started" value={startedAt ? formatTimestamp(startedAt) : DASH} />
        <MetaItem label="Completed" value={completedAt ? formatTimestamp(completedAt) : DASH} />
        {ruleIds.length ? <MetaItem label="Trigger" value={ruleIds[0]} /> : null}
        {profile ? <MetaItem label="Profile" value={profile} /> : null}
      </div>

      {/* ------------------------------- the four honest triage chips (#12) */}
      <CaseTriageHeader chips={triage} loading={triageLoading} />

      {/* verdict + confidence headline (kept; severity/impact/priority moved into
          the four-chip header above so each signal is honestly distinct). */}
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <HeadlinePanel label="Verdict" value={verdictH.label} tone={verdictH.tone} />
        <HeadlinePanel label="Confidence" value={confH.label} tone={confH.tone} />
      </div>

      {/* secondary badge row (precise values) */}
      <div className="flex flex-wrap items-center gap-2">
        <VerdictBadge verdict={c.verdict} />
        <StatusBadge status={c.status} />
        <DispositionBadge disposition={c.disposition ?? null} />
        {typeof c.escalation_level === 'number' && c.escalation_level > 0 ? (
          <Badge variant="critical" className="gap-1">
            <Bell className="h-3 w-3" />
            Escalation L{c.escalation_level}
          </Badge>
        ) : null}
        <RiskBadge score={c.risk_score} />
        <ConfidenceBadge
          confidence={c.confidence}
          {...confidenceCalibration(fpPolicy, c.verdict)}
        />
        {c.source_name || c.source_id ? (
          <Badge variant="outline" className="gap-1">
            <Globe className="h-3 w-3" />
            {/* UNTRUSTED source name — plain text node. */}
            <span className="max-w-[12rem] truncate">{c.source_name || c.source_id}</span>
          </Badge>
        ) : null}
        {c.agent_persona && c.agent_persona !== 'generalist' ? (
          <Badge variant="outline" className="gap-1">
            <User className="h-3 w-3" />
            {humanizeToken(c.agent_persona)}
          </Badge>
        ) : null}
      </div>

      {/* ----------------------------------------------- incident digest */}
      {c.summary || triggerSentence ? (
        <PanelCard>
          <SectionHeading icon={FileText}>
            Incident Digest
          </SectionHeading>
          {triggerSentence ? (
            <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
              {/* UNTRUSTED — plain text. */}
              {triggerSentence}
            </p>
          ) : null}
          {c.summary ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {/* UNTRUSTED — plain text. */}
              {c.summary}
            </p>
          ) : null}
        </PanelCard>
      ) : null}

      {autoCloseLine ? (
        <Alert>
          <Lock className="h-4 w-4" />
          <AlertTitle>Auto-close policy</AlertTitle>
          <AlertDescription>{autoCloseLine}</AlertDescription>
        </Alert>
      ) : null}

      {/* ------------------------------- affected assets + IOC indicators */}
      <div className="grid gap-6 lg:grid-cols-2">
        <PanelCard>
          <SectionHeading icon={Crosshair}>
            Affected Assets
          </SectionHeading>
          {assetRows.length ? (
            <dl className="divide-y divide-border">
              {assetRows.map((row, i) => (
                <div
                  key={`${row.k}-${i}`}
                  className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                >
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {row.k}
                  </dt>
                  {/* UNTRUSTED value — plain text node, mono. */}
                  <dd className="truncate text-right font-mono text-sm text-foreground">
                    {row.v}
                  </dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">No assets recorded.</p>
          )}
        </PanelCard>

        <PanelCard>
          <SectionHeading icon={Target}>
            IOC Indicators
          </SectionHeading>
          {evidence.some((e) => e.query) || c.reproduce_query ? (
            <div className="space-y-3">
              {evidence
                .filter((e) => e.query)
                .map((e, i) => (
                  <div key={i} className="space-y-1.5">
                    <Badge variant="outline" className="font-mono">
                      Command Line
                    </Badge>
                    {/* UNTRUSTED query — inside CodeBlock fence. */}
                    <CodeBlock value={e.query} copyable wrap maxHeightClassName="max-h-40" />
                    {e.summary ? (
                      <p className="text-xs text-muted-foreground">{e.summary}</p>
                    ) : null}
                  </div>
                ))}
              {c.reproduce_query ? (
                <div className="space-y-1.5">
                  <Badge variant="outline" className="font-mono">
                    Reproduce query
                  </Badge>
                  <CodeBlock
                    value={c.reproduce_query}
                    caption="read-only"
                    wrap
                    maxHeightClassName="max-h-40"
                  />
                </div>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No indicators recorded.</p>
          )}
        </PanelCard>
      </div>

      {/* ------------------------------------------- evidence findings */}
      <div>
        <SectionHeading icon={Search}>
          Evidence Findings
        </SectionHeading>
        {evidence.length === 0 ? (
          <EmptyState
            icon={Search}
            compact
            title="No positive findings"
            description={
              ruledOut.length
                ? 'All evidence was checked and cleared (see "Checked & clean" below).'
                : 'No evidence recorded for this case.'
            }
          />
        ) : (
          <div className="space-y-3">
            {evidence.map((ev, i) => (
              <PanelCard key={i}>
                <div className="mb-3 flex items-start justify-between gap-3">
                  {/* UNTRUSTED summary as the finding subject — plain text. */}
                  <h4 className="text-sm font-semibold text-foreground">
                    {ev.summary ? ev.summary.split('.')[0] : `Evidence ${i + 1}`}
                  </h4>
                  <Badge variant="info" className="shrink-0">
                    {ev.event_ids && ev.event_ids.length
                      ? `${ev.event_ids.length} event${ev.event_ids.length === 1 ? '' : 's'}`
                      : 'Finding'}
                  </Badge>
                </div>
                <dl className="space-y-2 text-sm">
                  {c.entity?.value ? (
                    <div className="grid grid-cols-[7rem_1fr] gap-2">
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Subject
                      </dt>
                      {/* UNTRUSTED — plain text. */}
                      <dd className="font-mono text-foreground">{c.entity.value}</dd>
                    </div>
                  ) : null}
                  {ev.query ? (
                    <div className="grid grid-cols-[7rem_1fr] gap-2">
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Evidence
                      </dt>
                      <dd>
                        <CodeBlock value={ev.query} copyable wrap maxHeightClassName="max-h-32" />
                      </dd>
                    </div>
                  ) : null}
                  {ev.summary ? (
                    <div className="grid grid-cols-[7rem_1fr] gap-2">
                      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Conclusion
                      </dt>
                      {/* UNTRUSTED — plain text. */}
                      <dd className="whitespace-pre-wrap text-muted-foreground">{ev.summary}</dd>
                    </div>
                  ) : null}
                </dl>
              </PanelCard>
            ))}
          </div>
        )}
      </div>

      {/* ------------------------------------------- ruled out / clean */}
      {ruledOut.length ? (
        <PanelCard>
          <SectionHeading icon={CheckCircle2}>
            Ruled out / Checked &amp; clean
          </SectionHeading>
          <p className="mb-3 text-xs text-muted-foreground">
            Negative findings — what the investigation checked and cleared.
          </p>
          <ul className="space-y-2">
            {ruledOut.map((ev, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                {/* UNTRUSTED — plain text. */}
                <span className="whitespace-pre-wrap text-foreground/90">
                  {ev.summary || `Checked item ${i + 1}`}
                </span>
              </li>
            ))}
          </ul>
        </PanelCard>
      ) : null}

      {/* ------------------------------- recommended action + risk breakdown */}
      <div className="grid gap-6 lg:grid-cols-2">
        <PanelCard>
          <SectionHeading icon={Activity}>
            Recommended action
          </SectionHeading>
          {/* UNTRUSTED — plain text. */}
          <p className="whitespace-pre-wrap text-sm text-foreground/90">
            {c.recommended_action || DASH}
          </p>
        </PanelCard>
        <PanelCard>
          <SectionHeading icon={Gauge}>
            Risk breakdown
          </SectionHeading>
          {riskItems.length ? (
            <BarList items={riskItems} format={(n) => String(Math.round(n))} showPercent />
          ) : (
            <p className="text-sm text-muted-foreground">No risk breakdown recorded.</p>
          )}
          {rb && typeof rb.total === 'number' ? (
            <>
              <Separator className="my-3" />
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Total</span>
                <RiskBadge score={rb.total} label="" />
              </div>
            </>
          ) : null}
        </PanelCard>
      </div>

      {/* ------------------------------------------- MITRE */}
      {mitre.length ? (
        <PanelCard>
          <SectionHeading icon={Shield}>
            MITRE ATT&amp;CK techniques
          </SectionHeading>
          <div className="flex flex-wrap gap-2">
            {mitre.map((m, i) => (
              <Badge key={`${m}-${i}`} variant="outline" className="font-mono">
                {m}
              </Badge>
            ))}
          </div>
        </PanelCard>
      ) : null}

      {/* --------------------------- related cases + source breakdown (F6) */}
      <RelatedCrossSource c={c} onNavigate={onNavigate} />

      {/* ------------------------------- threshold automation (F10) */}
      <AutomationApplied c={c} />

      {/* ------------------------------------------- status timeline */}
      <StatusTimeline history={c.status_history} statusReason={c.status_reason} />

      {/* ------------------------------------------- footer meta */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
        <span>Created {formatTimestamp(c.created_at)}</span>
        <span>Token cost {fmtMoney(c.token_cost)}</span>
        {c.decision_by ? <span>Decided by {humanizeToken(c.decision_by)}</span> : null}
      </div>

      {c.error ? (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Investigation error</AlertTitle>
          {/* UNTRUSTED — plain text. */}
          <AlertDescription className="whitespace-pre-wrap">{c.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
};

export default OverviewPanel;
