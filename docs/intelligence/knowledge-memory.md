---
title: Knowledge and memory
description: Manage retrieved procedures and durable operator facts with explicit trust boundaries.
---

# Knowledge and memory

Open **Intelligence → Knowledge** for the retrieval corpus and
**Intelligence → Memory** for durable operator facts. Both can ground an
investigation, but they have different trust and lifecycle rules.

## Knowledge base

The built-in corpus contains runbooks, MITRE ATT&CK reference text, and suppression
guidance. When enabled, resolved-case summaries can also be indexed for similarity.
Knowledge search combines lexical and vector retrieval and returns source and score
metadata.

Use the Knowledge page to:

1. inspect corpus and chunk statistics;
2. list and open documents;
3. import a bounded Markdown or plain-text document;
4. test a retrieval query; and
5. delete an imported document that is no longer valid.

Import and deletion require `rag:manage`. Seed material is protected from ordinary
deletion; overriding that protection requires an explicit force operation.

## Trust labels

Only the system-verified `runbook`, `mitre`, and `suppression` sources are treated as
trusted reference material in a prompt. Imported documents, pasted threat
intelligence, resolved-case summaries, and unknown future source types are fenced as
untrusted data before model use.

Importing a document does not promote it to trusted instructions. Review provenance,
age, owner, and scope before relying on any retrieved statement.

## Operator memory

Memory stores explicit facts an operator wants the agent to remember, such as known
scanner ranges, asset roles, or local conventions. Memory entries can be active or
inactive and remain attributable.

Creating, editing, or deleting memory requires `memory:manage`; reading requires the
deployment's normal authenticated access. Do not store credentials, personal data
that is not required for triage, or unverified claims copied from logs.

Memory informs answers and investigations but cannot alter the deterministic case
decision.

## Hygiene

- Keep each entry narrow, dated, and attributable.
- Deactivate or delete obsolete facts.
- Prefer a versioned runbook for procedures and memory for short local facts.
- Test retrieval after large corpus changes.
- Treat missing retrieval as degraded context, not permission to drop a case.

See [Enrichment](enrichment.md), [MITRE and threat context](mitre-threat-context.md),
and [Playbooks and approvals](../automation/playbooks-approvals.md).
