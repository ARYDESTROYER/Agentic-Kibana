/**
 * CaseDetail — Overview panel (Coupling-D split).
 *
 * The default tab, structured so a reader can tell WHAT THE SOURCE REPORTED apart from
 * WHAT WE ASSESSED — the two never share a container or visual weight (task 6). Four
 * scannable bands, the first two PEER sections differentiated by a header ProvenanceTag
 * + a left accent rail (never by size):
 *   REPORTED BY SOURCE — <ProvenanceTag kind="source"> (SIEM), cool rail. ONLY source-
 *               provided facts: the source-asserted severity ("severity per the source
 *               was High"), detection rule(s), source name, source event time, the
 *               trigger sentence, affected assets, and the read-only search queries.
 *   OUR ASSESSMENT     — <ProvenanceTag kind="ai"/"code">, warm rail. Product-derived
 *               analysis: risk/impact/priority chips (code), verdict + confidence (ai),
 *               disposition, incident summary + recommended action (ai), a compact
 *               MITRE summary, the auto-close policy note (code), the anomaly baseline,
 *               and the pinned deterministic <DecisionCard> as the trust anchor. A DELTA
 *               CUE bridges the two when the source severity and our risk band disagree.
 *   EVIDENCE   — evidence findings + ruled-out / clean.
 *   PROVENANCE & ACTIVITY — related cases + source breakdown (F6), threshold automation
 *               applied (F10), the append-only status timeline (F8), and run/cost meta.
 *
 * SECURITY (#9): every case-derived value (title, summary, entity, IPs, rules,
 * queries, evidence, tags, source ids, enrichment) is UNTRUSTED — rendered as plain
 * text or inside <CodeBlock>/badges, never as markup or a CSS/href value.
 * #3: this panel is read-only; it never decides or mutates the case — the DecisionCard
 * only PROJECTS the deterministic `decide()` result recorded on the case.
 */
import * as React from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bell,
  BookOpen,
  CheckCircle2,
  Crosshair,
  Database,
  FileText,
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
  Zap,
} from 'lucide-react';

import { api } from '@/lib/api';
import type { Case } from '@/lib/types';
import { DASH, fmtMoney, formatTimestamp, humanizeAge, humanizeToken } from '@/lib/format';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/ui/alert';

import { scoreBand, type ScoreBand } from '@/soc/components/palette';
import { EmptyState } from '@/soc/components/EmptyState';
import { CodeBlock } from '@/soc/components/CodeBlock';
import {
  VerdictBadge,
  StatusBadge,
  DispositionBadge,
  ConfidenceBadge,
  SeverityBadge,
  severityBand,
} from '@/soc/components/badges';
import { ProvenanceTag, severityProvenance } from '@/soc/components/ProvenanceTag';
import { CaseTriageHeader } from '@/soc/components/CaseTriageHeader';
import { DecisionCard } from './DecisionCard';
import { BaselineSignatureCard } from '@/soc/components/BaselineGauge';
import type { TriageChips } from '@/soc/pages/CaseDetail.api';
import { baselineApi, type BaselineSignature } from '@/soc/Baseline.api';
import type { Navigate } from '@/soc/router';

import {
  type FpPolicy,
  type ScoreTone,
  MetaItem,
  PanelCard,
  SectionHeading,
  confidenceCalibration,
} from './shared';

const RULED_OUT_RE =
  /\b(no\s+(match|evidence|sign|indicat|hit|result)|not\s+(malicious|found|present|observed)|ruled\s+out|clean|benign|negative|nothing\s+(found|suspicious)|false\s+positive|cleared)\b/i;

function isRuledOut(summary?: string): boolean {
  return !!summary && RULED_OUT_RE.test(summary);
}

/* -------------------------------------------------------------------- band -- */

/**
 * A labelled visual band grouping related sections. Presentational only — an uppercase
 * label + an optional header ProvenanceTag legend + a quiet divider, plus an optional
 * LEFT ACCENT RAIL. The two peer sections ("Reported by source" cool / "Our assessment"
 * warm) are told apart by the rail + the legend — never by size (task 6).
 */
type BandAccent = 'source' | 'assessment' | 'none';

const BAND_ACCENT: Record<BandAccent, string> = {
  // A thin left rail marks the source-vs-assessment provenance without changing weight.
  source: 'border-l-2 border-info/40 pl-4',
  assessment: 'border-l-2 border-primary/40 pl-4',
  none: '',
};

const Band: React.FC<{
  label: string;
  provenance?: React.ReactNode;
  accent?: BandAccent;
  children: React.ReactNode;
}> = ({ label, provenance, accent = 'none', children }) => (
  <section className={cn('space-y-6', BAND_ACCENT[accent])}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span
        data-testid="overview-band-label"
        className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground"
      >
        {label}
      </span>
      {provenance ? <span className="flex items-center gap-1">{provenance}</span> : null}
      <span aria-hidden="true" className="h-px flex-1 bg-border" />
    </div>
    {children}
  </section>
);

/** Title-case a lowercase band token for prose ("high" → "High"). */
function titleBand(band: string): string {
  return band ? band.charAt(0).toUpperCase() + band.slice(1) : band;
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
        <EmptyState icon={History} compact title="No lifecycle transitions recorded yet" />
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
          <EmptyState icon={GitBranch} compact title="No related cases" />
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
                {/* UNTRUSTED source id — plain text, truncated. `min-w-0` lets the flex
                    child shrink below content width so `truncate` actually ellipsizes. */}
                <dt className="min-w-0 truncate font-mono text-xs text-foreground" title={sid}>
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

/**
 * The severity-token bar color for a 0-100 risk FACTOR. Uses the ONE palette ladder
 * (`scoreBand` — 74/48/22) so a factor bar shares cut-points with every other
 * risk-coloured element (RiskBadge/RiskGauge/posture) instead of a local ad-hoc
 * 80/60/35 ladder. Literal class strings so the Tailwind JIT emits them.
 */
const FACTOR_BAR_COLOR: Record<ScoreBand, string> = {
  critical: 'bg-critical',
  high: 'bg-high',
  medium: 'bg-medium',
  low: 'bg-low',
};

export function riskFactorBarColor(value: number): string {
  return FACTOR_BAR_COLOR[scoreBand(value)];
}

/* ----------------------------------------------- anomaly baseline (advisory) */

/**
 * Advisory anomaly-baseline panel (#4). When the case has a cluster signature AND the
 * baseline has recorded stats for it, this embeds the ready-made `BaselineSignatureCard`
 * so an operator can audit the warm-up state + learned percentiles inline on the case.
 *
 * Fully additive + FAIL-QUIET, mirroring `RelatedCrossSource`'s best-effort pattern:
 * no cluster signature, a disabled baseline, an unseen signature (`found=false`), or a
 * fetch error all render NOTHING — the baseline is off by default, so the common case
 * never grows a stray empty section. READ-ONLY / advisory (#3/#4): a warm-up state can
 * never close or escalate a case. `signature` is source-derived and the card renders it
 * as a plain text node only (#9).
 */
const BaselineAdvisory: React.FC<{ c: Case }> = ({ c }) => {
  const signature =
    typeof c.cluster_signature === 'string' ? c.cluster_signature.trim() : '';
  const [data, setData] = React.useState<BaselineSignature | null>(null);

  React.useEffect(() => {
    if (!signature) {
      setData(null);
      return;
    }
    let cancelled = false;
    // Best-effort (a synchronous stub failure surfaces as a rejection via the
    // Promise.resolve() in Baseline.api) — a failure/disabled baseline just renders
    // nothing rather than breaking the overview.
    void baselineApi
      .signature(signature)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [signature]);

  // Fail-quiet: only surface the panel once the baseline actually has data for this
  // signature (never the "no baseline recorded" shell, and never while disabled).
  if (!signature || !data || !data.found) return null;

  return (
    <PanelCard>
      <BaselineSignatureCard data={data} embedded />
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

  // ---- source-reported severity vs. our derived risk (task 6) --------------- //
  // Prefer the /triage chip (always a renderable shell), fall back to the case's own
  // advisory fields. `severity_source === 'source_asserted'` is the pivotal signal that
  // the SIEM actually rated this alert (vs. a band we derived from the risk score).
  const sevSource = triage?.severity?.source ?? c.severity_source;
  const sevBandRaw = triage?.severity?.band ?? c.severity_band;
  const sourceSevBand = severityBand(sevBandRaw ?? null); // normalized band | null
  const isSourceAsserted = sevSource === 'source_asserted';
  const sevLabel = sourceSevBand ? titleBand(sourceSevBand) : '';

  // Our deterministic risk band (0-100 → band). This is the "our assessment" counterpart.
  const riskVal =
    typeof triage?.risk?.value === 'number' ? triage.risk.value : c.risk_score;
  const ourRiskBand: ScoreBand | null = typeof riskVal === 'number' ? scoreBand(riskVal) : null;
  const riskLabel = ourRiskBand ? titleBand(ourRiskBand) : '';

  // The delta cue — the highest-value moment for an analyst: the source asserted a
  // severity AND it disagrees with the band our risk score lands in.
  const showSeverityDelta =
    isSourceAsserted && !!sourceSevBand && !!ourRiskBand && sourceSevBand !== ourRiskBand;

  // Whether the "What the source reported" card has any content to show.
  const sourceFactsPresent = Boolean(
    sevBandRaw || ruleIds.length || c.source_name || startedAt || triggerSentence,
  );

  return (
    <div className="space-y-8 p-6">
      {/* ================================================== REPORTED BY SOURCE
          What the SIEM/EDR asserted — source-provided facts only, cool rail. */}
      <Band label="Reported by source" accent="source" provenance={<ProvenanceTag kind="source" />}>
        {sourceFactsPresent ? (
          <PanelCard>
            <SectionHeading icon={Database}>What the source reported</SectionHeading>
            <div className="space-y-4">
              {/* source-asserted severity — "severity per the source was High". */}
              {sevBandRaw ? (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                      Reported severity
                    </span>
                    {/* band token is source-derived — SeverityBadge renders it as text. */}
                    <SeverityBadge severity={sevBandRaw} />
                    <ProvenanceTag kind={severityProvenance(sevSource)} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {isSourceAsserted
                      ? `The source rated this alert ${sevLabel} severity.`
                      : 'No source severity was supplied — this band is derived from our risk score.'}
                  </p>
                </div>
              ) : null}

              {/* detection rule(s) that fired */}
              {ruleIds.length ? (
                <div className="space-y-1.5">
                  <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Detection rule{ruleIds.length === 1 ? '' : 's'}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {/* UNTRUSTED rule ids — plain text nodes, mono. */}
                    {ruleIds.map((r, i) => (
                      <Badge key={`${r}-${i}`} variant="outline" className="font-mono">
                        {r}
                      </Badge>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* source name + source event time */}
              {c.source_name || startedAt ? (
                <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                  {/* UNTRUSTED source name — MetaItem renders it as a plain text node. */}
                  {c.source_name ? <MetaItem label="Source" value={c.source_name} /> : null}
                  {startedAt ? (
                    <MetaItem label="Source event time" value={formatTimestamp(startedAt)} />
                  ) : null}
                </div>
              ) : null}

              {/* the trigger sentence — why the source fired (source-authored). */}
              {triggerSentence ? (
                <div className="space-y-1">
                  <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                    Why it fired
                  </span>
                  {/* UNTRUSTED — plain text. */}
                  <p className="text-sm leading-relaxed text-foreground/90">{triggerSentence}</p>
                </div>
              ) : null}
            </div>
          </PanelCard>
        ) : null}

        {/* affected assets + the read-only search queries — raw source facts. */}
        <div className="grid gap-6 lg:grid-cols-2">
          <PanelCard>
            <SectionHeading icon={Crosshair}>
              Affected assets
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
                    {/* UNTRUSTED value — plain text node, mono. `min-w-0` lets the flex
                        child shrink so `truncate` engages instead of overflowing the card. */}
                    <dd className="min-w-0 truncate text-right font-mono text-sm text-foreground">
                      {row.v}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <EmptyState icon={Crosshair} compact title="No assets recorded" />
            )}
          </PanelCard>

          <PanelCard>
            <SectionHeading icon={Target}>
              Search queries
            </SectionHeading>
            {evidence.some((e) => e.query) || c.reproduce_query ? (
              <div className="space-y-3">
                {evidence
                  .filter((e) => e.query)
                  .map((e, i) => (
                    <div key={i} className="space-y-1.5">
                      {/* These are the read-only ES/log search queries the es_query tool ran
                          (Evidence.query) — NOT shell command lines executed on a host. */}
                      <Badge variant="outline" className="font-mono">
                        Search query
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
              <EmptyState icon={Target} compact title="No indicators recorded" />
            )}
          </PanelCard>
        </div>
      </Band>

      {/* ====================================================== OUR ASSESSMENT
          What WE derived — AI judgement + deterministic code, warm rail. */}
      <Band
        label="Our assessment"
        accent="assessment"
        provenance={
          <>
            <ProvenanceTag kind="ai" />
            <ProvenanceTag kind="code" />
          </>
        }
      >
        {/* the delta cue — the source severity vs. our risk band, surfaced only when they
            disagree (the Splunk severity→urgency lesson made visible). Fixed copy. */}
        {showSeverityDelta ? (
          <div
            data-testid="source-assessment-delta"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
          >
            <span className="inline-flex items-center gap-1.5 text-foreground">
              <Database className="h-3.5 w-3.5 text-info-text" aria-hidden />
              Source severity: <span className="font-semibold">{sevLabel}</span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="inline-flex items-center gap-1.5 text-foreground">
              We assess: <span className="font-semibold">{riskLabel} risk</span>
            </span>
          </div>
        ) : null}

        {/* risk / impact / priority chips — the deterministic (code) signals. SEVERITY is
            shown above under "Reported by source", so it is omitted here. */}
        <CaseTriageHeader
          chips={triage}
          loading={triageLoading}
          only={['risk', 'impact', 'priority']}
        />

        {/* AI judgement strip — verdict + confidence tagged AI, plus the lifecycle state.
            The deterministic close / escalate call is the pinned DecisionCard below, so
            "Auto-closed by AI" lives there (not repeated here). Fixed copy — no UNTRUSTED. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="inline-flex items-center gap-1.5">
            <VerdictBadge verdict={c.verdict} />
            <ProvenanceTag kind="ai" />
          </span>
          <span className="inline-flex items-center gap-1.5">
            <ConfidenceBadge
              confidence={c.confidence}
              {...confidenceCalibration(fpPolicy, c.verdict)}
            />
            <ProvenanceTag kind="ai" />
          </span>
          <StatusBadge status={c.status} />
          <DispositionBadge disposition={c.disposition ?? null} />
          {typeof c.escalation_level === 'number' && c.escalation_level > 0 ? (
            <Badge variant="critical" className="gap-1">
              <Bell className="h-3 w-3" />
              Escalation L{c.escalation_level}
            </Badge>
          ) : null}
        </div>

        {/* incident summary (AI-authored). The source's own trigger sentence lives under
            "Reported by source"; this is our narrative digest of the case. */}
        {c.summary ? (
          <PanelCard>
            <SectionHeading icon={FileText}>Incident summary</SectionHeading>
            {/* UNTRUSTED — plain text. */}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {c.summary}
            </p>
          </PanelCard>
        ) : null}

        {/* recommended action — the top-line "what to do" (AI). */}
        <PanelCard>
          <SectionHeading icon={Activity}>
            Recommended action
          </SectionHeading>
          {/* UNTRUSTED — plain text. */}
          <p className="whitespace-pre-wrap text-sm text-foreground/90">
            {c.recommended_action || DASH}
          </p>
        </PanelCard>

        {/* MITRE (compact summary — full detail on the Threat tab) */}
        {mitre.length ? (
          <PanelCard>
            <SectionHeading icon={Shield}>
              MITRE ATT&amp;CK
            </SectionHeading>
            <div className="flex flex-wrap items-center gap-2">
              {/* Technique ids are source-influenceable — plain text nodes only (#9). */}
              {mitre.slice(0, 6).map((m, i) => (
                <Badge key={`${m}-${i}`} variant="outline" className="font-mono">
                  {m}
                </Badge>
              ))}
              {mitre.length > 6 ? (
                <Badge variant="secondary" className="tabular-nums">
                  +{mitre.length - 6} more
                </Badge>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {mitre.length} technique{mitre.length === 1 ? '' : 's'} mapped — full tactics,
              descriptions and ATT&amp;CK links are on the Threat context tab.
            </p>
          </PanelCard>
        ) : null}

        {/* auto-close policy — a quiet inline note (code), not a full alert. */}
        {autoCloseLine ? (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              <span className="font-medium text-foreground/80">Auto-close policy — </span>
              {autoCloseLine}
            </span>
          </div>
        ) : null}

        {/* anomaly baseline (advisory, #4) */}
        <BaselineAdvisory c={c} />

        {/* the pinned deterministic decision — the trust anchor (#3): the CODE, not the
            LLM, made the close / escalate call. The Overview wires no timeline/rationale,
            so the card degrades to the case fields; the exact policy clause + full trace
            live on the Timeline tab. */}
        <DecisionCard c={c} rationale={null} timeline={null} />
      </Band>

      {/* =========================================================== EVIDENCE */}
      <Band label="Evidence">
        {/* evidence findings */}
        <div>
          <SectionHeading icon={Search}>
            Evidence findings
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
                  {/* The affected entity is shown once under "Affected assets" above — it is
                      the same value on every finding, so it is not repeated per card here. */}
                  <dl className="space-y-2 text-sm">
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

        {/* ruled out / clean */}
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
      </Band>

      {/* ============================================== PROVENANCE & ACTIVITY */}
      <Band label="Provenance & activity">
        {/* related cases + source breakdown (F6) */}
        <RelatedCrossSource c={c} onNavigate={onNavigate} />

        {/* threshold automation (F10) */}
        <AutomationApplied c={c} />

        {/* status timeline (F8) */}
        <StatusTimeline history={c.status_history} statusReason={c.status_reason} />

        {/* run/cost meta — the source event time is shown once under "Reported by source"
            as "Source event time"; here we carry OUR processing metadata. */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-muted-foreground">
          {completedAt ? <span>Processed {formatTimestamp(completedAt)}</span> : null}
          {/* UNTRUSTED profile (playbook id / persona) — plain text. */}
          {profile ? <span>Profile {profile}</span> : null}
          <span>Token cost {fmtMoney(c.token_cost)}</span>
          {c.decision_by ? <span>Decided by {humanizeToken(c.decision_by)}</span> : null}
        </div>
      </Band>

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
