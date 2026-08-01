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

1. Check out the accepted `v0.1.1` tag for Stable, or the `Testing` branch only for
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

The remote now uses `Testing` for integration and default `main` for accepted Stable
source, and it has the `v0.1.1` release tag. A pull of `main` receives the current
accepted Stable tree while integration work continues on `Testing`. Branch
protections, required checks, and release-environment policy remain repository
settings that administrators must verify independently.

## Existing Elasticsearch attachment

Keep two physical credentials:

- a read-only log credential scoped only to the intended log indices;
- a management credential scoped only to Agentic SOC's own `tlsoc-agent-*` state
  indices, with cluster `manage_ilm`, `manage_index_templates`, and `monitor` when native lifecycle is applied.

Never use `elastic` or `kibana_system`. Mount the appropriate CA certificate read-only,
keep certificate verification enabled, and test the exact index patterns before enabling
background collection. Agentic SOC must not modify the upstream pipeline.

## Own-state lifecycle and archive boundary

The desired default under **Settings → Organization → Storage & retention** is
Hot for 180 days, Warm for another 90 days, then archive from day 270 to AWS S3
Glacier Flexible Retrieval. Deletion is always off. This preference applies only to
Agentic SOC-owned state; source log/index/bucket retention remains external and
read-only.

Native enforcement is currently limited to Elasticsearch ILM for the append-only
audit and usage/cost ledgers. Preview must confirm `manage_ilm`,
`manage_index_templates`, `monitor`, and hot /
warm tier capability before an administrator performs the explicit, freshly
authenticated Apply. Cases and operational metadata stay Hot because they are
mutable. PostgreSQL reports the policy as advisory; SQLite reports export-only.

Archive is a desired target, not an active pipeline in 0.1.1. Build a separate
immutable export with a manifest and checksums, verify restore, and only then place
those independent archive objects under an S3 lifecycle rule. **Never transition an
Elasticsearch snapshot-repository prefix to Glacier**; Elasticsearch expects its
repository objects to remain directly readable.

## Image identity

Backend and web images use the machine version `0.1.1` and accept OCI version,
revision, build-date, and source metadata. Record the image digest and
`/api/health/build-info` result with each deployment. Do not treat a mutable branch or
image tag as an immutable release identity.

Release channel is stamped independently from SemVer. Source builds default to
`TLSOC_RELEASE_CHANNEL=testing`; the accepted `main`/`v0.1.1` build must explicitly
set it to `stable`. This preserves the same `0.1.1` candidate identity through
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

The web artifact's `/release.json` and `/index.html` must be served with no-store
semantics. After a different release has been deployed, **Update available** may
appear beside the badge only when its version, channel, non-`unknown` SHA, and
non-`unknown` build time exactly match backend build-info
and healthy readiness. The operator confirms activation; the Console repeats the
manifest/build-info/health checks, verifies `/index.html`, and only then reloads the
same hash route. Any failed or incoherent check leaves the existing document usable.
This browser flow does not deploy, restart, migrate, promote, or roll back anything.
Builds left at the safe `unknown` SHA/date defaults remain operable but do not advertise
an update; release automation must stamp both artifacts identically.

Retain the previous release's immutable hashed assets for the full observation
window, or use blue-green serving that keeps the old origin available until open
sessions drain. Otherwise an existing tab can fail while requesting an old lazy
chunk before activation, which violates the graceful-rollout contract.

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
