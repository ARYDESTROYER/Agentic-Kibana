import { fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, it } from 'vitest';

import type {
  AgentOperationalOutcomes as OutcomeContract,
  AgentPeriodComparison,
} from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import {
  AgentOperationalOutcomes,
  SourceCoverageGuidance,
  TuningOutcomeContext,
  type AgentImprovementEvidenceWithOutcomes,
} from '../AgentOperationalOutcomes';

expect.extend(toHaveNoViolations);

const DEFINITION = {
  formula: 'bounded aggregate formula',
  numerator: 'Eligible current observations.',
  denominator: 'Eligible observations in the same window.',
  eligibility: 'Complete UTC windows.',
  caveats: 'Observed association only.',
};

function outcomes(): OutcomeContract {
  return {
    recorded_case_cost: {
      label: 'Recorded case-associated AI cost',
      unit: 'USD',
      currency: 'USD',
      status: 'enough_data',
      reason: '',
      current: {
        total_cost: 18.4,
        call_count: 80,
        costed_cases: 40,
        cost_per_costed_case: 0.46,
        cost_per_day: 2.628571,
      },
      baseline: {
        total_cost: 20,
        call_count: 88,
        costed_cases: 40,
        cost_per_costed_case: 0.5,
        cost_per_day: 0.714286,
      },
      delta: {
        cost_per_day_relative: 2.68,
        cost_per_costed_case_relative: -0.08,
      },
      direction: 'up',
      cost_per_day_direction: 'up',
      definition: DEFINITION,
    },
    observed_time_saved: {
      label: 'Estimated elapsed time avoided',
      unit: 'minutes',
      status: 'enough_data',
      reason: '',
      current: {
        status: 'enough_data',
        reason: '',
        human_owned_closure_p50_minutes: 52,
        agent_closed_p50_minutes: 18,
        observed_difference_minutes_per_case: 34,
        observed_aggregate_elapsed_difference_minutes: 680,
        estimated_total_minutes_saved: 680,
        human_owned_closure_count: 28,
        agent_closed_count: 20,
        analyst_reported_total_minutes_saved: 610,
        analyst_reported_sample_count: 18,
        minimum_sample_per_owner: 10,
      },
      baseline: {
        status: 'enough_data',
        reason: '',
        human_owned_closure_p50_minutes: 50,
        agent_closed_p50_minutes: 20,
        observed_difference_minutes_per_case: 30,
        observed_aggregate_elapsed_difference_minutes: 570,
        estimated_total_minutes_saved: 570,
        human_owned_closure_count: 30,
        agent_closed_count: 19,
        analyst_reported_total_minutes_saved: 500,
        analyst_reported_sample_count: 16,
        minimum_sample_per_owner: 10,
      },
      delta: { minutes_per_case: 4 },
      direction: 'stable',
      definition: DEFINITION,
    },
    confirmed_positive_case_rate: {
      label: 'Confirmed-positive share of evaluated cases',
      unit: 'ratio',
      status: 'enough_data',
      reason: '',
      current: {
        value: 0.12,
        available: true,
        status: 'enough_data',
        reason: '',
        sample_count: 60,
        minimum_sample: 30,
        confirmed_positive_cases: 7,
        outcome_evaluable_cases: 60,
      },
      baseline: {
        value: 0.1,
        available: true,
        status: 'enough_data',
        reason: '',
        sample_count: 70,
        minimum_sample: 30,
        confirmed_positive_cases: 7,
        outcome_evaluable_cases: 70,
      },
      delta: { percentage_points: 2 },
      direction: 'up',
      definition: DEFINITION,
    },
    true_positive_alert_yield: {
      label: 'True-positive alert yield',
      unit: 'ratio',
      status: 'unavailable',
      reason:
        'Analyst outcomes are persisted per case while durable volume is counted per alert; the current schema has no defensible alert-level outcome lineage.',
      current: {
        value: null,
        true_positive_alerts: null,
        total_alerts: 8_400,
        lineage_coverage: null,
      },
      baseline: {
        value: null,
        true_positive_alerts: null,
        total_alerts: 7_700,
        lineage_coverage: null,
      },
      delta: { percentage_points: null },
      direction: 'insufficient_evidence',
      supported_alternative: 'confirmed_positive_case_rate',
      definition: DEFINITION,
    },
    alert_volume: {
      label: 'Observed alert volume',
      unit: 'alerts',
      status: 'enough_data',
      reason: '',
      window_basis: 'complete_utc_days',
      current: {
        ingested_alerts: 8_400,
        after_clustering_alerts: 980,
        clustering_reduction_count: 7_420,
        clustering_reduction_rate: 0.8833,
        ingested_per_day: 1_200,
        after_clustering_per_day: 140,
      },
      baseline: {
        ingested_alerts: 30_800,
        after_clustering_alerts: 4_200,
        clustering_reduction_count: 26_600,
        clustering_reduction_rate: 0.8636,
        ingested_per_day: 1_100,
        after_clustering_per_day: 150,
      },
      delta: {
        ingested_per_day_relative: 0.091,
        after_clustering_per_day_relative: -0.067,
      },
      direction: 'down',
      ingested_direction: 'up',
      after_clustering_direction: 'down',
      definition: DEFINITION,
    },
    tuning_context: {
      label: 'Threshold-tuning context',
      status: 'enough_data',
      reason: '',
      current: { applied_changes: 2, rolled_back_changes: 0 },
      baseline: { applied_changes: 1, rolled_back_changes: 1 },
      delta: { applied_changes: 1 },
      direction: 'down',
      cooccurring_after_clustering_direction: 'down',
      causal_claim: false,
      model_fine_tuning_evidence: false,
      definition: DEFINITION,
    },
    source_guidance: {
      status: 'not_available',
      reason:
        'The current product does not persist validated source-gap-to-alert recommendation evidence.',
      items: [],
      long_term_objective: true,
      required_evidence:
        'A governed coverage model linking missing telemetry to alert-specific triage uncertainty.',
    },
  };
}

function period(days: number, currentAgreement: number): AgentPeriodComparison {
  const compact = (
    current: number,
    baseline: number,
    direction: 'improving' | 'stable' | 'regressing' | 'up' | 'down',
  ) => ({
    status: 'enough_data' as const,
    reason: '',
    current,
    baseline,
    current_sample_count: 40,
    baseline_sample_count: 45,
    delta: current - baseline,
    direction,
  });
  const operational = outcomes();
  if (days === 7) {
    operational.recorded_case_cost.current.total_cost = 12.2;
    operational.recorded_case_cost.current.cost_per_day = 1.743;
    operational.recorded_case_cost.current.cost_per_costed_case = 0.61;
    operational.recorded_case_cost.baseline.total_cost = 11;
    operational.recorded_case_cost.baseline.cost_per_day = 1.571;
    operational.recorded_case_cost.baseline.cost_per_costed_case = 0.55;
    operational.recorded_case_cost.delta.cost_per_costed_case_relative = 0.109;
    operational.observed_time_saved.current.human_owned_closure_p50_minutes = 31;
    operational.observed_time_saved.current.agent_closed_p50_minutes = 20;
    operational.observed_time_saved.current.observed_difference_minutes_per_case = 11;
    operational.observed_time_saved.current.observed_aggregate_elapsed_difference_minutes = 220;
    operational.observed_time_saved.current.estimated_total_minutes_saved = 220;
    operational.observed_time_saved.baseline.human_owned_closure_p50_minutes = 29;
    operational.observed_time_saved.baseline.agent_closed_p50_minutes = 21;
    operational.observed_time_saved.baseline.observed_difference_minutes_per_case = 8;
    operational.observed_time_saved.baseline.observed_aggregate_elapsed_difference_minutes = 152;
    operational.observed_time_saved.baseline.estimated_total_minutes_saved = 152;
    operational.observed_time_saved.delta.minutes_per_case = 3;
    operational.alert_volume.current.after_clustering_alerts = 637;
    operational.alert_volume.current.clustering_reduction_count = 7_763;
    operational.alert_volume.current.clustering_reduction_rate = 0.9242;
    operational.alert_volume.current.after_clustering_per_day = 91;
    operational.alert_volume.baseline.after_clustering_alerts = 700;
    operational.alert_volume.baseline.clustering_reduction_count = 7_000;
    operational.alert_volume.baseline.clustering_reduction_rate = 0.9091;
    operational.alert_volume.baseline.after_clustering_per_day = 100;
    operational.alert_volume.delta.after_clustering_per_day_relative = -0.09;
  } else {
    operational.recorded_case_cost.current.total_cost = 29.2;
    operational.recorded_case_cost.current.cost_per_day = 1.043;
    operational.recorded_case_cost.current.cost_per_costed_case = 0.73;
    operational.recorded_case_cost.baseline.total_cost = 25.6;
    operational.recorded_case_cost.baseline.cost_per_day = 0.914;
    operational.recorded_case_cost.baseline.cost_per_costed_case = 0.64;
    operational.recorded_case_cost.delta.cost_per_costed_case_relative = 0.141;
    operational.observed_time_saved.current.human_owned_closure_p50_minutes = 45;
    operational.observed_time_saved.current.agent_closed_p50_minutes = 22;
    operational.observed_time_saved.current.observed_difference_minutes_per_case = 23;
    operational.observed_time_saved.current.observed_aggregate_elapsed_difference_minutes = 460;
    operational.observed_time_saved.current.estimated_total_minutes_saved = 460;
    operational.observed_time_saved.baseline.human_owned_closure_p50_minutes = 39;
    operational.observed_time_saved.baseline.agent_closed_p50_minutes = 24;
    operational.observed_time_saved.baseline.observed_difference_minutes_per_case = 15;
    operational.observed_time_saved.baseline.observed_aggregate_elapsed_difference_minutes = 285;
    operational.observed_time_saved.baseline.estimated_total_minutes_saved = 285;
    operational.observed_time_saved.delta.minutes_per_case = 8;
    operational.alert_volume.current.after_clustering_alerts = 2_016;
    operational.alert_volume.current.clustering_reduction_count = 31_584;
    operational.alert_volume.current.clustering_reduction_rate = 0.94;
    operational.alert_volume.current.after_clustering_per_day = 72;
    operational.alert_volume.baseline.after_clustering_alerts = 2_688;
    operational.alert_volume.baseline.clustering_reduction_count = 28_112;
    operational.alert_volume.baseline.clustering_reduction_rate = 0.9127;
    operational.alert_volume.baseline.after_clustering_per_day = 96;
    operational.alert_volume.delta.after_clustering_per_day_relative = -0.25;
  }

  return {
    label: days === 7 ? 'Week over week' : 'Rolling 28 days over prior 28 days',
    status: 'enough_data',
    reason: '',
    current: {
      start: days === 7 ? '2026-07-21' : '2026-06-30',
      end_exclusive: '2026-07-28',
      days,
    },
    baseline: {
      start: days === 7 ? '2026-07-14' : '2026-06-02',
      end_exclusive: days === 7 ? '2026-07-21' : '2026-06-30',
      days,
    },
    calendar_period: false,
    metrics: {
      analyst_reported_verdict_agreement: compact(currentAgreement, 0.8, 'improving'),
      material_analyst_correction_rate: compact(0.08, 0.12, 'improving'),
      human_review_turnaround: compact(42, 53, 'improving'),
      confirmed_positive_case_rate: compact(0.12, 0.1, 'up'),
    },
    outcomes: operational,
  };
}

function evidence(): AgentImprovementEvidenceWithOutcomes {
  return {
    windows: {
      as_of_exclusive: '2026-07-28',
      current: { start: '2026-07-21', end_exclusive: '2026-07-28', days: 7 },
      baseline: { start: '2026-06-23', end_exclusive: '2026-07-21', days: 28 },
      timezone: 'UTC',
      complete_days_only: true,
    },
    headline: {
      signal_domains: {
        analyst_grade_quality: 'improving',
        human_review_turnaround: 'improving',
      },
    },
    outcomes: outcomes(),
    period_comparisons: {
      week_over_week: period(7, 0.84),
      month_over_month: period(28, 0.88),
    },
  } as AgentImprovementEvidenceWithOutcomes;
}

function renderOutcome(node: React.ReactNode) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

describe('AgentOperationalOutcomes', () => {
  it('renders exact backend outcome fields and the true period-comparison contract', async () => {
    const view = renderOutcome(<AgentOperationalOutcomes evidence={evidence()} />);

    expect(screen.getByText('Operational outcome brief')).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Outcome trend period' })).toBeInTheDocument();
    expect(screen.getAllByText('Confirmed-positive case share').length).toBeGreaterThan(0);
    expect(screen.getByText('Observed elapsed-time difference')).toBeInTheDocument();
    expect(screen.getByText('Alerts after clustering / day')).toBeInTheDocument();
    expect(screen.getByText('AI processing cost / case')).toBeInTheDocument();

    const timeMetric = screen.getByTestId('comparison-outcome-observed_time_saved');
    expect(timeMetric).toHaveTextContent('11 min faster / case');
    expect(timeMetric).toHaveTextContent('48 eligible closures');
    const costMetric = screen.getByTestId('comparison-outcome-recorded_case_cost');
    expect(costMetric).toHaveTextContent('$0.610');
    expect(costMetric).toHaveTextContent('40 costed cases');
    const volumeMetric = screen.getByTestId('comparison-outcome-alert_volume');
    expect(volumeMetric).toHaveTextContent('91 / day');
    expect(
      screen.getAllByText(/no defensible alert-level outcome lineage/).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText(/not measured labor/).length).toBeGreaterThan(0);
    expect(screen.getByText('7,763 · 92.4%')).toBeInTheDocument();
    expect(screen.getByText(/Model spend only; no labor cost is inferred/)).toBeInTheDocument();
    expect(screen.getByText(/does not prove causation/)).toBeInTheDocument();
    expect(screen.getByText(/No composite score or causal claim/)).toBeInTheDocument();

    const agreement = screen.getByRole('group', {
      name: 'Analyst-reported agreement period trend',
    });
    expect(agreement).toHaveTextContent('84.0%');
    fireEvent.click(screen.getByRole('radio', { name: 'Rolling 28 days' }));
    expect(agreement).toHaveTextContent('88.0%');
    expect(timeMetric).toHaveTextContent('23 min faster / case');
    expect(costMetric).toHaveTextContent('$0.730');
    expect(volumeMetric).toHaveTextContent('72 / day');
    expect(screen.getAllByText(/Current 2026-06-30 to before 2026-07-28/)[0]).toHaveTextContent(
      /prior 2026-06-02 to before 2026-06-30/,
    );

    expect(screen.getByText('Evidence by system layer')).toBeInTheDocument();
    expect(screen.getByText('AI verdict quality')).toBeInTheDocument();
    expect(screen.getByText('Workflow speed')).toBeInTheDocument();
    expect(screen.getByText('Alert handling')).toBeInTheDocument();
    expect(screen.getByText(/Not measured as improvement: upstream alert generation/)).toBeInTheDocument();
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it('keeps a missing human-owned closure benchmark unavailable instead of inventing zero', () => {
    const unavailable = evidence();
    const timing = unavailable.period_comparisons!.week_over_week.outcomes.observed_time_saved;
    timing.status = 'unavailable';
    timing.reason =
      'Manual benchmark unavailable — no eligible human-owned closed cases in this period.';
    timing.current.status = 'unavailable';
    timing.current.reason = timing.reason;
    timing.current.human_owned_closure_p50_minutes = null;
    timing.current.observed_difference_minutes_per_case = null;
    timing.current.estimated_total_minutes_saved = null;
    timing.current.human_owned_closure_count = 0;

    renderOutcome(<AgentOperationalOutcomes evidence={unavailable} />);

    const comparison = screen.getByTestId('comparison-outcome-observed_time_saved');
    const currentValue = screen.getByTestId('kpi-outcome-observed_time_saved-metric');
    expect(comparison).toHaveTextContent('Unavailable');
    expect(comparison).toHaveTextContent(/no eligible human-owned closed cases/);
    expect(currentValue).toHaveTextContent('—');
    expect(currentValue).not.toHaveTextContent('0 min');
  });

  it('does not relabel a slower agent-closed cohort as time avoided', () => {
    const slower = evidence();
    const timing = slower.period_comparisons!.week_over_week.outcomes.observed_time_saved;
    timing.current.observed_difference_minutes_per_case = -12;
    timing.current.observed_aggregate_elapsed_difference_minutes = -240;
    timing.current.estimated_total_minutes_saved = null;
    timing.delta.minutes_per_case = -4;

    renderOutcome(<AgentOperationalOutcomes evidence={slower} />);

    expect(screen.getByTestId('comparison-outcome-observed_time_saved')).toHaveTextContent(
      '12 min slower / case',
    );
    expect(screen.getByText('4h slower aggregate')).toBeInTheDocument();
    expect(screen.queryByText(/4h estimated avoided/)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: /changed down by .*worse/ })).toBeInTheDocument();
  });

  it('omits the additive outcome surface for an older backend', () => {
    const older = { outcomes: undefined } as AgentImprovementEvidenceWithOutcomes;
    const view = renderOutcome(<AgentOperationalOutcomes evidence={older} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it('renders a compact non-causal tuning context row', () => {
    renderOutcome(<TuningOutcomeContext outcomes={outcomes()} />);

    const section = screen.getByRole('region', {
      name: 'Downstream volume around threshold tuning',
    });
    expect(section).toHaveTextContent('1,200');
    expect(section).toHaveTextContent('140');
    expect(section).toHaveTextContent('2 applied');
    expect(section).toHaveTextContent(/not model fine-tuning/);
    expect(section).toHaveTextContent(/does not establish causation/);
  });

  it('qualifies unreadable tuning and volume evidence without favorable zeroes', () => {
    const unavailable = outcomes();
    unavailable.alert_volume.status = 'unavailable';
    unavailable.alert_volume.reason = 'Durable counters could not be read.';
    unavailable.tuning_context.status = 'unavailable';
    unavailable.tuning_context.reason = 'The threshold-tuning ledger could not be read.';

    renderOutcome(<TuningOutcomeContext outcomes={unavailable} />);

    const section = screen.getByRole('region', {
      name: 'Downstream volume around threshold tuning',
    });
    expect(section).toHaveTextContent('Unavailable');
    expect(section).toHaveTextContent('Durable counters could not be read.');
    expect(section).toHaveTextContent('threshold-tuning ledger could not be read');
    expect(section).not.toHaveTextContent('2 applied');
  });
});

describe('SourceCoverageGuidance', () => {
  it('labels absent source-gap evidence as a long-term objective, not a recommendation', () => {
    renderOutcome(<SourceCoverageGuidance evidence={evidence()} />);

    expect(screen.getByText('Evidence coverage opportunities')).toBeInTheDocument();
    expect(screen.getByText('Long-term objective')).toBeInTheDocument();
    expect(screen.getByText(/Coverage recommendation unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/does not persist validated source-gap/)).toBeInTheDocument();
    expect(screen.getByText(/governed coverage model/)).toBeInTheDocument();
  });

  it('renders bounded future evidence-backed items as suggestions rather than diagnoses', () => {
    const ready = evidence();
    ready.outcomes!.source_guidance = {
      status: 'ready',
      reason: '',
      long_term_objective: true,
      required_evidence: 'Governed aggregate evidence.',
      items: [
        {
          id: 'dns-egress',
          telemetry_kind: 'outbound_dns',
          title: 'Add outbound DNS telemetry',
          rationale: 'Three aggregate triage gaps lacked destination-domain evidence.',
          affected_context: 'Rare beaconing alerts',
          evidence_gap_count: 3,
        },
      ],
    };

    renderOutcome(<SourceCoverageGuidance evidence={ready} />);

    expect(screen.getByText('Add outbound DNS telemetry')).toBeInTheDocument();
    expect(screen.getByText('Suggestion, not diagnosis')).toBeInTheDocument();
    expect(screen.getByText('3 aggregate evidence gaps')).toBeInTheDocument();
  });
});
