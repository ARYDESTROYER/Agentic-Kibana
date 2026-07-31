/**
 * Agent Effectiveness — aggregate, read-only evidence about observed SOC outcomes.
 *
 * This surface intentionally has no synthetic score and never claims that the model
 * learned or caused a change. It mirrors the server's complete-day cohort, sample,
 * case-mix, and guardrail states without turning missing evidence into zero.
 */
import * as React from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  RefreshCw,
  Scale,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';

import { api } from '@/lib/api';
import type {
  AgentComparisonMetric,
  AgentEvidenceStatus,
  AgentImprovementEvidence,
} from '@/lib/types';
import { DASH } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { LoadingState } from '@/design-system';
import { LoadingBar } from '@/soc/components/LoadingBar';
import { ComparisonMetric, type ComparisonMetricStatus } from '@/soc/components/ComparisonMetric';
import {
  AgentOutcomeReview,
  type AgentOutcomeChange,
} from '@/soc/components/AgentOutcomeReview';
import {
  AgentOperationalOutcomes,
  SourceCoverageGuidance,
  TuningOutcomeContext,
  type AgentImprovementEvidenceWithOutcomes,
} from '@/soc/components/AgentOperationalOutcomes';
import { LoadError } from '@/soc/components/LoadError';
import { humanizeMinutes } from './posture.format';

type HeadlineState = AgentImprovementEvidence['headline']['state'];

const HEADLINE_COPY: Record<
  HeadlineState,
  { title: string; icon: LucideIcon; className: string; badge: 'success' | 'warning' | 'critical' | 'secondary' }
> = {
  improving: {
    title: 'Observed outcomes improved across both evidence domains',
    icon: TrendingUp,
    className: 'text-success-text',
    badge: 'success',
  },
  stable: {
    title: 'Observed outcomes are stable',
    icon: Scale,
    className: 'text-foreground',
    badge: 'secondary',
  },
  mixed: {
    title: 'Observed outcome shifts are mixed',
    icon: Scale,
    className: 'text-warning-text',
    badge: 'warning',
  },
  guardrail_breach: {
    title: 'A safety guardrail needs review',
    icon: AlertTriangle,
    className: 'text-critical-text',
    badge: 'critical',
  },
  insufficient_evidence: {
    title: 'Not enough evidence to assess change',
    icon: AlertTriangle,
    className: 'text-warning-text',
    badge: 'warning',
  },
};

function dayLabel(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(parsed);
}

/** Compact inclusive label for a half-open UTC reporting window. */
function dayRangeLabel(start: string, endExclusive: string): string {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${endExclusive}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return `${start}–${endExclusive}`;
  }
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  const month = (value: Date) =>
    new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(value);
  const sameYear = startDate.getUTCFullYear() === endDate.getUTCFullYear();
  const sameMonth = sameYear && startDate.getUTCMonth() === endDate.getUTCMonth();
  if (sameMonth) {
    return `${month(startDate)} ${startDate.getUTCDate()}–${endDate.getUTCDate()}, ${endDate.getUTCFullYear()}`;
  }
  if (sameYear) {
    return `${month(startDate)} ${startDate.getUTCDate()}–${month(endDate)} ${endDate.getUTCDate()}, ${endDate.getUTCFullYear()}`;
  }
  return `${month(startDate)} ${startDate.getUTCDate()}, ${startDate.getUTCFullYear()}–${month(endDate)} ${endDate.getUTCDate()}, ${endDate.getUTCFullYear()}`;
}

function ratio(value: number | null | undefined, digits = 1): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(digits)}%`
    : DASH;
}

function evidenceStatus(metric: AgentComparisonMetric): ComparisonMetricStatus {
  if (metric.current.status === 'enough_data' && metric.baseline.status === 'enough_data') {
    return 'sufficient';
  }
  if (metric.current.status === 'unavailable' || metric.baseline.status === 'unavailable') {
    return 'unavailable';
  }
  return 'insufficient';
}

function metricValue(metric: AgentComparisonMetric, which: 'current' | 'baseline'): string {
  const value = metric[which].value;
  return metric.unit === 'ratio' ? ratio(value) : humanizeMinutes(value);
}

function metricDelta(metric: AgentComparisonMetric) {
  if (metric.direction === 'insufficient_evidence') return undefined;
  const points = metric.delta.percentage_points;
  if (typeof points === 'number' && Number.isFinite(points)) {
    const rounded = Math.round(points * 10) / 10;
    return { value: rounded, label: `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} pp` };
  }
  const relative = metric.delta.relative;
  if (typeof relative === 'number' && Number.isFinite(relative)) {
    const percent = Math.round(relative * 1000) / 10;
    return { value: percent, label: `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%` };
  }
  return undefined;
}

function domainLabel(value: string): string {
  if (value === 'insufficient_evidence') return 'Collecting evidence';
  const words = value.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function domainVariant(value: string): 'success' | 'warning' | 'critical' | 'secondary' {
  if (value === 'improving') return 'success';
  if (value === 'regressing') return 'critical';
  if (value === 'insufficient_evidence') return 'warning';
  return 'secondary';
}

function evidenceLabel(status: AgentEvidenceStatus, breached: boolean | null): string {
  if (status === 'enough_data') {
    if (breached === null) return 'Comparison unavailable';
    return breached ? 'Guardrail breached' : 'Within threshold';
  }
  if (status === 'not_applicable') return 'Not applicable';
  if (status === 'unavailable') return 'Unavailable';
  return 'Collecting evidence';
}

function guardrailVariant(
  status: AgentEvidenceStatus,
  breached: boolean | null,
): 'success' | 'warning' | 'critical' | 'secondary' {
  if (status !== 'enough_data') return status === 'not_applicable' ? 'secondary' : 'warning';
  if (breached === null) return 'warning';
  return breached ? 'critical' : 'success';
}

function useAgentEffectiveness(refreshKey = 0) {
  const [data, setData] = React.useState<AgentImprovementEvidence | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<unknown>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.getAgentImprovement());
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return { data, loading, error, load };
}

export interface AgentEffectivenessSummaryProps {
  /** Opens the complete cohort, daily evidence, exclusions, and guardrail analysis. */
  onOpenFull: () => void;
  /** Increment to refresh this report alongside its parent surface. */
  refreshKey?: number;
  /** Applied tuning events shown as non-causal context inside the reporting window. */
  changes?: AgentOutcomeChange[];
}

/**
 * Compact, read-only outcome evidence for Auto-tuning. It deliberately keeps the
 * report separate from tuning policy: observed association can inform an operator,
 * but it never changes a rule or the deterministic case decision path.
 */
export function AgentEffectivenessSummary({
  onOpenFull,
  refreshKey = 0,
  changes = [],
}: AgentEffectivenessSummaryProps) {
  const { data, loading, error, load } = useAgentEffectiveness(refreshKey);
  const headline = data ? HEADLINE_COPY[data.headline.state] : null;
  const HeadlineIcon = headline?.icon ?? TrendingUp;
  const metrics = data?.metrics;
  const qualitySample = metrics?.analyst_reported_verdict_agreement.current.sample_count ?? 0;
  const turnaroundSample = metrics?.human_review_turnaround.current.sample_count ?? 0;

  return (
    <section
      aria-labelledby="tuning-outcomes-heading"
      aria-busy={loading}
      className="border-y border-border/70"
      data-testid="tuning-effectiveness-summary"
    >
      <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            id="tuning-outcomes-heading"
            className="inline-flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground"
          >
            <TrendingUp className="h-4 w-4 text-primary" aria-hidden />
            Observed outcomes
          </h2>
          {headline && data ? (
            <>
              <p className="mt-2 text-lg font-semibold tracking-tight text-foreground">
                {headline.title}
              </p>
              <p className="mt-1 max-w-4xl text-xs leading-relaxed text-muted-foreground">
                {data.headline.reason}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              The latest seven complete UTC days compared with the preceding 28-day baseline.
            </p>
          )}
          {data ? (
            <p className="mt-1 font-mono text-2xs leading-relaxed text-muted-foreground">
              Current{' '}
              {dayRangeLabel(
                data.windows.current.start,
                data.windows.current.end_exclusive,
              )}{' '}
              · baseline{' '}
              {dayRangeLabel(
                data.windows.baseline.start,
                data.windows.baseline.end_exclusive,
              )}{' '}
              · complete UTC days
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          {headline && data ? (
            <Badge variant={headline.badge}>
              <HeadlineIcon className="h-3.5 w-3.5" aria-hidden />
              {domainLabel(data.headline.state)}
            </Badge>
          ) : null}
          {data?.synthetic ? (
            <Badge variant="warning">
              <Sparkles className="h-3.5 w-3.5" aria-hidden />
              Synthetic demo evidence
            </Badge>
          ) : null}
          <Button variant="ghost" size="sm" onClick={onOpenFull}>
            View full evidence
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      <LoadingBar
        active={loading && Boolean(data)}
        size="sm"
        label="Refreshing observed outcome evidence"
      />

      {loading && !data ? (
        <LoadingState
          label="Loading observed outcome evidence"
          description="Comparing complete UTC cohorts and safety guardrails."
          layout="panel"
          shape="panel"
        />
      ) : null}

      {error && !data ? (
        <div className="mb-4 space-y-2">
          <LoadError
            error={error}
            title="Observed outcomes are unavailable"
            fallback="The aggregate reporting endpoint could not be reached."
            onRetry={() => void load()}
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Tuning controls remain available while this reporting-only evidence recovers.
          </p>
        </div>
      ) : null}

      {data && metrics && headline ? (
        <>
          <div className="grid gap-px border-t border-border/70 bg-border/70 xl:grid-cols-3">
            <ComparisonMetric
              label={metrics.analyst_reported_verdict_agreement.label}
              value={metricValue(metrics.analyst_reported_verdict_agreement, 'current')}
              prior={metricValue(metrics.analyst_reported_verdict_agreement, 'baseline')}
              priorLabel="28-day baseline"
              delta={metricDelta(metrics.analyst_reported_verdict_agreement)}
              goodDirection="up"
              accent="success"
              icon={CheckCircle2}
              sub={
                metrics.analyst_reported_verdict_agreement.current.reason ||
                'Source × severity mix adjusted'
              }
              status={evidenceStatus(metrics.analyst_reported_verdict_agreement)}
              sample={{ count: qualitySample, label: 'comparable grades' }}
              definition={metrics.analyst_reported_verdict_agreement.definition}
              definitionTriggerText="How"
              variant="integrated"
              testId="tuning-agent-agreement"
            />
            <ComparisonMetric
              label={metrics.material_analyst_correction_rate.label}
              value={metricValue(metrics.material_analyst_correction_rate, 'current')}
              prior={metricValue(metrics.material_analyst_correction_rate, 'baseline')}
              priorLabel="28-day baseline"
              delta={metricDelta(metrics.material_analyst_correction_rate)}
              goodDirection="down"
              accent="high"
              icon={Scale}
              sub={
                metrics.material_analyst_correction_rate.current.reason ||
                'Source × severity mix adjusted'
              }
              status={evidenceStatus(metrics.material_analyst_correction_rate)}
              sample={{
                count: metrics.material_analyst_correction_rate.current.sample_count,
                label: 'comparable grades',
              }}
              definition={metrics.material_analyst_correction_rate.definition}
              definitionTriggerText="How"
              variant="integrated"
              testId="tuning-agent-correction"
            />
            <ComparisonMetric
              label={metrics.human_review_turnaround.label}
              value={metricValue(metrics.human_review_turnaround, 'current')}
              prior={metricValue(metrics.human_review_turnaround, 'baseline')}
              priorLabel="28-day baseline"
              delta={metricDelta(metrics.human_review_turnaround)}
              goodDirection="down"
              accent="primary"
              icon={Clock3}
              sub={
                metrics.human_review_turnaround.current.reason ||
                'Median elapsed review time'
              }
              status={evidenceStatus(metrics.human_review_turnaround)}
              sample={{ count: turnaroundSample, label: 'human-reviewed cases' }}
              definition={metrics.human_review_turnaround.definition}
              definitionTriggerText="How"
              variant="integrated"
              testId="tuning-agent-turnaround"
            />
          </div>

          {data.outcomes ? <TuningOutcomeContext outcomes={data.outcomes} /> : null}

          <AgentOutcomeReview data={data} changes={changes} />

          {error ? (
            <LoadError
              error={error}
              title="Outcome refresh failed"
              fallback="The previous aggregate evidence remains visible."
              onRetry={() => void load()}
              className="mb-4"
            />
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export default function AgentEffectiveness() {
  const { data, loading, error, load } = useAgentEffectiveness();

  if (loading && !data) {
    return (
      <LoadingState
        label="Loading agent effectiveness evidence"
        description="Comparing complete UTC cohorts and safety guardrails."
        layout="panel"
        shape="panel"
      />
    );
  }

  if (error && !data) {
    return (
      <LoadError
        error={error}
        title="Could not load agent effectiveness evidence"
        fallback="The aggregate evidence endpoint could not be reached."
        onRetry={() => void load()}
      />
    );
  }

  if (!data) return null;

  const headline = HEADLINE_COPY[data.headline.state];
  const HeadlineIcon = headline.icon;
  const metrics = data.metrics;
  const qualitySample = metrics.analyst_reported_verdict_agreement.current.sample_count;
  const turnaroundSample = metrics.human_review_turnaround.current.sample_count;
  const currentDays = data.daily_points.filter((point) => point.window === 'current').slice(-7);
  const excluded = Object.values(data.exclusions).reduce((sum, count) => sum + count, 0);
  const falseNegative = data.guardrails.confirmed_false_negative_rate;
  const reopen = data.guardrails.reopen_after_agent_close_rate;
  const expandedEvidence = data as AgentImprovementEvidenceWithOutcomes;

  return (
    <div className="space-y-6" data-testid="agent-effectiveness">
      <section className="border-y border-border/70 py-5" aria-labelledby="agent-effectiveness-heading">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={headline.badge}>
                <HeadlineIcon className="h-3.5 w-3.5" aria-hidden />
                {domainLabel(data.headline.state)}
              </Badge>
              <Badge variant="outline">Complete UTC days</Badge>
              <Badge variant="outline">Aggregate only</Badge>
              {data.synthetic ? (
                <Badge variant="warning">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden />
                  Synthetic demo evidence
                </Badge>
              ) : null}
            </div>
            <div>
              <h2 id="agent-effectiveness-heading" className={cn('text-xl font-semibold', headline.className)}>
                {headline.title}
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                {data.headline.reason}
              </p>
            </div>
            <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Observed agent-assisted triage outcomes only. This is not a model-learning
              score and does not establish that the agent caused the change.
            </p>
          </div>

          <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} aria-hidden />
              Refresh
            </Button>
            <p className="font-mono text-2xs text-muted-foreground">
              Current {dayLabel(data.windows.current.start)} → before {dayLabel(data.windows.current.end_exclusive)}
            </p>
            <p className="font-mono text-2xs text-muted-foreground">
              Baseline {dayLabel(data.windows.baseline.start)} → before {dayLabel(data.windows.baseline.end_exclusive)}
            </p>
          </div>
        </div>

        <div className="mt-5 grid gap-px overflow-hidden border-y border-border/70 bg-border/70 md:grid-cols-2">
          {Object.entries(data.headline.signal_domains).map(([name, direction]) => (
            <div key={name} className="flex items-center justify-between gap-3 bg-background px-4 py-3">
              <span className="text-sm font-medium text-foreground">
                {name === 'analyst_grade_quality' ? 'Analyst-graded quality' : 'Human review turnaround'}
              </span>
              <Badge variant={domainVariant(direction)}>{domainLabel(direction)}</Badge>
            </div>
          ))}
        </div>
      </section>

      {error ? (
        <LoadError
          error={error}
          title="Refresh failed"
          fallback="The previous aggregate evidence remains visible."
          onRetry={() => void load()}
        />
      ) : null}

      <AgentOperationalOutcomes evidence={expandedEvidence} />

      <section aria-labelledby="outcome-comparisons-heading" className="space-y-3">
        <div>
          <h3 id="outcome-comparisons-heading" className="text-sm font-semibold text-foreground">
            Outcome comparisons
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            The current seven complete days compared with the preceding 28-day baseline.
          </p>
        </div>
        <div className="grid gap-4 xl:grid-cols-3">
          <ComparisonMetric
            label={metrics.analyst_reported_verdict_agreement.label}
            value={metricValue(metrics.analyst_reported_verdict_agreement, 'current')}
            prior={metricValue(metrics.analyst_reported_verdict_agreement, 'baseline')}
            priorLabel="28-day baseline"
            delta={metricDelta(metrics.analyst_reported_verdict_agreement)}
            goodDirection="up"
            accent="success"
            icon={CheckCircle2}
            sub={metrics.analyst_reported_verdict_agreement.current.reason || 'Source × severity mix adjusted'}
            status={evidenceStatus(metrics.analyst_reported_verdict_agreement)}
            sample={{ count: qualitySample, label: 'comparable grades' }}
            definition={metrics.analyst_reported_verdict_agreement.definition}
            testId="agent-agreement"
          />
          <ComparisonMetric
            label={metrics.material_analyst_correction_rate.label}
            value={metricValue(metrics.material_analyst_correction_rate, 'current')}
            prior={metricValue(metrics.material_analyst_correction_rate, 'baseline')}
            priorLabel="28-day baseline"
            delta={metricDelta(metrics.material_analyst_correction_rate)}
            goodDirection="down"
            accent="high"
            icon={Scale}
            sub={metrics.material_analyst_correction_rate.current.reason || 'Source × severity mix adjusted'}
            status={evidenceStatus(metrics.material_analyst_correction_rate)}
            sample={{ count: metrics.material_analyst_correction_rate.current.sample_count, label: 'comparable grades' }}
            definition={metrics.material_analyst_correction_rate.definition}
            testId="agent-correction"
          />
          <ComparisonMetric
            label={metrics.human_review_turnaround.label}
            value={metricValue(metrics.human_review_turnaround, 'current')}
            prior={metricValue(metrics.human_review_turnaround, 'baseline')}
            priorLabel="28-day baseline"
            delta={metricDelta(metrics.human_review_turnaround)}
            goodDirection="down"
            accent="primary"
            icon={Clock3}
            sub={metrics.human_review_turnaround.current.reason || 'Median elapsed review time'}
            status={evidenceStatus(metrics.human_review_turnaround)}
            sample={{ count: turnaroundSample, label: 'human-reviewed cases' }}
            definition={metrics.human_review_turnaround.definition}
            testId="agent-turnaround"
          />
        </div>
      </section>

      <section aria-labelledby="safety-guardrails-heading" className="space-y-3">
        <div>
          <h3 id="safety-guardrails-heading" className="text-sm font-semibold text-foreground">
            Safety guardrails
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Favorable efficiency changes are never promoted when an evaluable guardrail regresses.
          </p>
        </div>
        <div className="divide-y divide-border/70 border-y border-border/70">
          <div className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
            <div className="min-w-0">
              <p className="font-medium text-foreground">Confirmed false-negative rate</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{falseNegative.definition}</p>
            </div>
            <div className="flex gap-5 font-mono text-xs tabular-nums text-muted-foreground">
              <span>Current <strong className="text-foreground">{ratio(falseNegative.current.value)}</strong></span>
              <span>Baseline <strong className="text-foreground">{ratio(falseNegative.baseline.value)}</strong></span>
            </div>
            <Badge variant={guardrailVariant(falseNegative.status, falseNegative.breached)}>
              {evidenceLabel(falseNegative.status, falseNegative.breached)}
            </Badge>
          </div>
          <div className="grid gap-3 py-4 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-center">
            <div className="min-w-0">
              <p className="font-medium text-foreground">Reopen after agent close</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{reopen.caveat}</p>
            </div>
            <div className="flex gap-5 font-mono text-xs tabular-nums text-muted-foreground">
              <span>Current <strong className="text-foreground">{ratio(reopen.current.rate)}</strong></span>
              <span>Baseline <strong className="text-foreground">{ratio(reopen.baseline.rate)}</strong></span>
            </div>
            <Badge variant={guardrailVariant(reopen.status, reopen.breached)}>
              {evidenceLabel(reopen.status, reopen.breached)}
            </Badge>
          </div>
        </div>
      </section>

      <section aria-labelledby="evidence-quality-heading" className="space-y-3">
        <div>
          <h3 id="evidence-quality-heading" className="text-sm font-semibold text-foreground">
            Evidence quality
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Aggregate cohort coverage and exclusions used to qualify the headline.
          </p>
        </div>
        <dl className="grid border-y border-border/70 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ['Comparable case mix', ratio(data.case_mix.comparable_mix_coverage, 0)],
            ['Shared strata', data.case_mix.comparable_strata.toLocaleString()],
            ['Suppressed strata', data.case_mix.suppressed_strata.toLocaleString()],
            ['Excluded observations', excluded.toLocaleString()],
          ].map(([label, value], index) => (
            <div
              key={label}
              className={cn(
                'px-4 py-3',
                index > 0 && 'border-t border-border/70',
                index === 1 && 'sm:border-l sm:border-t-0',
                index === 2 && 'xl:border-l xl:border-t-0',
                index === 3 && 'sm:border-l xl:border-t-0',
              )}
            >
              <dt className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt>
              <dd className="mt-1 font-mono text-lg font-semibold tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
        {data.provenance.truncated ? (
          <div role="status" className="flex gap-2 border-y border-warning/30 py-3 text-sm text-warning-text">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            The case scan was truncated ({data.provenance.fetched.toLocaleString()} of {data.provenance.store_total.toLocaleString()} fetched), so the headline remains insufficient.
          </div>
        ) : null}
      </section>

      <section aria-labelledby="daily-evidence-heading" className="space-y-3">
        <div>
          <h3 id="daily-evidence-heading" className="text-sm font-semibold text-foreground">
            Current-window daily evidence
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Daily values remain blank until that day meets its own minimum evidence threshold.
          </p>
        </div>
        <div className="overflow-x-auto border-y border-border/70">
          <table className="w-full min-w-[760px] border-collapse text-left text-sm">
            <caption className="sr-only">Current seven-day agent effectiveness evidence</caption>
            <thead className="border-b border-border/70 text-2xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-semibold">UTC day</th>
                <th scope="col" className="px-4 py-3 font-semibold">Agreement</th>
                <th scope="col" className="px-4 py-3 font-semibold">Correction</th>
                <th scope="col" className="px-4 py-3 font-semibold">Review p50</th>
                <th scope="col" className="px-4 py-3 font-semibold">Quality n</th>
                <th scope="col" className="px-4 py-3 font-semibold">Review n</th>
                <th scope="col" className="px-4 py-3 font-semibold">Evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {currentDays.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    Daily evidence is not available yet.
                  </td>
                </tr>
              ) : null}
              {currentDays.map((point) => (
                <tr key={point.date}>
                  <th scope="row" className="whitespace-nowrap px-4 py-3 font-medium text-foreground">{dayLabel(point.date)}</th>
                  <td className="px-4 py-3 font-mono tabular-nums">{ratio(point.analyst_reported_agreement)}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{ratio(point.correction_rate)}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{humanizeMinutes(point.review_turnaround_p50_minutes)}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{point.quality_sample_count.toLocaleString()}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{point.turnaround_sample_count.toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <Badge variant={point.status === 'enough_data' ? 'success' : 'warning'}>
                      {point.status === 'enough_data' ? 'Enough data' : 'Collecting'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <SourceCoverageGuidance evidence={expandedEvidence} />

      <footer className="flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-border/70 py-3 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
          Reporting only — deterministic case decisions are unchanged
        </span>
        <span>No model calls or billing</span>
        <span>No case or source identifiers</span>
      </footer>
    </div>
  );
}
