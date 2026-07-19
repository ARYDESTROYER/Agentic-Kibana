---
title: Analyst overview
description: Start a shift from the v0.1 Security Command Center and move from posture to action.
---

# Analyst overview

The **Overview → Dashboard** page is the operational starting point for a shift. It
combines case pressure, response timing, source coverage, and recent outcomes without
changing any case or detection policy.

## Read the page from top to bottom

1. **Decision brief** — scan current risk, SLA pressure, and the highest-value case
   movement first.
2. **Case KPIs** — review cases opened and resolved, the open queue, and the
   needs-human workload for the selected time window.
3. **Burndown and response timing** — look for backlog growth and changes in MTTD,
   MTTA, MTTR, or dwell.
4. **Top open cases** — open a case to see the source facts, investigation, and
   deterministic decision separately.
5. **Deeper analytics** — inspect autonomy, connector coverage, case volume,
   workload, outcomes, top signatures, and top entities.

The dashboard shows an explicit empty or degraded state when there is not enough
data. A zero is not substituted for a timing metric that has no eligible samples.

## Provenance matters

TLSOC keeps three responsibilities separate:

- **Source says** — fields and detections reported by a connected system.
- **Agent found** — the model's assessment, supporting evidence, confidence, and
  recommended action.
- **Code decided** — the deterministic policy result that controls automatic close
  or human review.

Use [Cases](cases.md) for the full record. A model verdict is never, by itself, an
authorization to close a case.

## Time and scope

Dashboard values are windowed rollups. Compare the selected period with its previous
period instead of comparing tiles that use different windows. Timing cards expose
their sample availability, and source coverage is reported independently of case
volume: a quiet source and an unread source are not the same condition.

The posture endpoints require `metrics:view` where RBAC is enabled. Case drill-down
requires `cases:read`; source health requires `sources:read`.

## Custom views

Open **Overview → Dashboards** to use or clone a role-oriented dashboard. A custom
dashboard is personal presentation state: changing its name, widgets, or layout does
not alter detection, risk, or case decisions.

The v0.1 widget catalog includes:

- needs-human queue and LLM cost/budget KPIs;
- open-by-severity and autonomous-versus-human charts;
- lifecycle timing;
- connector health and recent-case tables;
- MITRE ATT&CK coverage; and
- the active-risk gauge.

Widgets are filtered by the same permissions as their underlying data. Unknown or
retired widget types are ignored when a saved layout is loaded.

## A practical shift loop

1. Check coverage before trusting volume-based conclusions.
2. Open the highest-risk or SLA-pressured case.
3. Acknowledge it before beginning work so response timing remains meaningful.
4. Record findings, tasks, disposition, and feedback in the case.
5. Use **Overview → Standup** for the attention queue and shift handoff.

Continue with [case handling](cases.md), [analytics](analytics.md), or
[collaboration](collaboration.md).
