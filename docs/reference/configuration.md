---
title: Configuration reference
description: Configuration authorities, environment wiring, durable preferences, runtime-only secrets, and state backends in TLSOC 0.1.
---

# Configuration reference

TLSOC 0.1 separates credentials and process wiring from validated application
preferences. Keep that boundary intact: a secret is never an ordinary setting.

## Configuration authorities

| Authority | Examples | Persistence | Managed through |
|---|---|---|---|
| Backend environment | state URL, provider keys, auth signing key, TLS paths | Deployment-owned | Process environment or `.env` |
| Organization preferences | sources, feeds, models, correlation, budgets, automation, branding, RBAC | Selected TLSOC state backend | TLSOC Console or `/api/settings*` |
| User preferences | theme, saved views, table layouts, personal dashboards | Selected TLSOC state backend | TLSOC Console or `/api/prefs/user`, `/api/views*`, `/api/dashboards*` |
| Runtime secret tier | wizard-submitted global keys and per-source/channel/provider secrets | Process memory only unless also supplied at boot | Secret-setting API routes |

`backend/app/config.py` defines both `Secrets` and `Preferences`. The settings schema
is available at `GET /api/settings/schema`; `GET /api/settings/{section}` returns a
validated section, while `GET`/`PUT /api/settings` operate on the preference document.

## Environment names

The backend reads **unprefixed** names, case-insensitively. For example:

```dotenv
STATE_BACKEND=postgres
STATE_DB_URL=postgresql+asyncpg://tlsoc:password@postgres:5432/tlsoc
AUTH_ENABLED=true
AUTH_JWT_SECRET=<stable-random-secret>
OPENAI_API_KEY=<secret>
```

The repository's Compose files accept selected root `.env` names prefixed with
`TLSOC_` and explicitly map them into the backend container. For example,
`TLSOC_OPENAI_API_KEY` becomes `OPENAI_API_KEY`. A prefixed variable has no effect
unless the selected Compose service maps it. Use `.env.example` and the Compose file
as the authority for those mappings.

Unknown values are ignored by the Pydantic settings loader. Validate spelling by
checking the relevant configured boolean or health/configuration surface rather than
assuming that a process-start succeeded with the intended value.

Release identity is the deliberate exception to the ordinary unprefixed settings
rule. The image/build pipeline passes these names directly:

| Variable | Meaning |
|---|---|
| `TLSOC_VERSION` | Compose image tag/build argument; must match the code's Semantic Version (`0.1.0`) |
| `TLSOC_RELEASE_CHANNEL` | `testing` by default; set to `stable` only for the accepted `main`/tag build |
| `TLSOC_BUILD_SHA` | Exact source commit embedded in `/api/health/build-info` and image metadata |
| `TLSOC_BUILD_DATE` | Build timestamp embedded in `/api/health/build-info` and image metadata |

The release channel is independent of SemVer: both the accepted Testing candidate and
its Stable promotion are application `0.1.0`. Promotion changes provenance/channel,
not the source version.

## Common backend environment variables

| Group | Variables | Notes |
|---|---|---|
| State | `STATE_BACKEND`, `STATE_DB_URL`, `ES_STORE_ENABLED` | Selects TLSOC-owned persistence; does not select a log source |
| Elasticsearch wiring | `ES_URL`, `ES_CA_CERT`, `ES_VERIFY_CERTS`, `ES_REQUEST_TIMEOUT` | Used by the implicit Elastic source and/or Elastic state backend |
| Elasticsearch keys | `ES_API_KEY`, `ES_MGMT_API_KEY` | Read-only log key and separate `tlsoc-agent-*` management key |
| LLMs | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `LITELLM_API_KEY`; Azure, Bedrock, and Vertex fields | Every call still goes through the TLSOC gateway and cost ledger |
| Enrichment | provider-specific API keys plus `EMBEDDING_API_KEY` | Keyless providers need no key; enabled/keyed filtering happens at dispatch |
| Cache | `REDIS_URL` | Enrichment caching degrades to an in-process cache when Redis is unavailable |
| Server | `BACKEND_HOST`, `BACKEND_PORT`, `LOG_LEVEL` | Uvicorn bind and logging configuration |
| Release identity | `TLSOC_VERSION`, `TLSOC_RELEASE_CHANNEL`, `TLSOC_BUILD_SHA`, `TLSOC_BUILD_DATE` | Direct prefixed build metadata; channel/SHA/date also reach the API runtime as non-secret identity |
| Authentication | `AUTH_ENABLED`, `AUTH_JWT_SECRET`, `AUTH_TOKEN_HOURS`, `AUTH_COOKIE_SECURE`, bootstrap user fields | Use a stable signing key and secure cookies behind HTTPS |
| Security middleware | `SECURITY_HEADERS_ENABLED`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_CAPACITY`, `RATE_LIMIT_REFILL_PER_SECOND`, `CSRF_ENABLED` | Headers default on; rate limiting and CSRF default off |
| Secret maps | `CONNECTOR_SECRETS`, `SSO_CLIENT_SECRETS`, `NOTIFICATION_SECRETS` | JSON objects parsed directly by the backend; mapping support differs by Compose file |
| MFA protection | `MFA_OBFUSCATION_KEY` | Stable key for TOTP-secret obfuscation; distinct from user preferences |

The reference standalone Compose file maps the SSO and notification JSON maps. It
does **not** map a `TLSOC_CONNECTOR_SECRETS` variable in 0.1. To boot per-source
connector secrets from the environment, pass the backend's unprefixed
`CONNECTOR_SECRETS` explicitly or add a deliberate Compose mapping.

## State backends

`STATE_BACKEND` controls only TLSOC-owned state: cases, audit, usage, preferences,
cursors, users/sessions, collaboration, baselines, campaigns, rule versions, and
knowledge/vector records. Connector credentials and external telemetry remain outside
that store.

| Value | Connection | 0.1 behavior |
|---|---|---|
| `postgres` | `postgresql+asyncpg://...` | Recommended standalone persistent profile; pgvector backs vector retrieval |
| `elasticsearch` | `ES_URL` plus `ES_MGMT_API_KEY` | Stores state in dedicated `tlsoc-agent-*` indices; the default when running the backend directly |
| `sqlite` | `sqlite+aiosqlite:///path/to/tlsoc.db` | Single-node file-backed profile; defaults to `./tlsoc.db` if the URL is omitted |

The standalone Compose stack fixes the backend to PostgreSQL and derives
`STATE_DB_URL` from `TLSOC_PG_*`. The legacy ELK merge uses Elasticsearch state.
When the Elasticsearch state path cannot initialize, the current implementation can
degrade to in-memory state; monitor readiness and do not mistake that fallback for
durable operation.

## Durable preferences

Every `Preferences` field has a default. Major blocks include:

- sources, feeds, OCSF field mappings, polling, and data scope;
- correlation, risk, rules, baselines, campaigns, threshold tuning, and autopilot;
- model routing, concurrency caps, batch processing, budgets, and pricing overlays;
- deterministic auto-close policy, case ID format, priority, and SLA targets;
- playbooks, RAG, memory, enrichment, threat context, and personas;
- auth policy, MFA/SSO metadata, RBAC, sessions, notifications, and realtime events;
- branding, terminology, themes, saved views, and dashboard defaults.

`PUT /api/settings` deep-merges a JSON object and validates the resulting complete
preferences model. Prefer small section-specific changes and re-read after updating.
A malformed value is rejected rather than persisted. General preference updates do
not provide a universal revision history in 0.1; detection rules have their own
version ledger and rollback endpoints.

## Secret durability and exposure

| Secret path | Stored where | Survives restart? | Read behavior |
|---|---|---|---|
| Environment/provider key | Deployment environment | Yes, if the deployment retains it | Configured boolean only |
| First-run `/api/setup/secrets` value | Process memory | No | Configured boolean only |
| `/api/sources/{source_id}/secrets` value | Per-source in-memory secret bucket | No, unless separately boot-supplied | Configured field names only |
| `/api/auth/sso/providers/{provider_id}/secret` value | In-memory SSO map | No, unless `SSO_CLIENT_SECRETS` is boot-supplied | Configured boolean by provider |
| `/api/notifications/channels/{channel_id}/secret` value | In-memory channel map | No, unless `NOTIFICATION_SECRETS` is boot-supplied | Configured field names/booleans only |
| User TOTP seed | User record, obfuscated | With the state store | Never returned after the setup flow |

Back up deployment secrets separately from the state database. A state backup alone
cannot restore provider, connector, SSO, notification, JWT-signing, or MFA-protection
keys.

## Safe configuration sequence

1. Select and initialize a durable state backend.
2. Configure HTTPS termination, authentication, a stable JWT secret, and secure cookies.
3. Add one least-privilege source credential and validate its data scope.
4. Configure one model provider and set a daily budget before enabling broad automation.
5. Review deterministic auto-close thresholds, RBAC, receiver authentication, and notification targets.
6. Back up state and deployment secrets through separate controlled procedures.
7. Record `/api/health/build-info` with the deployment inventory.

See [Operations configuration](../operations/configuration.md),
[Security](security.md), and [Models and spend](../administration/models-spend.md).
