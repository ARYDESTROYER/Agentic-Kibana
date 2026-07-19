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

A cold tenant produces no recommendation. Applying a recommendation updates rule or
feed configuration and records the change; rollback restores the previous value.
Suppression that would drop data is proposed for human review rather than silently
activated.

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
2. Gather enough analyst dispositions to make the sample meaningful.
3. Inspect the recommendation, sample count, and shadow result.
4. Apply one bounded change.
5. Monitor false positives, missed detections, spend, and case volume.
6. Roll back when the observed result is worse.

See [Detection and rules](rules.md), [Analytics](../analyst/analytics.md), and
[Campaigns](../analyst/campaigns.md).
