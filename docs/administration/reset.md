---
title: Reset and recovery
description: Understand Agentic SOC's destructive reset scopes, safeguards, and recovery requirements.
---

# Reset and recovery

Reset removes Agentic SOC-owned state. It never deletes upstream log data and never erases
environment-provided secrets. Reset is destructive and is not a substitute for a
tested backup/restore process.

## Safeguards

`POST /api/admin/reset` requires:

- an administrator with the privileged user-management grant;
- a freshly reauthenticated session;
- settings not being in read-only mode;
- an exact type-to-confirm phrase;
- a successful audit write before the destructive step begins.

## Scopes

| Scope | Confirmation phrase | Intended effect |
|---|---|---|
| `cases` | `RESET CASES` | Clear Agentic SOC case-oriented state and related advisory counters while retaining configured sources and durable cost history where specified by the reset service |
| `sources` | `RESET SOURCES` | Remove configured sources, source cursors/mappings, and in-memory per-source secrets; does not delete data from upstream systems |
| `factory` | `FACTORY RESET` | Clear Agentic SOC-owned configuration/state and return the application to first-run setup |

The response returns the exact stores/categories reported as cleared. Review it rather
than assuming every external dependency was affected.

## What reset does not erase

- source-system logs, alerts, queues, or object-store objects;
- environment variables and deployment-managed credentials;
- container images or database backups;
- provider-side LLM usage and invoices.

A source or factory reset clears runtime connector secrets because the corresponding
source configuration no longer exists. Other boot-time environment secrets remain
outside the reset engine.

## Before reset

1. Export or back up the selected `StateStore`.
2. Record the application version and build information.
3. Export any cases or reports that must remain readily readable.
4. Confirm upstream retention and replay capability.
5. Inventory runtime-only secrets that must be re-entered.
6. Schedule a validation window and notify affected operators.

## After reset

Verify setup status, state-store readiness, source credentials, cursor position,
model routing, budget limits, authentication, and notification tests before admitting
real data. Replaying a retained source can recreate alerts and cases; idempotency does
not make an intentional full-state reset reversible.

See [Health, backup, and restore](../operations/health-backup.md) and
[Troubleshooting](../operations/troubleshooting.md).
