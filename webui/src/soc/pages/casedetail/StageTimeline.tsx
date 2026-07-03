/**
 * StageTimeline — the six-stage narrative of how one alert became a case.
 *
 * Consumes `GET /api/cases/{id}/stages` (the `TimelineStage` shape) and renders it as
 * a vertical, chronological story: input → correlate → risk → triage → investigate →
 * decide. Each stage shows a one-line TRUSTED headline + state chips at a glance, and
 * expands to its chronological steps. Deterministic stages (correlate/risk/decide)
 * carry a "deterministic" badge — the trust signal (#3 made visible).
 *
 * SECURITY (#9): a step with `trusted === false` (raw source/log/tool payload) renders
 * its body ONLY inside an escaped <CodeBlock>; trusted prose renders as plain text.
 */
import * as React from 'react';
import {
  ChevronDown,
  Compass,
  Gauge,
  GitBranch,
  GitMerge,
  Inbox,
  Lock,
  Search,
  ShieldCheck,
} from 'lucide-react';

import { cn } from '@/lib/cn';
import { DASH, formatTimestamp, humanizeToken } from '@/lib/format';

import { Badge } from '@/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/ui/collapsible';
import { Skeleton } from '@/ui/skeleton';
import { CodeBlock } from '@/soc/components/CodeBlock';
import { EmptyState } from '@/soc/components/EmptyState';
import { LoadError } from '@/soc/components/LoadError';

import type { StageState, StageStep, TimelineStage, TimelineStagesResponse } from '@/soc/pages/CaseDetail.api';

/* ------------------------------------------------------------------ meta -- */

type Tone = 'info' | 'medium' | 'low' | 'high';

const TONE_TEXT: Record<Tone, string> = {
  info: 'text-info',
  medium: 'text-medium',
  low: 'text-low',
  high: 'text-high',
};
const TONE_RING: Record<Tone, string> = {
  info: 'border-info/40 bg-info/10',
  medium: 'border-medium/40 bg-medium/10',
  low: 'border-low/40 bg-low/10',
  high: 'border-high/40 bg-high/10',
};

interface StageMeta {
  icon: React.ComponentType<{ className?: string }>;
  tone: Tone;
}
const STAGE_META: Record<string, StageMeta> = {
  input: { icon: Inbox, tone: 'info' },
  correlate: { icon: GitMerge, tone: 'info' },
  risk: { icon: Gauge, tone: 'medium' },
  triage: { icon: Compass, tone: 'info' },
  investigate: { icon: Search, tone: 'info' },
  decide: { icon: ShieldCheck, tone: 'low' },
};
function stageMeta(kind: string): StageMeta {
  return STAGE_META[kind] || { icon: GitBranch, tone: 'info' };
}

/* --------------------------------------------------------------- state chips -- */

const StateChips: React.FC<{ state: StageState }> = ({ state }) => {
  const chips: React.ReactNode[] = [];
  if (state.severity_band) {
    const src = state.severity_source === 'source_asserted' ? 'SIEM' : state.severity_source === 'derived' ? 'derived' : '';
    chips.push(
      <Badge key="sev" variant="outline">
        severity {humanizeToken(state.severity_band)}
        {src ? ` · ${src}` : ''}
      </Badge>,
    );
  }
  if (typeof state.risk_score === 'number') {
    chips.push(<Badge key="risk" variant="medium">risk {Math.round(state.risk_score)}/100</Badge>);
  }
  if (state.verdict) {
    chips.push(<Badge key="verdict" variant="info">{humanizeToken(state.verdict)}</Badge>);
  }
  if (typeof state.confidence === 'number') {
    chips.push(<Badge key="conf" variant="outline">conf {Math.round(state.confidence * 100)}%</Badge>);
  }
  if (!chips.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5">{chips}</div>;
};

/* ----------------------------------------------------------------- one step -- */

const StepItem: React.FC<{ step: StageStep }> = ({ step }) => (
  <div className="rounded-md border border-border bg-muted/30 p-3">
    <div className="mb-1.5 flex items-center gap-1.5">
      <Badge variant={step.trusted ? 'info' : 'medium'} className="gap-1">
        {step.trusted ? null : <Lock className="h-3 w-3" />}
        {step.label || humanizeToken(step.kind) || 'Step'}
      </Badge>
      {step.trusted ? null : (
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">untrusted</span>
      )}
    </div>
    {step.body ? (
      step.trusted ? (
        /* TRUSTED — our prose, plain text. */
        <p className="whitespace-pre-wrap text-xs text-foreground/90">{step.body}</p>
      ) : (
        /* UNTRUSTED — fenced in an escaped code block (#9). */
        <CodeBlock value={step.body} wrap copyable maxHeightClassName="max-h-40" />
      )
    ) : null}
  </div>
);

/* ---------------------------------------------------------------- one stage -- */

const StageRow: React.FC<{ stage: TimelineStage; last: boolean }> = ({ stage, last }) => {
  const meta = stageMeta(stage.kind);
  const Icon = meta.icon;
  const skipped = stage.status === 'skipped';
  const pending = stage.status === 'pending';
  const muted = skipped || pending;
  const hasSteps = stage.steps.length > 0;
  const [open, setOpen] = React.useState(false);

  return (
    <li className="relative pl-10">
      {last ? null : (
        <span
          className={cn('absolute left-[15px] top-7 bottom-0 w-px', muted ? 'bg-border/50' : 'bg-border')}
          aria-hidden
        />
      )}
      <span
        className={cn(
          'absolute left-2 top-1 flex h-6 w-6 items-center justify-center rounded-full border',
          muted
            ? 'border-dashed border-border bg-muted text-muted-foreground'
            : cn('bg-card', TONE_RING[meta.tone], TONE_TEXT[meta.tone]),
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className={cn('pb-6', muted && 'opacity-70')}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-foreground">{stage.label}</span>
          {stage.deterministic ? (
            <Badge variant="outline" className="gap-1">
              <GitBranch className="h-3 w-3" />
              deterministic
            </Badge>
          ) : null}
          {skipped ? <Badge variant="outline">skipped</Badge> : null}
          {pending ? <Badge variant="outline">pending</Badge> : null}
          {stage.ts ? (
            <span className="text-[11px] text-muted-foreground">{formatTimestamp(stage.ts)}</span>
          ) : null}
        </div>

        {/* headline — always our TRUSTED prose */}
        <p className="mt-0.5 text-sm text-foreground/90">{stage.headline || DASH}</p>

        <StateChips state={stage.state} />

        {hasSteps ? (
          <Collapsible open={open} onOpenChange={setOpen} className="mt-2">
            <CollapsibleTrigger className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
              {open ? 'Hide' : 'Show'} {stage.steps.length} step{stage.steps.length === 1 ? '' : 's'}
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2 space-y-2">
              {stage.steps.map((st, i) => (
                <StepItem key={i} step={st} />
              ))}
            </CollapsibleContent>
          </Collapsible>
        ) : null}
      </div>
    </li>
  );
};

/* -------------------------------------------------------------------- root -- */

export interface StageTimelineProps {
  data: TimelineStagesResponse | null;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}

export const StageTimeline: React.FC<StageTimelineProps> = ({ data, loading, error, onRetry }) => {
  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-6">
        <LoadError error={error} title="Could not load the timeline" onRetry={onRetry} />
      </div>
    );
  }
  const stages = data?.stages ?? [];
  if (!stages.length) {
    return (
      <div className="p-6">
        <EmptyState
          icon={GitBranch}
          title="No timeline yet"
          description="The stage-by-stage narrative appears once the alert has been ingested and triaged."
        />
      </div>
    );
  }
  return (
    <div className="p-6">
      <ol className="relative">
        {stages.map((s, i) => (
          <StageRow key={s.id || s.kind} stage={s} last={i === stages.length - 1} />
        ))}
      </ol>
    </div>
  );
};

export default StageTimeline;
