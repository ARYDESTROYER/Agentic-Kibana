---
title: Workspace Chat
description: Ask read-only questions, return to saved analyst conversations, and inspect the source, model, evidence, and cost behind each answer.
---

# Workspace Chat

Open **Triage → Workspace → Chat** for a personal analyst conversation that can
query connected telemetry and retrieve Agentic SOC knowledge. Workspace Chat uses
the same read-only chat engine as the Case Manager **Chat** tab, but its conversation
history is scoped to the signed-in operator rather than to one case.

Chat can help explain an indicator, summarize bounded findings, or continue a line of
inquiry across shifts. It cannot close a case, approve a proposal, change a source, or
write back to upstream telemetry. Treat every answer as investigation assistance and
open its evidence before acting on it.

## Start or resume a conversation

The desktop workspace keeps the newest saved conversations in a searchable history
rail. On a narrow screen, **History** opens the same list in a Sheet so the active
thread keeps the available width. Select a conversation to restore its authoritative
server-saved transcript. Use the row menu to rename or delete one.

**New chat** begins as an unsaved draft. It enters history only after the first
assistant response succeeds and the state backend confirms that the exchange was
stored. A cancelled request, provider failure, or failed history write therefore does
not create a conversation that only appears durable. The first saved exchange creates
a deterministic title that you can rename later.

Unsent text is preserved separately in the current browser for each conversation and
for the new-chat draft. It is not server history until you send it. History refreshes
when Chat opens or regains focus, and same-browser tabs announce history changes, so a
rename, deletion, or new thread can appear without a route reload.

## Scope the question

The active thread has one readiness indicator and one composer docked at the bottom.
Open the composer controls to choose a queryable source or model. The current choices
remain visible below the input.

Source selection is strict:

- when you explicitly select a source, Chat uses that source or reports that the
  source is unavailable;
- it never silently falls back to Primary after an explicit selection; and
- Primary is used only when no source was selected.

Each saved assistant turn retains the effective source and model that actually served
it. Changing the composer controls later does not rewrite the provenance of an earlier
answer. While a saved thread is restoring or the agent is working, thread switching
and the composer stay disabled so a response cannot land in the wrong conversation.

## Inspect evidence and execution

An answer can include a bounded table plus an analysis derived from a read-only source
query. Log-derived fields, selections, retrieved knowledge, and query context are
handled as untrusted data; they never become instructions to the agent.

Open **Evidence & execution** beneath an assistant turn to inspect the detail available
for that answer, including:

- the read-only query and tools used;
- retrieved knowledge or citations;
- available reasoning and supporting evidence;
- the effective source and model; and
- the metered cost recorded for the turn.

A compacted saved turn says when larger evidence structures were omitted. The
transcript follows new replies only while you are already near the bottom. If you
scroll up to inspect earlier evidence, use **Jump to latest** instead of being moved
away from the material you are reading.

## History and retention boundaries

Workspace history retains up to **50 conversations per user** and **100 messages per
conversation**. When the boundary removes older material, the workspace marks the
retained history as incomplete rather than presenting it as the entire transcript.
Conversations from before durable Workspace history was introduced lived only in the
browser and cannot be recovered or backfilled.

Saved conversation history is a navigation aid, not the audit or cost ledger. Use the
Audit and Analytics cost surfaces for governed activity and metering records.

## Recover from a failure

A history-store failure is shown as a retryable error, never as an empty account. If a
saved conversation cannot be restored, use **Retry** or **Start new chat** without
losing the surrounding history workspace. If no model provider is configured, Chat
states that the assistant is unavailable and directs an administrator to Models or
Settings; it does not silently fail.

Agentic SOC uses stable request identity behind the interface so an ambiguous network
retry can return the one committed turn instead of appending and billing it twice. A
request that is still running, exceeds the bounded per-user request capacity, loses
its explicit source, or cannot verify history persistence is reported as a typed,
retryable failure where applicable.

## Workspace Chat and case-scoped Chat

| Surface | Use it for | History boundary |
| --- | --- | --- |
| **Workspace → Chat** | Reusable analyst questions across telemetry, indicators, and posture | Personal saved Workspace conversations |
| **Case Manager → Chat** | Evidence and follow-up tied to the selected case | The case workspace; never copied into personal Workspace history |

Use [Investigation](investigation.md) to understand the broader entity and case
workflow, [Logs and search](logs-search.md) to inspect telemetry directly, and
[Case Manager](case-manager.md) for actions on a selected case.
