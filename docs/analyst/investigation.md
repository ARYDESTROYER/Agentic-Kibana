---
title: Investigation
description: Run ad-hoc and case-based investigations while preserving evidence, cost, and decision provenance.
---

# Investigation

TLSOC supports two investigation paths. **Workspace → Investigate** starts with an
entity; a case's **Re-investigate** action starts with its stored evidence and context.
Both use the same metered gateway and deterministic case policy.

## Investigate an entity

1. Open **Triage → Workspace → Investigate**.
2. Choose IP, user, or host and enter the exact value.
3. Select the lookback and, when offered, a model override.
4. Review the retrieved event count before treating the answer as complete.
5. Open the resulting case to inspect evidence and the code decision.

The configured lookback begins at `now-24h` by default. If it finds no events, the
manual path can widen through seven days, 30 days, and one year before returning a
no-events result. Queries remain scoped to connected log sources.

Manual investigation requires `cases:reinvestigate` when RBAC is enabled.

## Re-investigate a case

Use re-investigation when new evidence arrived, a provider was restored, or an
analyst wants a different configured model to reassess the same story. TLSOC first
tries the case's stored event identifiers. If the source no longer retains those
events, it can rebuild a bounded cluster from the evidence already stored on the
case. The case is updated in place; it is not duplicated.

Re-investigation spends model tokens and creates usage-ledger entries. Confirm the
model and scope before applying it to many cases.

## Read the result in layers

In a case:

1. **Overview** answers what the source asserted and what work is pending.
2. **Timeline** shows when the pipeline stages occurred.
3. **Investigation** shows the agent assessment, confidence, evidence, recommended
   action, reproduction query, deterministic decision, and optional full trace.
4. **Threat** adds enrichment, ATT&CK, and related-case context.

The trace is diagnostic evidence, not a second decision system. Tool calls available
to the investigator are read-only log search, cached enrichment, and knowledge
retrieval.

## Chat in context

Open **Workspace → Chat** for general questions or the case's **Chat** tab for a
case-scoped conversation. The chat engine may query logs and retrieve knowledge, but
it cannot close a case or approve a proposal. On-screen fields and log-derived values
are treated as untrusted data.

## Failure and cost boundaries

- A provider or tool failure must not drop the alert; the case routes to human review.
- Every model call passes through the shared usage and cost ledger.
- Budget exhaustion stops the provider call before it starts and routes the case to
  `NEEDS_HUMAN`.
- Raw log streams are not sent wholesale to a model; evidence is selected or
  aggregated first.

Use [Logs and search](logs-search.md) to validate source facts and
[Knowledge and memory](../intelligence/knowledge-memory.md) to understand retrieved
context.
