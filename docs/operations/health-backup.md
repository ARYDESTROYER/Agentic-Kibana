---
title: Health, backup, and restore
description: Monitor TLSOC health, capture release identity, and protect application state and secrets.
---

# Health, backup, and restore

Health checks answer different questions. Use the narrow endpoint that matches the
orchestrator decision you are making.

## Health endpoints

| Endpoint | Meaning | Expected use |
|---|---|---|
| `/api/health/live` | The process can serve requests | Restart/liveness probe |
| `/api/health/ready` | TLSOC can use the selected state store, including a bounded write-path probe | Traffic/readiness gate; returns 503 when unavailable |
| `/api/health` | Backward-compatible aggregate status used by the web UI | Human/UI summary |
| `/api/health/build-info` | Version, release channel, commit/build metadata, state backend, and OCSF version | Support and deployment inventory |

Readiness does not prove that every connector, model provider, enrichment service, or
notification channel is healthy. Use source health/coverage, provider tests, and
notification tests for those dependencies.

## What to back up

- The selected `StateStore`: cases, audit, usage, configuration, cursors, users,
  sessions, knowledge, and feature KV documents.
- PostgreSQL roles/extensions and schema when using the standalone stack.
- The SQLite database file only after quiescing writes or using a consistent database
  backup mechanism.
- TLSOC-owned Elasticsearch indices and their templates when using ES state.
- Deployment configuration, CA material, JWT/MFA keys, and all external secrets in a
  separate protected secret backup.
- The exact application version, commit SHA, image digests, and Compose configuration.

Redis is an optimization/cache and is not the authoritative application backup.
Upstream logs remain in their source systems and require their own retention/backup.

## Backup procedure

1. Record build information and state-backend type.
2. Stop or quiesce ingestion for a consistency-sensitive backup.
3. Use the database/vendor-supported snapshot or dump mechanism.
4. Back up deployment secrets separately.
5. Encrypt, checksum, and retain the artifacts under access control.
6. Resume ingestion and confirm cursor/source coverage.

## Restore test

Restore into an isolated environment with the same application version. Supply secrets,
start the state dependency, then the backend, and verify readiness before the web UI.
Check users/login, settings, cases, audit, usage, knowledge, source cursors, and a
synthetic connector. Confirm that notification and model tests cannot reach production
destinations from the restore environment.

## Limitations

TLSOC 0.1 has no built-in backup scheduler or complete versioned database migration
framework. A successful dump is not sufficient evidence; test a full restore and retain
upstream data long enough to replay after failure.

See [Upgrades](upgrades.md), [Reset and recovery](../administration/reset.md), and
[Troubleshooting](troubleshooting.md).
