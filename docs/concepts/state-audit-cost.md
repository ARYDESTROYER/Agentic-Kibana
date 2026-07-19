---
title: State, audit, and cost
description: Understand where TLSOC 0.1 stores its own data and how actions and model spend remain reviewable.
---

# State, audit, and cost

This page applies to **TLSOC 0.1** and is for operators and administrators planning
storage, retention, accountability, and spend controls.

## Source data and TLSOC state are different

TLSOC reads security events through connectors. Its own bookkeeping is stored behind
a `StateStore` abstraction.

| State backend | Intended use | Important note |
| --- | --- | --- |
| PostgreSQL + pgvector | Recommended self-contained stack | Stores relational/KV state and vector knowledge without Elasticsearch |
| SQLite | Single-node development and evaluation | Simple local state; not a scale-out profile |
| Elasticsearch | Legacy attachment or existing Elasticsearch operations | Requires a separate management credential for TLSOC-owned indices |

The state backend contains cases, configuration, cursors, usage, audit data, users,
sessions, collaboration, and knowledge. Selecting it does not select or migrate the
log source. Switching backends creates a separate state view unless you perform an
explicit migration.

## Audit trail

TLSOC records agent and operator actions in an append-oriented audit trail. Examples
include prompts, read-only queries, tool calls, context assembly, verdicts,
deterministic decisions, errors, polling, scans, lifecycle actions, and explicit
memory edits.

Audit records should answer:

- who or what acted;
- which surface, source, or case was involved;
- what action occurred;
- when it occurred; and
- whether the action succeeded or failed.

The console's Audit page is a review surface, not permission to alter history.

## Model usage and cost

All model-backed roles use one gateway. The gateway records model, role, input and
output tokens, cache/batch accounting, outcome, and calculated cost. Candidates that
never enter model investigation correctly cost `$0`.

The default daily budget performs a preflight check and can block new provider calls.
When blocked, the case routes to human review. The check is not an atomic spend
reservation, so already-running calls can finish above the configured amount.
Provider-side budgets and rate limits remain the final billing boundary.

## Secrets are not state

Persisted configuration stores secret presence, not secret values. Environment
variables provide the durable boot-time secret path. Values entered through the UI
or runtime secret endpoints are memory-only in TLSOC 0.1 and disappear on restart.

Do not include `.env`, access tokens, API keys, or raw notification credentials in
backups, support bundles, screenshots, or audit annotations.

## Operational checks

After onboarding or an incident exercise:

1. confirm the selected state backend is ready;
2. verify a case persists across an ordinary restart;
3. verify a state-changing action appears in Audit;
4. verify a model call appears once in Cost; and
5. compare the provider invoice with the TLSOC ledger.

## TLSOC 0.1 boundaries

SQL setup uses idempotent schema creation rather than an ordered migration ledger.
Backup, restore, forward-upgrade, interrupted-migration, and downgrade guarantees
must be established for your environment before relying on persistent production
state.

## Related pages

- [Architecture](architecture.md)
- [Deterministic decisions](deterministic-decisions.md)
- [Install TLSOC](../getting-started/install.md)
- [Configuration and secrets](../operations/configuration.md)
