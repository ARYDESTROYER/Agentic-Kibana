---
title: Detection and rules
description: Author, preview, version, and roll back v0.1 detection and case-automation rules.
---

# Detection and rules

Open **Settings → General → Detection & rules**. The unified catalog exposes three
rule tiers while preserving their different responsibilities.

| Tier | Purpose |
|---|---|
| Detection match/threshold | Classify matching events and define when a grouped set fires |
| Anomaly/baseline | Surface deviations from learned aggregate behavior |
| Case automation | React after a case has been saved and decided |

Reading the catalog, previews, and version history requires `rules:read`. Creating,
editing, enabling, deleting, rolling back, or otherwise managing a rule requires
`rules:manage`.

## Detection rules

A detection rule combines:

- identity, name, description, enabled state, priority, and tags;
- a match definition over event fields; and
- a trigger definition such as every match or a threshold count within a window,
  grouped by an entity.

Keep rule names stable and descriptions operational. Validate field paths against
normalized events in [Logs](../analyst/logs-search.md) before enabling a rule broadly.

## Case-automation rules

Case automation evaluates all configured conditions after the deterministic decision
and initial save. Supported actions are tag, recommend, notify, run a playbook, or
request human approval. A rule cannot set status or disposition.

Conditions can constrain verdict, minimum risk or severity, status, source, rule,
and entity type. Rules run in priority order; lower numbers run first.

## Preview before saving

Preview evaluates the proposed rule and recent data without persisting the rule. The
decision preview is a pure what-if: it does not call the LLM, write usage, or mutate a
case. Treat the preview's sample count and time window as part of the result.

## Versions and rollback

Each meaningful edit appends an immutable version record. The history is newest
first and includes the action and saved configuration. Rollback restores a selected
configuration by appending a new rollback version; it never deletes earlier history.

After rollback, preview again and monitor case and noise metrics. See
[Tuning and baselines](tuning-baselines.md) for generated recommendations and
[Playbooks and approvals](playbooks-approvals.md) for actions requiring review.
