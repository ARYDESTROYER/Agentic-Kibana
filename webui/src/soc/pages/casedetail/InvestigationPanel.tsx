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
import { Bot, ChevronDown, ListTree, ShieldCheck } from 'lucide-react';

import type { Case, CaseRationale } from '@/lib/types';
import type { TimelineResponse } from '@/soc/pages/CaseDetail.api';
import { cn } from '@/lib/cn';

import { Badge } from '@/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';

import { WhyPanel } from './WhyPanel';
import { DecisionCard } from './DecisionCard';
import { GradingHistory } from './grading';
import { TraceTimeline } from '@/soc/components/TraceTimeline';

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
}) => {
  const [traceOpen, setTraceOpen] = React.useState(false);

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
