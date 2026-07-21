---
title: Deployment
description: Deploy Agentic SOC 0.1 with the standalone stack or attach it safely to an existing log platform.
---

# Deployment

Agentic SOC 0.1 ships a FastAPI backend and a standalone web console. The recommended
deployment is the self-contained Compose stack with PostgreSQL and Redis. Existing
Elastic/OpenSearch/Wazuh systems remain external data sources; Agentic SOC consumes them
with least-privilege credentials.

## Choose a deployment shape

| Shape | Application state | Log sources | Use when |
|---|---|---|---|
| Standalone/agnostic | PostgreSQL + pgvector | Pull or push connectors | New deployment or no desired dependency on an existing Elasticsearch cluster |
| Existing ELK attachment | Agentic SOC-owned Elasticsearch indices | Read-only existing log indices | A compatible Elasticsearch stack is already operated and separate application-state privileges are acceptable |
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

The stack contains PostgreSQL/pgvector, Redis, the backend, and the nginx-hosted
Console. The web image serves both the compiled SPA and the version-matched Help
Center at `/docs/0.1/`, and proxies `/api/*` to the backend. Redis is a cache, not
the authoritative case/config store.

The current remote has not yet provisioned literal `main` or the `v0.1.0` tag; it
exposes `Testing` and legacy/default `claude/main`. Until the repository owner
completes the documented promotion setup, only the Testing checkout is available
and it is not a supported Stable release. After provisioning, a pull of `main`
receives the last accepted Stable tree while integration work continues on
`Testing`.

## Existing Elasticsearch attachment

Keep two physical credentials:

- a read-only log credential scoped only to the intended log indices;
- a management credential scoped only to Agentic SOC's own `tlsoc-agent-*` state indices.

Never use `elastic` or `kibana_system`. Mount the appropriate CA certificate read-only,
keep certificate verification enabled, and test the exact index patterns before enabling
background collection. Agentic SOC must not modify the upstream pipeline.

## Image identity

Backend and web images use the machine version `0.1.0` and accept OCI version,
revision, build-date, and source metadata. Record the image digest and
`/api/health/build-info` result with each deployment. Do not treat a mutable branch or
image tag as an immutable release identity.

Release channel is stamped independently from SemVer. Source builds default to
`TLSOC_RELEASE_CHANNEL=testing`; the accepted `main`/`v0.1.0` build must explicitly
set it to `stable`. This preserves the same `0.1.0` candidate identity through
acceptance without allowing a Testing build to report itself as Stable.

Set `TLSOC_VERSION`, `TLSOC_RELEASE_CHANNEL`, `TLSOC_BUILD_SHA`, and
`TLSOC_BUILD_DATE` explicitly through the reference Compose build. Its Dockerfiles
already label the canonical repository as `TLSOC_SOURCE_URL`; a fork must override
that Docker build argument directly or add a deliberate Compose mapping. Verify the
running channel and commit at `/api/health/build-info`; verify the image label
`dev.tlsoc.release.channel` as part of artifact acceptance. The Console's
always-visible `vX.Y.Z · Testing|Stable` badge reconciles its compiled stamp with
backend build-info; open the badge to inspect both identities. Any version,
channel, or known-SHA mismatch displays Testing. This operator aid complements,
but does not replace, digest and endpoint verification.

After deployment, open **Documentation** from the navigation rail and confirm it
stays on the deployment origin at `/docs/0.1/`. Installed help is part of the web
artifact and should remain available in an isolated network; public Stable and
Development documentation are secondary references.

## Production boundaries

Version 0.1 is a single-replica reference deployment, not a high-availability claim.
There is no complete schema-migration framework, durable receipt ledger for every push
transport, or built-in secret manager. Read [Known limitations](../releases/known-limitations.md)
before admitting sensitive or loss-intolerant data.

Next: [Configuration reference](configuration.md), [Security hardening](security.md),
and [Health, backup, and restore](health-backup.md).
