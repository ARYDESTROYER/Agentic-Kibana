---
title: Automation and autopilot
description: Understand which v0.1 automation is on, what remains opt-in, and where human authority is enforced.
---

# Automation and autopilot

Agentic SOC v0.1 starts in the **balanced** autopilot profile. It performs broad,
low-cost deterministic processing and admits selected candidates to metered
investigation. Autopilot is not permission for a model to close or act outside the
configured deterministic policy.

## Default posture

Fresh v0.1 preferences enable:

- polling and background scanning;
- event correlation and risk scoring;
- a risk-gated automatic investigation path for event feeds;
- cross-source related-case linking;
- threshold tuning with shadow evaluation;
- baselines, campaign correlation, SLA, and priority policy;
- realtime updates; and
- the case-automation engine with an empty rule set.

Batch inference is off by default. Notifications, playbook-running automation, and
case-automation rules are operator choices rather than hidden defaults.

## Admission, spend, and caps

Alert-role feeds enter investigation without the event-feed risk gate. Event-role
clusters are still recorded, correlated, and risk-scored; the balanced default sends
clusters at risk 70 or higher to investigation. A per-source tick admits at most 25
automatic investigations and drains cap-deferred candidates on later ticks.

The default budget is enabled at USD 10 per day, warns at 80%, and blocks a new
provider call at the ceiling. A blocked call routes to `NEEDS_HUMAN`; it is not
dropped or closed. Calls already in flight are not an atomic spend reservation, so
provider-side budgets remain necessary.

## The decision boundary

Automation can correlate, prioritize, enrich, investigate, tag, recommend, notify,
run a playbook re-investigation, or create an approval proposal. Automatic case
closure is produced only by the deterministic case manager:

- false-positive auto-close is policy-gated;
- true-positive auto-close is off by default; and
- needs-human can never auto-close.

## Tune the system deliberately

Use **Settings → General → Detection** for risk, correlation, escalation, and
auto-close policy. Use **Settings → General → Detection & rules** for authored rules,
and **Platform → Auto-tuning** for data-backed threshold recommendations.

The named autopilot profile adjusts the risk floor, daily budget, and per-tick cap
together. Review all three effective values before changing profiles.

Next: [Detection and rules](rules.md), [Tuning and baselines](tuning-baselines.md),
and [Playbooks and approvals](playbooks-approvals.md).
