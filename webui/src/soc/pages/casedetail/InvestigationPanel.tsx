/**
 * InvestigationPanel — the "Investigation" tab (task 5 split).
 *
 * Task 5 split the old merged "Timeline" tab: the "what happened" six-stage narrative
 * now lives alone on the sibling <TimelinePanel> ("Timeline" tab), and THIS panel is the
 * investigation proper — the model's assessment, the pinned deterministic decision, and
 * the full ReAct trace. It follows the DESIGN_DIRECTION "lane separation, never
 * interleaved":
 *
 *   1. AI ASSESSMENT  — the model's reasoning / knowledge / tools / enrichment
 *                       (<WhyPanel hideDecision hideMitre>), rendered in a persistently
 *                       AI-marked lane so model prose never blends into a fact stream.
 *   2. DECISION       — the pinned <DecisionCard>: the deterministic `decide()` output,
 *                       the single authority (#3), most-prominent and last.
 *   3. FULL TRACE     — the raw ReAct <TraceTimeline>, available as a collapsible
 *                       "Full agent trace" disclosure for the step-by-step span log.
 *
 * SECURITY (#9): this panel only composes read-only sub-panels; each renders its own
 * model/log-derived text as plain text or inside an escaped CodeBlock. Nothing here
 * decides or mutates a case.
 */
import * as React from 'react';
import { Bot, ChevronDown, Gauge, Lightbulb, ListTree, ShieldCheck } from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse } from '@/soc/pages/CaseDetail.api';
import { cn } from '@/lib/cn';
import { DASH, fmtPercent, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Skeleton } from '@/ui/skeleton';

import { WhyPanel } from './WhyPanel';
import { DecisionCard } from './DecisionCard';
import { GradingHistory } from './grading';
import { TraceTimeline } from '@/soc/components/TraceTimeline';
import type { CasePanelPresentation } from './shared';

/* --------------------------------------------------------------- zone header -- */

/** A lane header — an icon chip + title + subtitle, optionally flagged "AI". `lead`
 *  bumps the chip + title so the lane reads as a prominent story opener. */
const ZoneHeader: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  ai?: boolean;
  lead?: boolean;
}> = ({ icon: Icon, title, subtitle, ai = false, lead = false }) => (
  <div className="flex items-center gap-2.5">
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md border',
        lead ? 'h-9 w-9' : 'h-7 w-7',
        ai ? 'border-info/40 bg-info/10 text-info' : 'border-border bg-muted text-muted-foreground',
      )}
      aria-hidden
    >
      <Icon className={cn(lead ? 'h-5 w-5' : 'h-4 w-4')} />
    </span>
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        <h3
          className={cn(
            'font-semibold tracking-tight text-foreground',
            lead ? 'text-lg' : 'text-sm',
          )}
        >
          {title}
        </h3>
        {ai ? (
          <Badge variant="info" className="gap-1">
            <Bot className="size-3 shrink-0" aria-hidden />
            AI
          </Badge>
        ) : null}
      </div>
      <p className={cn('text-muted-foreground', lead ? 'text-sm' : 'text-xs')}>{subtitle}</p>
    </div>
  </div>
);

/* --------------------------------------------------------------- component -- */

export interface InvestigationPanelProps {
  c: Case;

  /** AI-ASSESSMENT lane — the decision rationale projection. */
  rationale: CaseRationale | null;
  rationaleLoading: boolean;
  rationaleError: unknown;
  onRetryRationale: () => void;

  /** DECISION lane + the collapsible full trace — the typed ReAct spans. */
  timeline: TimelineResponse | null;
  timelineLoading: boolean;
  timelineError: unknown;
  onRetryTimeline: () => void;
  presentation?: CasePanelPresentation;
}

export const InvestigationPanel: React.FC<InvestigationPanelProps> = ({
  c,
  rationale,
  rationaleLoading,
  rationaleError,
  onRetryRationale,
  timeline,
  timelineLoading,
  timelineError,
  onRetryTimeline,
  presentation = 'default',
}) => {
  const [traceOpen, setTraceOpen] = React.useState(false);
  const [evidenceOpen, setEvidenceOpen] = React.useState(false);
  const [decisionOpen, setDecisionOpen] = React.useState(false);

  // Lazy-load the raw trace the first time the disclosure opens, if the parent hasn't
  // already fetched it (the DecisionCard reads its policy_clause from the same data).
  const handleTraceToggle = React.useCallback(
    (open: boolean) => {
      setTraceOpen(open);
      if (open && timeline === null && !timelineLoading && !timelineError) {
        onRetryTimeline();
      }
    },
    [timeline, timelineLoading, timelineError, onRetryTimeline],
  );

  if (presentation === 'case-manager') {
    const confidence =
      typeof rationale?.confidence === 'number' ? rationale.confidence : c.confidence;
    const summary =
      rationale?.reasoning?.trim() ||
      rationale?.decision_rationale?.trim() ||
      c.summary?.trim() ||
      '';
    const recommendation = c.recommended_action?.trim() || '';
    const decisionSummary = rationale?.decision_rationale?.trim() || '';
    const critical =
      (c.severity_band || '').toLowerCase() === 'critical' ||
      (c.verdict || '').toLowerCase() === 'true_positive';

    return (
      <div
        className="space-y-6 px-8 py-7"
        data-case-panel="investigation"
        data-presentation="case-manager"
      >
        {/* The reference's critical assessment banner, populated only with live case
            and rationale values. Model-derived copy remains a plain text node (#9). */}
        <section
          aria-labelledby="case-manager-assessment-title"
          className={cn(
            'relative overflow-hidden rounded-[8px] border bg-card p-5',
            critical ? 'border-critical/30' : 'border-primary/30',
          )}
        >
          <span
            aria-hidden
            className={cn('absolute inset-y-0 left-0 w-1', critical ? 'bg-critical' : 'bg-primary')}
          />
          <div className="flex flex-wrap items-start justify-between gap-3 pl-1">
            <div className="flex items-start gap-3">
              <span
                className={cn(
                  'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border',
                  critical
                    ? 'border-critical/30 bg-critical/10 text-critical-text'
                    : 'border-primary/30 bg-primary/10 text-primary',
                )}
                aria-hidden
              >
                <Bot className="h-4 w-4" />
              </span>
              <div>
                <h2
                  id="case-manager-assessment-title"
                  className="text-base font-semibold tracking-tight text-foreground"
                >
                  AI Assessment Summary
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Agent analysis · advisory evidence
                </p>
              </div>
            </div>
            {typeof confidence === 'number' ? (
              <div className="text-right">
                <div className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                  Confidence
                </div>
                <div className="mt-0.5 font-mono text-sm font-semibold text-primary">
                  {fmtPercent(confidence)}
                </div>
              </div>
            ) : null}
          </div>

          <div className="mt-4 pl-1">
            {rationaleLoading && !summary ? (
              <div className="space-y-2" aria-label="Loading AI assessment">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ) : summary ? (
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
                {summary}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No assessment summary was recorded for this investigation.
              </p>
            )}
          </div>

          <div className="mt-5 grid gap-3 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
            <div className="border border-border bg-surface-sunken p-3">
              <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                <Lightbulb className="h-3.5 w-3.5 text-primary" aria-hidden />
                Recommended action
              </div>
              <p className="text-sm text-foreground/90">
                {recommendation || 'No recommended action was recorded.'}
              </p>
            </div>
            <div className="border border-border bg-surface-sunken p-3">
              <div className="mb-1 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
                <Gauge className="h-3.5 w-3.5 text-critical-text" aria-hidden />
                Risk score
              </div>
              <div className="font-mono text-xl font-semibold text-critical-text">
                {typeof c.risk_score === 'number' ? `${Math.round(c.risk_score)}/100` : DASH}
              </div>
            </div>
          </div>
        </section>

        <section aria-labelledby="case-manager-trace-title" className="space-y-3">
          <div className="flex items-center gap-2">
            <ListTree className="h-4 w-4 text-primary" aria-hidden />
            <h2
              id="case-manager-trace-title"
              className="text-xs font-semibold uppercase tracking-widest text-foreground"
            >
              Investigation Trace
            </h2>
          </div>
          <TraceTimeline
            data={timeline}
            loading={timelineLoading}
            error={timelineError}
            onRetry={onRetryTimeline}
            presentation="case-manager"
          />
        </section>

        <section
          aria-label="Deterministic decision summary"
          className="flex flex-col gap-3 rounded-[4px] border border-primary/25 bg-primary/5 p-4 sm:flex-row sm:items-center"
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[4px] border border-primary/30 bg-primary/10 text-primary"
            aria-hidden
          >
            <ShieldCheck className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">Deterministic decision</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {decisionSummary ||
                'The server-side case policy recorded the outcome shown for this case.'}
            </p>
          </div>
          <Badge variant="outline" className="self-start font-mono sm:self-center">
            {humanizeToken(c.status) || 'Pending'}
          </Badge>
        </section>

        {/* The prototype is visually lean, but the production assessment evidence and
            exact policy inputs remain one disclosure away—nothing from Cases is lost. */}
        <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-4">
          <Collapsible className="w-full" open={evidenceOpen} onOpenChange={setEvidenceOpen}>
            <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Bot className="h-3.5 w-3.5" aria-hidden />
              {evidenceOpen ? 'Hide' : 'Show'} full assessment evidence
              <ChevronDown
                className={cn('h-3.5 w-3.5 transition-transform', evidenceOpen && 'rotate-180')}
                aria-hidden
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 w-full overflow-hidden rounded-[4px] border border-info/30 bg-info/5">
              <WhyPanel
                c={c}
                rationale={rationale}
                loading={rationaleLoading}
                error={rationaleError}
                onRetry={onRetryRationale}
                hideDecision
                hideMitre
              />
            </CollapsibleContent>
          </Collapsible>

          <Collapsible className="w-full" open={decisionOpen} onOpenChange={setDecisionOpen}>
            <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
              {decisionOpen ? 'Hide' : 'Show'} policy inputs
              <ChevronDown
                className={cn('h-3.5 w-3.5 transition-transform', decisionOpen && 'rotate-180')}
                aria-hidden
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 w-full">
              <DecisionCard c={c} rationale={rationale} timeline={timeline} />
            </CollapsibleContent>
          </Collapsible>
        </div>
        <GradingHistory feedback={c.feedback} />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {/* ============================================== 1. AI assessment */}
      <section aria-label="AI assessment" className="space-y-1">
        <ZoneHeader
          icon={Bot}
          title="AI assessment"
          subtitle="The model's reasoning, the knowledge it retrieved, and the tools it ran."
          ai
          lead
        />
        {/* Persistent AI-marked lane: an info tint so model prose never reads as fact.
            hideDecision → the pinned DecisionCard is the sole decision authority (#3);
            hideMitre → MITRE is surfaced once in the Threat lane, not repeated here. */}
        <div className="overflow-hidden rounded-lg border border-info/30 bg-info/5">
          <WhyPanel
            c={c}
            rationale={rationale}
            loading={rationaleLoading}
            error={rationaleError}
            onRetry={onRetryRationale}
            hideDecision
            hideMitre
          />
        </div>
        {/* Prior analyst gradings of this AI decision (Round-7 #10). Read-only; renders
            nothing until a close-with-grade has recorded feedback. `pt-4` (not a margin)
            survives the section's `space-y-1` sibling-margin reset. */}
        <GradingHistory feedback={c.feedback} className="pt-4" />
      </section>

      {/* ============================================== 2. Decision (pinned) */}
      <section aria-label="Decision" className="space-y-1">
        <ZoneHeader
          icon={ShieldCheck}
          title="Decision"
          subtitle="The deterministic close / escalate authority — never raw model output."
        />
        <DecisionCard c={c} rationale={rationale} timeline={timeline} />
      </section>

      {/* ============================================== Full trace (disclosure) */}
      <Collapsible open={traceOpen} onOpenChange={handleTraceToggle}>
        <CollapsibleTrigger className="inline-flex items-center gap-1.5 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ListTree className="h-3.5 w-3.5" aria-hidden />
          {traceOpen ? 'Hide' : 'Show'} full agent trace
          <ChevronDown
            className={cn('h-3.5 w-3.5 transition-transform', traceOpen && 'rotate-180')}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 rounded-lg border border-border bg-card">
            <TraceTimeline
              data={timeline}
              loading={timelineLoading}
              error={timelineError}
              onRetry={onRetryTimeline}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
};

export default InvestigationPanel;
