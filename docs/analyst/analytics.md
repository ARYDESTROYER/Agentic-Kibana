---
title: Analytics and standup
description: Interpret v0.1 posture, timing, noise reduction, ATT&CK coverage, cost, and shift handoff metrics.
---

# Analytics and standup

Open **Analytics → Metrics** for measured posture and **Overview → Standup** for the
current action queue. Analytics are advisory: they describe stored cases and ingest
counters but never feed the case decision policy.

Posture and ATT&CK endpoints require `metrics:view` when RBAC is enabled.

## Timing definitions

TLSOC reports distributions, including p50 and p90 where available:

| Metric | v0.1 definition |
|---|---|
| MTTD | First member-event time to case creation |
| MTTA | Case creation to the first human acknowledgement |
| MTTR | Case creation to the first terminal resolved/closed transition |
| Dwell | Case creation to the first human response transition |

MTTA uses a human acknowledgement; an automatic close is not counted as a human
response. Missing eligible samples remain missing rather than being displayed as
zero.

## Posture and quality

The posture response includes lifecycle and verdict mix, aging, backlog, SLA state,
period-over-period comparisons, and analyst feedback coverage. Interpret agreement
rates together with graded-case and feedback counts.

SLA targets and impact × urgency priority are operator-configured advisory policies.
They rank work and measure response; they do not authorize automatic closure.

## Noise reduction

The noise-reduction view combines durable ingest counts with case outcomes. Its
stages distinguish received alerts, clusters/candidates, cases requiring attention,
automatic clears, escalations, and human closures. Inspect the per-stage definition
and source before comparing percentages.

The funnel is not evidence that every raw event received a model call. Deterministic
processing intentionally handles the broad event stream before a smaller set is
admitted to investigation.

## MITRE ATT&CK coverage

Coverage maps techniques recorded on cases to the bundled Enterprise ATT&CK corpus.
The page provides tactic and technique counts and can export an ATT&CK Navigator
layer. It measures observed case coverage, not preventive-control effectiveness. See
[MITRE and threat context](../intelligence/mitre-threat-context.md).

## Standup and handoff

The Standup report is built from aggregates, never a raw-log dump. It contains:

- urgency-ranked open, escalated, and needs-human cases;
- SLA and aging pressure;
- workload by assignee;
- current-versus-prior deltas; and
- action items and handoff acknowledgements.

Writing action items or acknowledgements requires `cases:write`.

## Cost

Open **Analytics → Cost** to inspect model calls, tokens, price source, outcomes, and
spend by model, role, surface, case, and time. Every model call must pass through this
ledger. A price is an estimate based on the active catalog or operator override; it
does not replace the provider invoice.

See [Analyst overview](overview.md) and [Cases](cases.md).
