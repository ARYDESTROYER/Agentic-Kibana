---
title: Tuning and baselines
description: Use bounded threshold recommendations and aggregate anomaly baselines without uncontrolled self-modification.
---

# Tuning and baselines

Threshold tuning and baselines learn from bounded statistics. Neither component
changes the deterministic case decision.

## Threshold auto-tuning

Open **Platform → Auto-tuning**. Reading recommendations requires
`automation:read`; changing policy, applying a recommendation, or rolling back
requires `automation:manage`.

The default tuner:

- waits for at least 30 closed-case samples per rule;
- compares a Wilson lower-bound false-positive rate with a 10% target;
- smooths observations with EWMA;
- limits a correlation-threshold change to one step per cadence; and
- shadow-evaluates the suggestion before it can be applied.

A rule below `min_samples` is **Collecting**. With enough evidence, it is **Within
target** when the Wilson lower-bound false-positive rate is at or below policy and
**Needs attention** when it is above policy. An under-sampled rule is never labelled
healthy.

**Operations** groups current recommendations by rule. **Process changes** calls the
rule-scoped endpoint once; the backend recomputes and processes every current proposal
for that rule. The default is review-first: eligible bounded changes route to
**Approvals**, while suppression and shadow-blocked changes always require review.
An operator may explicitly enable confirmed-evidence auto-apply, but only while shadow
evaluation is enabled; disabling shadow evaluation disables that opt-in. Every applied
change is audited, and rollback restores the exact previous value.

## Console workspaces

Auto-tuning is organised as three task-focused workspaces so evidence and controls
do not compete for the same screen space:

- **Operations** is the default view for the authority/status summary, evidence-state
  counts, the rule-grouped Review queue, and a searchable/filterable Rule performance
  list. Selecting a rule opens its evidence, recommendations, thresholds, and recent
  history in context.
- **Outcomes** is a read-only evidence view backed by the same aggregate report used
  by **Analytics → Agent effectiveness**: the last seven complete UTC days compared
  with the preceding, non-overlapping 28 complete UTC days.
- **Policy & history** presents the editable tuner policy first, followed by the
  append-only tuning ledger and newest-active rollback controls.

The Outcomes workspace requires `metrics:view`. An operator with `automation:read`
but without that separate permission can continue to use Operations and Policy &
history while the Outcomes tab remains unavailable.

### Observed outcome evidence

Read the measurements separately:

- analyst-reported verdict agreement and material analyst correction rate are two
  views of one comparable analyst-grade quality cohort, not two independent votes;
- human review turnaround is the second, independent evidence domain; and
- confirmed false-negative and reopen-after-agent-close rates are safety guardrails
  that must be evaluable and unbreached before a favorable change is promoted.

The additive outcome layer also shows confirmed-positive rate among outcome-graded
cases, recorded case-linked AI processing cost, and the observed closure-elapsed
difference between agent-terminal and human-terminal cohorts. The elapsed comparison
is not active analyst time or payroll saved, and an absent human cohort remains
unavailable rather than receiving a default manual-triage benchmark. The cost is the
usage ledger's AI processing cost, not overtime or an invoice.

The Outcomes workspace preserves **Collecting evidence**, **Insufficient**,
**Unavailable**, and **Not applicable** states. Missing or undersized evidence is
never displayed as zero, and there is no composite improvement score. A metric
selector shows one daily trajectory at a time—agreement, correction, or review
turnaround—so ratios and elapsed time never share an axis and the page remains
scannable. Missing days stay as gaps and the selected view states how many days are
measurable. These daily cohorts are raw and unadjusted; the comparison metrics above
them are source-by-severity mix adjusted.

The quality-control rail shows comparable-mix coverage, confirmed false-negative and
reopen guardrails, retrieval coverage, exclusions, and suppressed strata. Applied
tuning events inside the reporting horizon are available in a collapsed chronology
for context only—no outcome is attributed to a change. Use **Analytics → Agent
effectiveness** for the complete evidence report, definitions, and cohort tables.

Durable **ingested** and **after clustering** counts show whether downstream volume is
moving. Tuning can change correlation thresholds and the workload promoted/opened
downstream; it does not change how many alerts an upstream source emits. Applied-change
context therefore carries `causal_claim=false`, and an apparent before/after movement
is an association to investigate rather than proof that tuning caused it. Week-over-
week means seven complete UTC days versus the prior seven; rolling 28 means the latest
28 complete days versus the prior 28, not calendar month over month.

Confirmed-positive cases are not divided by raw alerts: clustering makes them unlike
units, so that yield remains unavailable. The aggregate effectiveness report also
cannot infer source gaps. Separately, **Telemetry recommendations** can suggest one of
three supported sources—outbound DNS, endpoint process, or identity authentication—
only when a stored, versioned query/tool failure proves that the required field was
unavailable. Missing connector configuration and free-form model prose never qualify;
no qualifying proof means no recommendation.

This placement provides context for a tuning review; it does not prove that a tuning
change caused an observed outcome shift or that a model learned. Reading it performs
no model call or write, returns no case or source identifiers, and cannot alter a
recommendation or the deterministic case decision.

## Entity and source baselines

Open **Analytics → Baseline** to inspect learned series. The baseline is enabled by
default and stores compact aggregates rather than raw event history. It uses seasonal
hour-of-week buckets, exponentially weighted statistics, a bounded quantile sketch,
and a modified-z threshold of 3.5 after warm-up.

The default policy targets 14 days of warm-up and bounds stored series. A series can
be cold, warming, warm, or anomalous depending on its observations.

Baselines produce advisory anomaly and silent-source signals. Automatic anomaly
promotion into investigation remains a separate gated event-detection path. Do not
interpret a warm baseline as proof that the source mapping or receipt path is
complete.

## Review loop

1. Validate source coverage and mapping.
2. Gather enough analyst dispositions to clear the evidence threshold.
3. Filter or search Rule performance, then inspect the rule's observed and conservative
   false-positive rates, recommendation set, and shadow result.
4. Process the rule as one unit; the review-first default routes eligible changes to
   Approvals. If confirmed auto-apply was explicitly enabled, verify that shadow
   evaluation remains enabled and inspect the resulting ledger entry.
5. Monitor false positives, missed detections, spend, and downstream case volume.
6. Roll back the newest active change when the observed result is worse.

See [Detection and rules](rules.md), [Analytics](../analyst/analytics.md), and
[Campaigns](../analyst/campaigns.md).
