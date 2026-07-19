---
title: Playbooks and approvals
description: Run trusted procedures and keep consequential automation behind a human approval boundary.
---

# Playbooks and approvals

Playbooks are operator-authored Markdown procedures selected deterministically for a
case. They guide investigation; they do not override auto-close policy or directly
change case status.

## Select and run a playbook

Open a case and choose **Run playbook**. TLSOC matches playbooks against rule IDs,
entity type, MITRE techniques, minimum event count, and tags; priority and version
make selection deterministic when multiple procedures match. Running one starts a
case-context re-investigation, so it can consume model budget.

Reading the catalog requires `playbooks:read`; execution requires `playbooks:run`.
Reloading the on-disk catalog is an administrative Settings operation.

Before running:

1. confirm that the procedure applies to the case and environment;
2. review any outbound or destructive step as a human action outside the agent;
3. verify cost and model availability; and
4. record material results in the case timeline, thread, or tasks.

## Case automation and proposals

A case-automation rule may request approval instead of performing a consequential
action. Confirmed false positives can also draft a suppression proposal. These
proposals begin pending and do nothing until an authorized administrator approves
them.

Open **Triage → Approvals** to review:

- the proposed operation and payload;
- source case and evidence;
- confidence and rationale;
- expiry or scope; and
- audit history.

Approval and rejection are privileged administrative actions. Approval applies only
the allow-listed proposal type; it does not grant the model a general write channel.

## Safety model

Agent tools are assigned safety tiers. v0.1 investigation tools are read-only. A
future managed or outward action must remain audited and, where consequential,
approval-gated. Closing a case or approving a proposal is never an autonomous tool
action.

See [Detection and rules](rules.md), [Cases](../analyst/cases.md), and
[Knowledge and memory](../intelligence/knowledge-memory.md).
