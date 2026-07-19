---
title: Deployment
description: Deploy TLSOC 0.1 with the standalone stack or attach it safely to an existing log platform.
---

# Deployment

TLSOC 0.1 ships a FastAPI backend and a standalone web console. The recommended
deployment is the self-contained Compose stack with PostgreSQL and Redis. Existing
Elastic/OpenSearch/Wazuh systems remain external data sources; TLSOC consumes them
with least-privilege credentials.

## Choose a deployment shape

| Shape | Application state | Log sources | Use when |
|---|---|---|---|
| Standalone/agnostic | PostgreSQL + pgvector | Pull or push connectors | New deployment or no desired dependency on an existing Elasticsearch cluster |
| Existing ELK attachment | TLSOC-owned Elasticsearch indices | Read-only existing log indices | A compatible Elasticsearch stack is already operated and separate application-state privileges are acceptable |
| SQLite | Local database file | Pull or push connectors | Single-node evaluation and development only |

The standalone web UI is the supported interface. The archived Kibana plugin is not
built, tested, or shipped as part of 0.1.

## Prerequisites

- Docker with the Compose plugin for the reference stack;
- persistent storage for PostgreSQL or the selected state backend;
- a stable JWT and MFA key if authentication is enabled;
- at least one configured model provider for live LLM investigation, or an explicitly
  controlled mock/demo profile;
- source credentials scoped to the minimum required indices/APIs;
- HTTPS termination for any shared or non-loopback deployment.

## Standalone stack

1. Check out the accepted `v0.1.0` tag for Stable, or the `Testing` branch only for
   acceptance testing.
2. Copy `.env.example` to `.env` and set a strong PostgreSQL password.
3. Configure authentication and provider credentials.
4. Validate the rendered Compose configuration.
5. Build and start `deploy/docker-compose.agnostic.yml`.
6. Confirm liveness, readiness, and build information before opening the UI.
7. Complete first-run setup and add a synthetic source before real data.

The stack contains PostgreSQL/pgvector, Redis, the backend, and nginx-hosted web UI.
Redis is a cache, not the authoritative case/config store.

## Existing Elasticsearch attachment

Keep two physical credentials:

- a read-only log credential scoped only to the intended log indices;
- a management credential scoped only to TLSOC's own `tlsoc-agent-*` state indices.

Never use `elastic` or `kibana_system`. Mount the appropriate CA certificate read-only,
keep certificate verification enabled, and test the exact index patterns before enabling
background collection. TLSOC must not modify the upstream pipeline.

## Image identity

Backend and web images use the machine version `0.1.0` and accept OCI version,
revision, build-date, and source metadata. Record the image digest and
`/api/health/build-info` result with each deployment. Do not treat a mutable branch or
image tag as an immutable release identity.

Release channel is stamped independently from SemVer. Source builds default to
`TLSOC_RELEASE_CHANNEL=testing`; the accepted `main`/`v0.1.0` build must explicitly
set it to `stable`. This preserves the same `0.1.0` candidate identity through
acceptance without allowing a Testing build to report itself as Stable.

## Production boundaries

Version 0.1 is a single-replica reference deployment, not a high-availability claim.
There is no complete schema-migration framework, durable receipt ledger for every push
transport, or built-in secret manager. Read [Known limitations](../releases/known-limitations.md)
before admitting sensitive or loss-intolerant data.

Next: [Configuration reference](configuration.md), [Security hardening](security.md),
and [Health, backup, and restore](health-backup.md).
