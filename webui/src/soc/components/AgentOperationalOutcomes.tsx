/**
 * Optional operational-outcome evidence for Agent Effectiveness.
 *
 * Older backends omit `outcomes` and `period_comparisons`; the established report
 * remains fully usable in that case. Every rendered value comes from the typed
 * additive contract. Case-level truth and alert-level counters stay separate, and
 * tuning is presented only as co-occurring context rather than causal attribution.
 */
import * as React from 'react';
import {
  CircleDollarSign,
  Clock3,
  Database,
  Layers3,
  Lightbulb,
  Target,
} from 'lucide-react';

import type {
  AgentEvidenceStatus,
  AgentImprovementEvidence,
  AgentOperationalOutcomes as AgentOperationalOutcomesContract,
  AgentOutcomeDirection,
  AgentPeriodComparison,
  AgentPeriodComparisonMetric,
  AgentSourceGuidanceItem,
} from '@/lib/types';
import { cn } from '@/lib/cn';
import { DASH } from '@/lib/format';
import { Badge } from '@/ui/badge';
import {
  ComparisonMetric,
  type ComparisonMetricStatus,
  type MetricDefinitionDetails,
} from './ComparisonMetric';
import { SegmentedControl } from './SegmentedControl';

type PeriodKey = 'week_over_week' | 'month_over_month';

/** Kept as an exported alias for focused consumers/tests of the additive contract. */
export type AgentImprovementEvidenceWithOutcomes = AgentImprovementEvidence;

function comparisonStatus(status: AgentEvidenceStatus): ComparisonMetricStatus {
  if (status === 'enough_data') return 'sufficient';
  if (status === 'not_applicable') return 'not_applicable';
  if (status === 'unavailable') return 'unavailable';
  return 'insufficient';
}

function formatRatio(value: number | null, digits = 1): string {
  return value === null ? DASH : `${(value * 100).toFixed(digits)}%`;
}

function formatCount(value: number | null, suffix = ''): string {
  if (value === null) return DASH;
  return `${Math.round(value).toLocaleString()}${suffix}`;
}

function formatCurrency(value: number | null): string {
  if (value === null) return DASH;
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value < 1 ? 3 : 2,
    maximumFractionDigits: value < 1 ? 3 : 2,
  }).format(value);
}

function formatMinutes(value: number | null): string {
  if (value === null) return DASH;
  const absolute = Math.abs(value);
  if (absolute < 60) return `${Math.round(absolute)} min`;
  const hours = Math.floor(absolute / 60);
  const remaining = Math.round(absolute % 60);
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function formatElapsedDifference(value: number | null): string {
  if (value === null) return DASH;
  if (Math.abs(value) < 0.05) return 'No difference';
  return value > 0
    ? `${formatMinutes(value)} faster / case`
    : `${formatMinutes(value)} slower / case`;
}

function formatAggregateElapsedDifference(value: number | null): string {
  if (value === null) return DASH;
  if (Math.abs(value) < 0.05) return 'No aggregate difference';
  return value > 0
    ? `${formatMinutes(value)} estimated avoided`
    : `${formatMinutes(value)} slower aggregate`;
}

function relativeDelta(value: number | null) {
  if (value === null) return undefined;
  const percent = Math.round(value * 1000) / 10;
  return { value: percent, label: `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%` };
}

function pointsDelta(value: number | null) {
  if (value === null) return undefined;
  const rounded = Math.round(value * 10) / 10;
  return { value: rounded, label: `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} pp` };
}

function minutesDelta(value: number | null) {
  if (value === null) return undefined;
  const rounded = Math.round(value * 10) / 10;
  return {
    value: rounded,
    label: `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} min / case`,
  };
}

function dayRange(windowValue: { start: string; end_exclusive: string }): string {
  return `${windowValue.start} to before ${windowValue.end_exclusive}`;
}

interface OutcomeComparisonProps {
  label: string;
  value: string;
  prior: string;
  delta?: { value: number; label: string };
  goodDirection: 'up' | 'down' | 'none';
  accent: 'primary' | 'success' | 'high' | 'info';
  icon: typeof Target;
  sub: string;
  status: AgentEvidenceStatus;
  statusReason?: string;
  sample: number;
  sampleLabel: string;
  definition: MetricDefinitionDetails;
  testId: string;
}

function OutcomeComparison(props: OutcomeComparisonProps) {
  const status = comparisonStatus(props.status);
  const common = {
    label: props.label,
    value: props.value,
    prior: props.prior,
    priorLabel: 'Comparable prior',
    delta: props.delta,
    goodDirection: props.goodDirection,
    accent: props.accent,
    icon: props.icon,
    sub: props.sub,
    statusReason: props.statusReason,
    definition: props.definition,
    definitionTriggerText: 'How',
    variant: 'integrated' as const,
    testId: props.testId,
  };
  return status === 'unavailable' || status === 'not_applicable' ? (
    <ComparisonMetric {...common} status={status} />
  ) : (
    <ComparisonMetric
      {...common}
      status={status}
      sample={{ count: props.sample, label: props.sampleLabel }}
    />
  );
}

function DetailColumn({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'border-t border-border/70 px-4 py-3 first:border-t-0 lg:border-l lg:border-t-0',
        className,
      )}
    >
      <h4 className="text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <dl className="mt-2 divide-y divide-border/70">{children}</dl>
    </div>
  );
}

function DetailValue({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-2 first:pt-0 last:pb-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="shrink-0 font-mono text-xs font-semibold tabular-nums text-foreground">
        {value}
      </dd>
      {detail ? (
        <dd className="col-span-2 mt-1 text-2xs leading-relaxed text-muted-foreground">
          {detail}
        </dd>
      ) : null}
    </div>
  );
}

function directionPresentation(direction: AgentOutcomeDirection): {
  label: string;
  variant: 'success' | 'critical' | 'warning' | 'secondary' | 'info';
} {
  switch (direction) {
    case 'improving':
      return { label: 'Better', variant: 'success' };
    case 'regressing':
      return { label: 'Worse', variant: 'critical' };
    case 'stable':
      return { label: 'No material change', variant: 'secondary' };
    case 'up':
      return { label: 'Up · descriptive', variant: 'info' };
    case 'down':
      return { label: 'Down · descriptive', variant: 'info' };
    default:
      return { label: 'Insufficient evidence', variant: 'warning' };
  }
}

function evidencePresentation(status: AgentEvidenceStatus): {
  label: string;
  variant: 'success' | 'warning' | 'secondary';
} {
  switch (status) {
    case 'enough_data':
      return { label: 'Sufficient evidence', variant: 'success' };
    case 'not_applicable':
      return { label: 'Not applicable', variant: 'secondary' };
    case 'unavailable':
      return { label: 'Unavailable', variant: 'secondary' };
    default:
      return { label: 'Insufficient evidence', variant: 'warning' };
  }
}

function qualityDirection(metrics: AgentPeriodComparison['metrics']): AgentOutcomeDirection {
  const directions = [
    metrics.analyst_reported_verdict_agreement.direction,
    metrics.material_analyst_correction_rate.direction,
  ];
  if (directions.includes('insufficient_evidence')) return 'insufficient_evidence';
  if (directions.includes('regressing')) return 'regressing';
  if (directions.includes('improving')) return 'improving';
  return 'stable';
}

function AttributionLane({
  icon: Icon,
  title,
  state,
  detail,
}: {
  icon: typeof Target;
  title: string;
  state: ReturnType<typeof directionPresentation>;
  detail: string;
}) {
  return (
    <div className="border-t border-border/70 px-4 py-3 first:border-t-0 lg:border-l lg:border-t-0 lg:first:border-l-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
          <p className="text-xs font-semibold text-foreground">{title}</p>
        </div>
        <Badge variant={state.variant}>{state.label}</Badge>
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">{detail}</p>
    </div>
  );
}

function WhereSystemHelps({
  metrics,
  outcomes,
}: {
  metrics: AgentPeriodComparison['metrics'];
  outcomes: AgentOperationalOutcomesContract;
}) {
  const quality = directionPresentation(qualityDirection(metrics));
  const speed = directionPresentation(metrics.human_review_turnaround.direction);
  const handling = directionPresentation(outcomes.alert_volume.after_clustering_direction);
  const timing = outcomes.observed_time_saved;
  const tuning = outcomes.tuning_context;
  const volume = outcomes.alert_volume;
  const speedDetail =
    timing.status === 'unavailable'
      ? `Agent-vs-human-owned closure comparison unavailable: ${timing.reason || 'no eligible matched reporting cohorts'}. Human-review turnaround remains a separate elapsed-time measure; elapsed time is not labor effort.`
      : `Human-review turnaround plus an observed ${formatElapsedDifference(timing.current.observed_difference_minutes_per_case)} agent-vs-human-owned closure difference. ${timing.status === 'insufficient_evidence' ? `${timing.reason}. ` : ''}Closure cohorts are unmatched; elapsed time is not labor effort.`;
  const handlingDetail =
    tuning.status === 'unavailable'
      ? `Threshold-tuning context unavailable: ${tuning.reason || 'the tuning ledger could not be read'}. After-clustering volume remains descriptive and cannot be attributed to tuning.`
      : `${formatCount(tuning.current.applied_changes)} applied threshold changes co-occurred with ${handling.label.toLowerCase()} after-clustering volume. ${tuning.status === 'insufficient_evidence' ? `${tuning.reason}. ` : ''}Clustering is deterministic and this is not model fine-tuning or causal attribution.`;

  return (
    <section aria-labelledby="system-help-map-heading" className="border-t border-border/70 py-4">
      <div>
        <h3 id="system-help-map-heading" className="text-sm font-semibold text-foreground">
          Evidence by system layer
        </h3>
        <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
          Three independent evidence lanes, not a score. AI assessment, human workflow, and deterministic alert handling remain separately attributed.
        </p>
      </div>
      <div className="mt-3 grid border-y border-border/70 lg:grid-cols-3">
        <AttributionLane
          icon={Target}
          title="AI verdict quality"
          state={quality}
          detail="Analyst agreement and material correction evidence. This measures feedback alignment, not model learning or recall."
        />
        <AttributionLane
          icon={Clock3}
          title="Workflow speed"
          state={speed}
          detail={speedDetail}
        />
        <AttributionLane
          icon={Layers3}
          title="Alert handling"
          state={volume.status === 'enough_data' ? handling : evidencePresentation(volume.status)}
          detail={handlingDetail}
        />
      </div>
      <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
        Not measured as improvement: upstream alert generation or true-positive / raw-alert yield. The current schema has no defensible alert-level outcome lineage.
      </p>
    </section>
  );
}

function OutcomeDetail({ outcomes }: { outcomes: AgentOperationalOutcomesContract }) {
  const positive = outcomes.confirmed_positive_case_rate;
  const tpAlert = outcomes.true_positive_alert_yield;
  const timing = outcomes.observed_time_saved;
  const volume = outcomes.alert_volume;
  const cost = outcomes.recorded_case_cost;
  const tuning = outcomes.tuning_context;
  const tuningDirection = directionPresentation(tuning.cooccurring_after_clustering_direction);

  return (
    <section aria-labelledby="outcome-evidence-basis-heading" className="border-t border-border/70">
      <div className="py-3">
        <h3 id="outcome-evidence-basis-heading" className="text-sm font-semibold text-foreground">
          What supports these movements
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Case truth, elapsed closure timing, alert counters, and spend retain their own units and evidence limits.
        </p>
      </div>

      <div className="grid border-y border-border/70 lg:grid-cols-4">
        <DetailColumn title="Case outcomes" className="lg:border-l-0">
          <DetailValue
            label="Confirmed-positive share"
            value={formatRatio(positive.current.value)}
          />
          <DetailValue
            label="Confirmed / evaluable cases"
            value={`${positive.current.confirmed_positive_cases.toLocaleString()} / ${positive.current.outcome_evaluable_cases.toLocaleString()}`}
          />
          <DetailValue label="TP / raw-alert yield" value={DASH} detail={tpAlert.reason} />
        </DetailColumn>

        <DetailColumn title="Closure timing">
          <DetailValue
            label="Human-owned closure p50"
            value={formatMinutes(timing.current.human_owned_closure_p50_minutes)}
          />
          <DetailValue
            label="Agent-closed p50"
            value={formatMinutes(timing.current.agent_closed_p50_minutes)}
          />
          <DetailValue
            label="Estimated aggregate elapsed difference"
            value={formatAggregateElapsedDifference(
              timing.current.observed_aggregate_elapsed_difference_minutes,
            )}
            detail="Unmatched cohort estimate; elapsed time is not measured labor or overtime savings."
          />
        </DetailColumn>

        <DetailColumn title="Alert path">
          <DetailValue
            label="Ingested alerts / day"
            value={formatCount(volume.current.ingested_per_day, ' / day')}
          />
          <DetailValue
            label="After clustering / day"
            value={formatCount(volume.current.after_clustering_per_day, ' / day')}
          />
          <DetailValue
            label="Current counter totals"
            value={`${formatCount(volume.current.ingested_alerts)} → ${formatCount(volume.current.after_clustering_alerts)}`}
            detail="Clustering is downstream of ingest; it is not proof of promotion to investigation."
          />
          <DetailValue
            label="Reduced before case creation"
            value={`${formatCount(volume.current.clustering_reduction_count)} · ${formatRatio(volume.current.clustering_reduction_rate)}`}
            detail="Deterministic clustering-path reduction; threshold changes may co-occur but are not proven to cause it."
          />
        </DetailColumn>

        <DetailColumn title="AI processing cost">
          <DetailValue label="Recorded total" value={formatCurrency(cost.current.total_cost)} />
          <DetailValue
            label="Per costed case"
            value={formatCurrency(cost.current.cost_per_costed_case)}
            detail={`${cost.current.costed_cases.toLocaleString()} case-associated cost cohorts.`}
          />
          <DetailValue
            label="Recorded / day"
            value={formatCurrency(cost.current.cost_per_day)}
            detail={`Comparable prior ${formatCurrency(cost.baseline.cost_per_day)}. Model spend only; no labor cost is inferred.`}
          />
        </DetailColumn>
      </div>

      <div className="flex gap-2.5 py-3 text-xs leading-relaxed text-muted-foreground">
        <Layers3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p>
          <span className="font-medium text-foreground">Tuning context only.</span>{' '}
          {tuning.reason ||
            `${tuning.current.applied_changes.toLocaleString()} threshold changes were applied and ${tuning.current.rolled_back_changes.toLocaleString()} rolled back in the current window.`}{' '}
          Co-occurring after-clustering volume: {tuningDirection.label.toLowerCase()}. Threshold
          tuning is downstream of ingest, is not model fine-tuning, and does not prove causation.
        </p>
      </div>
    </section>
  );
}

interface TrendMetricConfig {
  key: keyof AgentPeriodComparison['metrics'];
  label: string;
  unit: 'ratio' | 'minutes';
  neutral: boolean;
}

const TREND_METRICS: readonly TrendMetricConfig[] = [
  {
    key: 'analyst_reported_verdict_agreement',
    label: 'Analyst-reported agreement',
    unit: 'ratio',
    neutral: false,
  },
  {
    key: 'material_analyst_correction_rate',
    label: 'Material correction rate',
    unit: 'ratio',
    neutral: false,
  },
  {
    key: 'human_review_turnaround',
    label: 'Human review turnaround',
    unit: 'minutes',
    neutral: false,
  },
  {
    key: 'confirmed_positive_case_rate',
    label: 'Confirmed-positive case share',
    unit: 'ratio',
    neutral: true,
  },
] as const;

function trendValue(value: number | null, unit: TrendMetricConfig['unit']): string {
  return unit === 'ratio' ? formatRatio(value) : formatMinutes(value);
}

function TrendMetricRow({
  metric,
  config,
}: {
  metric: AgentPeriodComparisonMetric;
  config: TrendMetricConfig;
}) {
  const presentation = directionPresentation(metric.direction);
  return (
    <div
      role="group"
      aria-label={`${config.label} period trend`}
      className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center"
    >
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{config.label}</p>
        <p className="mt-0.5 text-2xs text-muted-foreground">
          {metric.current_sample_count.toLocaleString()} current ·{' '}
          {metric.baseline_sample_count.toLocaleString()} prior samples
        </p>
        {metric.reason ? (
          <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{metric.reason}</p>
        ) : null}
      </div>
      <p className="font-mono text-xs tabular-nums text-muted-foreground">
        <span className="font-semibold text-foreground">{trendValue(metric.current, config.unit)}</span>{' '}
        vs {trendValue(metric.baseline, config.unit)}
      </p>
      <Badge variant={presentation.variant}>
        {config.neutral && (metric.direction === 'improving' || metric.direction === 'regressing')
          ? metric.direction === 'improving'
            ? 'Up · descriptive'
            : 'Down · descriptive'
          : presentation.label}
      </Badge>
    </div>
  );
}

function PeriodTrendSummary({
  selected,
}: {
  selected: AgentPeriodComparison;
}) {
  return (
    <section aria-labelledby="period-trend-heading" className="border-t border-border/70 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="period-trend-heading" className="text-sm font-semibold text-foreground">
            Week and rolling-28-day trend check
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Equal-length complete UTC windows answer better, worse, unchanged, or insufficient evidence without mixing units on one chart.
          </p>
          <p className="mt-1 font-mono text-2xs text-muted-foreground">
            Current {dayRange(selected.current)} · prior {dayRange(selected.baseline)}
          </p>
        </div>
      </div>

      <div className="mt-3 grid divide-y divide-border/70 border-y border-border/70 xl:grid-cols-2 xl:divide-y-0">
        {TREND_METRICS.map((config, index) => (
          <div
            key={config.key}
            className={cn(
              index > 1 && 'xl:border-t xl:border-border/70',
              index % 2 === 1 && 'xl:border-l xl:border-border/70',
            )}
          >
            <TrendMetricRow metric={selected.metrics[config.key]} config={config} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function AgentOperationalOutcomes({
  evidence,
}: {
  evidence: AgentImprovementEvidenceWithOutcomes;
}) {
  const [period, setPeriod] = React.useState<PeriodKey>('week_over_week');
  const comparison = evidence.period_comparisons?.[period];
  const outcomes = comparison?.outcomes ?? evidence.outcomes;
  if (!outcomes) return null;
  const positive = outcomes.confirmed_positive_case_rate;
  const timing = outcomes.observed_time_saved;
  const volume = outcomes.alert_volume;
  const cost = outcomes.recorded_case_cost;

  return (
    <section aria-labelledby="operational-outcomes-heading" data-testid="operational-outcomes">
      <div className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="operational-outcomes-heading" className="text-sm font-semibold text-foreground">
            Operational outcome brief
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Quality, elapsed closure time, downstream alert flow, and recorded AI spend. No composite score or causal claim.
          </p>
          <p className="mt-1 font-mono text-2xs text-muted-foreground">
            Current {dayRange(comparison?.current ?? evidence.windows.current)} · prior{' '}
            {dayRange(comparison?.baseline ?? evidence.windows.baseline)} · complete UTC days
          </p>
        </div>
        {evidence.period_comparisons ? (
          <SegmentedControl
            aria-label="Outcome trend period"
            size="sm"
            value={period}
            onValueChange={setPeriod}
            options={[
              { value: 'week_over_week', label: 'Week over week' },
              { value: 'month_over_month', label: 'Rolling 28 days' },
            ]}
          />
        ) : null}
      </div>

      <div className="grid gap-px border-y border-border/70 bg-border/70 sm:grid-cols-2 xl:grid-cols-4">
        <OutcomeComparison
          label="Confirmed-positive case share"
          value={formatRatio(positive.current.value)}
          prior={formatRatio(positive.baseline.value)}
          delta={pointsDelta(positive.delta.percentage_points)}
          goodDirection="none"
          accent="info"
          icon={Target}
          sub="Case-level observed outcome mix"
          status={positive.status}
          statusReason={positive.reason || undefined}
          sample={positive.current.outcome_evaluable_cases}
          sampleLabel="evaluable cases"
          definition={positive.definition}
          testId="outcome-confirmed_positive_case_rate"
        />
        <OutcomeComparison
          label="Observed elapsed-time difference"
          value={formatElapsedDifference(timing.current.observed_difference_minutes_per_case)}
          prior={formatElapsedDifference(timing.baseline.observed_difference_minutes_per_case)}
          delta={minutesDelta(timing.delta.minutes_per_case)}
          goodDirection="up"
          accent="primary"
          icon={Clock3}
          sub="Unmatched closure cohorts; not labor time"
          status={timing.status}
          statusReason={timing.reason || undefined}
          sample={timing.current.human_owned_closure_count + timing.current.agent_closed_count}
          sampleLabel="eligible closures"
          definition={timing.definition}
          testId="outcome-observed_time_saved"
        />
        <OutcomeComparison
          label="Alerts after clustering / day"
          value={formatCount(volume.current.after_clustering_per_day, ' / day')}
          prior={formatCount(volume.baseline.after_clustering_per_day, ' / day')}
          delta={relativeDelta(volume.delta.after_clustering_per_day_relative)}
          goodDirection="none"
          accent="info"
          icon={Layers3}
          sub="Downstream clustering only"
          status={volume.status}
          statusReason={volume.reason || undefined}
          sample={volume.current.ingested_alerts ?? 0}
          sampleLabel="ingested alerts"
          definition={volume.definition}
          testId="outcome-alert_volume"
        />
        <OutcomeComparison
          label="AI processing cost / case"
          value={formatCurrency(cost.current.cost_per_costed_case)}
          prior={formatCurrency(cost.baseline.cost_per_costed_case)}
          delta={relativeDelta(cost.delta.cost_per_costed_case_relative)}
          goodDirection="none"
          accent="high"
          icon={CircleDollarSign}
          sub="Recorded case-associated model spend"
          status={cost.status}
          statusReason={cost.reason || undefined}
          sample={cost.current.costed_cases}
          sampleLabel="costed cases"
          definition={cost.definition}
          testId="outcome-recorded_case_cost"
        />
      </div>

      <OutcomeDetail outcomes={outcomes} />
      {comparison ? <WhereSystemHelps metrics={comparison.metrics} outcomes={outcomes} /> : null}
      {comparison ? <PeriodTrendSummary selected={comparison} /> : null}
    </section>
  );
}

/** Compact context row for Auto-tuning Outcomes; authority remains in Operations. */
export function TuningOutcomeContext({
  outcomes,
}: {
  outcomes: AgentOperationalOutcomesContract;
}) {
  const volume = outcomes.alert_volume;
  const tuning = outcomes.tuning_context;
  const volumeComparable = volume.status === 'enough_data';
  const volumeReadable = volume.status !== 'unavailable';
  const tuningComparable = tuning.status === 'enough_data';
  const tuningReadable = tuning.status !== 'unavailable';
  const movement = volumeComparable
    ? directionPresentation(volume.after_clustering_direction)
    : evidencePresentation(volume.status);
  const contextState = evidencePresentation(
    volumeComparable ? tuning.status : volume.status,
  );

  return (
    <section aria-labelledby="tuning-volume-context-heading" className="border-t border-border/70 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 id="tuning-volume-context-heading" className="text-xs font-semibold text-foreground">
            Downstream volume around threshold tuning
          </h3>
          <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
            Per-day counters make the unequal 7-day and 28-day windows comparable.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={contextState.variant}>{contextState.label}</Badge>
          <Badge variant="secondary">Context only · not causal</Badge>
        </div>
      </div>
      <dl className="mt-3 grid border-y border-border/70 sm:grid-cols-3">
        <div className="px-3 py-2.5">
          <dt className="text-2xs text-muted-foreground">Ingested / day</dt>
          <dd className="mt-1 font-mono text-sm font-semibold tabular-nums text-foreground">
            {volumeReadable ? formatCount(volume.current.ingested_per_day) : DASH}{' '}
            <span className="text-2xs font-normal text-muted-foreground">
              vs {volumeReadable ? formatCount(volume.baseline.ingested_per_day) : DASH}
            </span>
          </dd>
        </div>
        <div className="border-t border-border/70 px-3 py-2.5 sm:border-l sm:border-t-0">
          <dt className="text-2xs text-muted-foreground">After clustering / day</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2 font-mono text-sm font-semibold tabular-nums text-foreground">
            {volumeReadable ? formatCount(volume.current.after_clustering_per_day) : DASH}
            <span className="text-2xs font-normal text-muted-foreground">
              vs {volumeReadable ? formatCount(volume.baseline.after_clustering_per_day) : DASH}
            </span>
            <Badge variant={movement.variant}>{movement.label}</Badge>
          </dd>
        </div>
        <div className="border-t border-border/70 px-3 py-2.5 sm:border-l sm:border-t-0">
          <dt className="text-2xs text-muted-foreground">Threshold changes</dt>
          <dd className="mt-1 font-mono text-sm font-semibold tabular-nums text-foreground">
            {tuningReadable ? (
              <>
                {tuning.current.applied_changes.toLocaleString()} applied ·{' '}
                {tuning.current.rolled_back_changes.toLocaleString()} rolled back
              </>
            ) : (
              DASH
            )}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-2xs leading-relaxed text-muted-foreground">
        Threshold tuning can co-occur with downstream clustering changes, but it does not reduce upstream-generated alerts, is not model fine-tuning, and does not establish causation.
      </p>
      {!volumeComparable || !tuningComparable ? (
        <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
          {!volumeComparable ? `Alert-volume evidence: ${volume.reason || evidencePresentation(volume.status).label}.` : null}{' '}
          {!tuningComparable ? `Tuning evidence: ${tuning.reason || evidencePresentation(tuning.status).label}.` : null}
        </p>
      ) : null}
    </section>
  );
}

function GuidanceList({ items }: { items: AgentSourceGuidanceItem[] }) {
  return (
    <ul className="mt-4 divide-y divide-border/70 border-y border-border/70">
      {items.slice(0, 5).map((item, index) => (
        <li key={item.id ?? `${item.telemetry_kind ?? 'guidance'}-${index}`} className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-medium text-foreground">
              {item.title ?? item.telemetry_kind ?? 'Additional telemetry'}
            </p>
            <Badge variant="secondary">Suggestion, not diagnosis</Badge>
          </div>
          {item.rationale ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.rationale}</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-2xs text-muted-foreground">
            {item.affected_context ? <span>{item.affected_context}</span> : null}
            {typeof item.evidence_gap_count === 'number' ? (
              <span>{item.evidence_gap_count.toLocaleString()} aggregate evidence gaps</span>
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function SourceCoverageGuidance({
  evidence,
}: {
  evidence: AgentImprovementEvidenceWithOutcomes;
}) {
  const guidance = evidence.outcomes?.source_guidance;
  const ready = guidance?.status === 'ready';
  const items = ready ? guidance.items : [];

  return (
    <section aria-labelledby="coverage-guidance-heading" className="border-y border-border/70 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <div>
            <h3 id="coverage-guidance-heading" className="text-sm font-semibold text-foreground">
              Evidence coverage opportunities
            </h3>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              Suggestions for additional telemetry that could close recurring triage evidence gaps.
            </p>
          </div>
        </div>
        <Badge variant="outline" className="w-fit shrink-0">
          Long-term objective
        </Badge>
      </div>

      {ready && items.length ? (
        <GuidanceList items={items} />
      ) : ready ? (
        <div className="mt-4 flex gap-2 border-y border-border/70 py-3 text-xs text-muted-foreground">
          <Database className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Source-gap analysis completed; no evidence-backed coverage opportunity was detected.
        </div>
      ) : (
        <div className="mt-4 flex gap-2 border-y border-dashed border-border/70 py-3 text-xs text-muted-foreground">
          <Database className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            <span className="font-medium text-foreground">Coverage recommendation unavailable.</span>{' '}
            {guidance?.reason ??
              'The current backend has not evaluated semantic telemetry gaps.'}{' '}
            {guidance?.required_evidence ??
              'Recommending a source such as outbound DNS requires a future governed evidence-gap analysis.'}
          </p>
        </div>
      )}
    </section>
  );
}
