---
title: Cases
description: Find, assess, assign, progress, and close v0.1 cases without crossing the deterministic decision boundary.
---

# Cases

A case is TLSOC's durable, human-reviewable record for a correlated security story.
It preserves source provenance, selected event identifiers, risk, the agent verdict,
the code decision, analyst actions, cost, and an append-only lifecycle history.

## Find the work that matters

Open **Triage → Cases**. Search by display or internal case ID, title, entity, rule,
source, or tag. Narrow the table by status, disposition, severity, assignee, time, or
cross-source relationship. Saved views and column choices are personal preferences;
they do not change the underlying case.

Selecting rows opens bulk actions. Bulk operations execute the same server-side
action once per case and return individual successes and failures. A partial failure
does not make the successful changes disappear.

## Status and disposition are different

**Status** is the work lifecycle:

| Status | Meaning |
|---|---|
| New | Created but not yet investigated |
| Open / needs human | Investigated and awaiting an analyst |
| Investigating | An analyst or re-investigation is working the case |
| Escalated | Flagged for senior attention |
| On hold | Paused for information, maintenance, or a third party |
| Resolved | Work is complete and pending final close or audit |
| Closed | Terminal |

**Disposition** is the investigative outcome: true positive, false positive, benign,
suspicious, duplicate, or undetermined. Closing with a disposition records the
analyst's conclusion; it does not rewrite the earlier agent verdict.

## Work a case

The detail panel has six tabs:

- **Overview** — source facts, assessment summary, entity, risk, ownership, and
  provenance.
- **Timeline** — the chronological input → correlate → risk → triage → investigate →
  decide story.
- **Investigation** — AI assessment, pinned deterministic decision, and the full
  tool/reasoning trace.
- **Threat** — indicator reputation, ATT&CK context, and related cases.
- **Collab** — discussion, reactions, activity, and tasks.
- **Chat** — case-scoped questions using the shared chat engine.

From the header you can assign, tag, notify, run a playbook, re-investigate, export,
or use the lifecycle action appropriate for the current status. Exports are available
as JSON or a Markdown handoff report.

## Lifecycle actions and permissions

- Reading cases requires `cases:read`.
- Acknowledge, hold, resume, escalate, de-escalate, reopen, and non-terminal status
  changes require `cases:write`.
- Closing, resolving, or otherwise reaching a terminal state requires `cases:close`.
- Assignment requires `cases:assign`; discussion requires `cases:comment`.
- Re-investigation requires `cases:reinvestigate`; running a playbook requires
  `playbooks:run`.

The server rejects illegal transitions. Reopen a terminal case before moving it to
another non-terminal state; use the dedicated close or resolve action rather than a
generic status setter.

## Automatic decisions

The model produces `FALSE_POSITIVE`, `TRUE_POSITIVE`, or `NEEDS_HUMAN` with a
confidence value. Deterministic code then compares the verdict, confidence, risk,
and configured auto-close policy.

- False-positive auto-close is enabled by default only above its confidence bar and
  below its risk ceiling.
- True-positive auto-close is disabled by default and requires an explicit operator
  opt-in.
- `NEEDS_HUMAN` and missing verdicts can never auto-close.
- Automatically closed cases record an objection window and remain reopenable by
  an authorized analyst.

Analyst actions and automatic decisions are separately attributed in the history and
audit log.

## Close the feedback loop

When closing or resolving, select a disposition deliberately and grade the AI result.
Confirmed false positives can produce a pending suppression proposal and can be
indexed as prior-case context. Neither process silently changes decision policy.

See [Investigation](investigation.md), [Collaboration](collaboration.md), and
[Playbooks and approvals](../automation/playbooks-approvals.md).
