---
title: Deterministic decisions
description: Learn why model verdicts are advisory and how Agentic SOC 0.1 code owns close, escalation, and human review.
---

# Deterministic decisions

This page applies to **Agentic SOC 0.1**. It explains the central safety contract for
analysts, administrators, and integrators: **the model supplies a verdict; code owns
the consequential case decision**.

## Verdict and decision are separate

The investigator can return one of three verdicts:

- `TRUE_POSITIVE`
- `FALSE_POSITIVE`
- `NEEDS_HUMAN`

The case manager then evaluates a pure policy over:

```text
verdict + confidence + deterministic risk score + operator auto-close policy
```

The policy result sets the case state and records a plain-language rationale. Model
text, a playbook, a notification, and a case-automation rule cannot directly set the
result.

## Auto-close policy

True-positive and false-positive verdict classes have independent settings:

- enabled or disabled;
- minimum confidence;
- maximum risk score; and
- human objection-window duration.

False-positive auto-close can be enabled with conservative thresholds. True-positive
auto-close is off by default and requires an explicit operator choice. If a class is
disabled or its confidence/risk bar is not cleared, the case routes to a human.

`NEEDS_HUMAN`, a missing verdict, and an unknown verdict are never auto-closable.
That rule is enforced in code and is not exposed as a setting.

## Escalation and analyst action

A high-severity true positive that does not auto-close can be escalated for priority
human attention. Escalation is not closure. Analysts can acknowledge, investigate,
hold, resume, resolve, reopen, escalate, de-escalate, and set a disposition through
guarded lifecycle actions.

Every transition records who or what made it, when it happened, and the reason.

## What automation may do

After the deterministic decision and case save, approved automation can:

- add tags;
- record recommendations;
- send notifications;
- request human approval; or
- queue an allowed playbook run.

It cannot change the close/escalate truth table. A playbook is investigation context,
not policy.

## Failure behavior

Missing provider credentials, provider errors, tool failures, invalid model output,
or an exhausted budget must not drop the signal. The safe result is human review.
Likewise, the event-feed risk gate decides whether to spend on investigation; it does
not modify canonical risk or close a case.

## Verify the contract

On a case's **Investigation** tab, compare:

1. the model verdict and confidence;
2. the deterministic risk score;
3. the pinned decision card and its policy rationale; and
4. the status-history and audit entries.

The four should tell one traceable story without implying that model prose executed
the action.

## Related pages

- [Architecture](architecture.md)
- [State, audit, and cost](state-audit-cost.md)
- [Create your first case](../getting-started/first-case.md)
- [Security](../operations/security.md)
