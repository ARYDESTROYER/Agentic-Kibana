---
title: API reference
description: Curated Agentic SOC API endpoint groups, authentication, pagination, realtime events, and OpenAPI discovery for version 0.1.
---

# API reference

The **Agentic SOC API** is the FastAPI service behind the Agentic SOC Console. This page covers
the public HTTP surface in application version **0.1.0** and documentation line
**0.1**. The API is mounted at `/api`; the service root is `/`.

## Interactive and machine-readable specifications

Each running API publishes:

- Swagger UI at `/docs`;
- the OpenAPI document at `/openapi.json`;
- build identity at `/api/health/build-info`.

Build information reports the application version, independent release channel,
commit SHA, build time, state backend, and OCSF version. A Testing candidate and its
Stable promotion both remain `0.1.0`; `TLSOC_RELEASE_CHANNEL` distinguishes
`testing` from the accepted `stable` build.

The committed 0.1 OpenAPI snapshot contains 190 paths and 223 operations. It is the
best source for current request-body models, enums, parameters, and operation IDs.
Some handlers return plain dictionaries without a FastAPI `response_model`, so their
generated response schema is intentionally less specific than the runtime payload.
The specification also does not declare tags or an OpenAPI security scheme in 0.1.
Runtime authentication and authorization still apply as described below.

Because `/docs` and `/openapi.json` sit outside the protected `/api` router, restrict
them at the reverse proxy if publishing the route inventory is not acceptable in your
environment.

## Base URL and JSON

The Agentic SOC Console uses relative `/api/*` URLs. External clients should use the same
HTTPS origin exposed by the deployment proxy:

```text
https://soc.example.com/api/cases
```

Requests with a body use `Content-Type: application/json`. Errors normally use
FastAPI's `{"detail": ...}` envelope. Validation failures return HTTP 422.

## Authentication

Authentication is disabled by default in the base configuration. When enabled, the
API accepts either:

- the HTTP-only `tlsoc_token` cookie issued by `/api/auth/login`; or
- `Authorization: Bearer <token>` using the token returned by that login.

For example, with a cookie jar:

```bash
curl --fail-with-body \
  --cookie-jar tlsoc.cookies \
  --header 'Content-Type: application/json' \
  --data '{"username":"analyst","password":"replace-me"}' \
  https://soc.example.com/api/auth/login

curl --fail-with-body \
  --cookie tlsoc.cookies \
  'https://soc.example.com/api/cases?limit=25&offset=0'
```

An MFA-enabled account receives a short-lived `pending_token` after password
verification and completes sign-in through `/api/auth/mfa/verify`. Session refresh,
revocation, and step-up reauthentication have dedicated endpoints in the auth group.

Authentication is applied centrally to the `/api` routers. A small bootstrap and
health allowlist remains public; `POST /api/ingest/{source_id}` performs receiver-level
bearer or HMAC authentication instead. State-changing routes also enforce resource and
action permissions when RBAC is enabled. See [Permissions](permissions.md) and
[Authentication](../administration/authentication.md).

## Endpoint groups

The table is a curated map of the full surface. Use `/docs` or `/openapi.json` for
the exact request model and every operation under a prefix.

| Area | Principal operations | Purpose |
|---|---|---|
| Service and health | `GET /`, `GET /api/health`, `/live`, `/ready`, `/build-info` | Service discovery, probes, dependency readiness, and release identity |
| First-run setup | `GET /api/setup/status`; `POST /api/setup/account`, `/secrets`, `/complete` | Bootstrap the first account, submit runtime secrets, and complete setup |
| Authentication | `/api/auth/login`, `/logout`, `/refresh`, `/reauth`, `/change-password`; `/api/auth/mfa/*`; `/api/auth/sso/*` | Password sessions, MFA, refresh rotation, step-up authentication, and OIDC |
| Account and sessions | `/api/account/*`, `/api/me/avatar`, `/api/sessions*`, `/api/admin/sessions*` | Profile, effective permissions, activity, and session revocation |
| Users and roles | `/api/users*`, `/api/roles*` | User lifecycle, built-in/custom roles, permission preview, and simulation |
| Connector catalog | `GET /api/connectors`, `GET /api/connectors/{source_type}`, `POST /api/connectors/test` | Discover connector manifests and test source access |
| Sources and ingest | `/api/sources*`, `POST /api/ingest/{source_id}`, `POST /api/poll`, `GET /api/logs` | Configure feeds, accept pushed records, poll pull sources, inspect health, and browse logs |
| Cases | `GET /api/cases`, `GET /api/cases/{case_id}`, `POST /api/cases/bulk` | List, filter, retrieve, export, and act on cases |
| Case investigation | `/api/cases/{case_id}/triage`, `/timeline`, `/trace`, `/stages`, `/rationale`, `/threat-context`, `/forwarding`; `POST /investigate`, `/reinvestigate`, `/feedback` | Explain evidence, agent work, deterministic routing, and analyst feedback |
| Case collaboration | `/api/cases/{case_id}/thread*`, `/tasks*`, `/activity`, `/comment`, `/assign`, `/tags`, `/notify` | Discussion, reactions, tasks, ownership, activity, and manual notification |
| Workspace | `POST /api/chat`, `POST /api/investigate`, `POST /api/overview`, `GET /api/search`, `/scans`, `/personas` | Console chat, entity investigation, cross-surface search, scan queues, and personas |
| Detection and automation | `/api/rules*`, `/api/tuning*`, `/api/baseline*`, `/api/campaigns*`, `/api/batch*`, `/api/proposals*` | Rule lifecycle, safe preview/version rollback, recommendations, baselines, campaigns, batch jobs, and approvals |
| Playbooks | `GET/POST /api/playbooks`, `GET/PUT /api/playbooks/{playbook_id}`, `POST /api/playbooks/reload`, `GET /api/playbooks/selection/{case_id}`, `POST /api/cases/{case_id}/run-playbook` | Catalog/open, protected operator-file management, deterministic selection, hot reload, and case execution |
| Knowledge and memory | `/api/rag/*`, `/api/memory*`, `/api/runbooks`, `POST /api/threat-context/import` | Import/search/delete knowledge, manage operator memory, and inspect runbooks |
| Enrichment and MITRE | `/api/enrichment/*`, `/api/mitre/coverage*`, `GET /api/cases/{case_id}/threat-context` | IOC enrichment, provider configuration, ATT&CK coverage, and Navigator export |
| Dashboards and metrics | `/api/dashboards*`, `/api/metrics*`, `/api/feedback/stats`, `/api/usage/summary`, `/api/cost/estimate` | Personal dashboards, posture/noise metrics, usage, feedback, and cost estimates |
| Standup and handoff | `/api/standup*` | Shift report, acknowledgements, and action items |
| Notifications | `/api/notifications/providers`, `/channels/*`, `/preview`, `/test`, `/prefs`, `/inbox*` | Channel catalog/secrets, safe previews, tests, per-user preferences, and in-app inbox |
| Preferences and presentation | `/api/settings*`, `/api/prefs/*`, `/api/branding`, `/api/terminology`, `/api/views*`, `/api/budget*`, `/api/llm/*`, `/api/models` | Organization/user preferences, saved views, model routing/pricing, branding, and budget controls |
| Portable data export | `POST /api/admin/export` | Download selected, bounded, secret-free application state for offline analysis (`data_export:export`) |
| Audit and realtime | `GET /api/audit`, `GET /api/events` | Append-only action history and server-sent event updates |
| Demo and reset | `/api/demo/*`, `POST /api/admin/reset` | Isolated synthetic demonstration lifecycle and privileged tiered reset |

## Common query behavior

Case listing uses `limit` and `offset`, with optional `status`, `surface`, `entity`,
`from`, and `to` filters. Other list endpoints define their own query parameters;
do not assume that all collections share one pagination envelope. Follow the OpenAPI
operation for the endpoint being called.

Source and log browse limits are server-bounded. Treat every returned log field,
raw record, case-derived string, and search result as untrusted data when presenting
it in another system.

## Case clustering explanation

`GET /api/cases/{case_id}/threat-context` includes an additive `clustering` object.
It is a read-only projection of persisted case facts; it never re-runs correlation,
changes a cluster signature, scores risk, or participates in the case decision. The
object reports availability, input/source counts, a source breakdown, correlation
mode/threshold/window/grouping/reason, opened-case status/verdict, and bounded related
cases. Up to 12 member references are returned as stable one-way hashes, with a
truncation count; raw source identifiers and alert payloads are excluded. Consumers
must tolerate `available: false` or incomplete fields for older cases.

## Realtime events

`GET /api/events` is a server-sent events stream. The optional `topics` query filters
the stream. Resume with the `Last-Event-ID` header or the `lastEventId` query parameter.
The server emits heartbeats; clients should reconnect and fall back to bounded polling
when the stream is unavailable. When realtime preferences disable the event bus, the
endpoint returns HTTP 204. Browser `EventSource` clients cannot set an Authorization
header, so authenticated Console subscriptions use the session cookie.

## Decision previews and side effects

`POST /api/triage/preview-decision` and `POST /api/rules/preview` are preview surfaces.
They do not create a real decision or bill an LLM call. A preview is not authorization
to close or escalate a case. Actual case state transitions still pass through the
human action path or the deterministic case manager.

Secret-setting routes accept values but never return them. Subsequent reads expose
only configured booleans or configured field names. See the
[Configuration reference](configuration.md) before automating setup.

## Portable application export

`POST /api/admin/export` accepts `scopes` (`all`, `cases`, `audit`, `usage`,
`configuration`, `automation`, or `knowledge`) and `limit_per_scope` (1–5000;
default 1000). It returns a canonical `application/json` attachment with a per-scope
count/total/truncation manifest. `limit_per_scope` caps the whole selected scope;
grouped automation and knowledge collections are sampled fairly within that cap. The
server never traverses environment/source credentials,
users, sessions, password/MFA material, browser tokens, or upstream raw logs; a final
recursive sanitizer removes credential-shaped fields and common token/private-key
patterns. Raw knowledge chunks are also excluded. Exports are hard-limited to 25 MiB;
use fewer scopes or a lower item cap when the server returns HTTP 413. The response is
not an import/restore format. The default permission is limited to `super_admin` and
`soc_manager` through `data_export:export`, and each request is audited.

## Compatibility expectations

The 0.1 API favors additive fields and stable existing paths, but it is still a
pre-1.0 contract. Pin clients to an application patch version, tolerate unknown
response fields, regenerate typed clients when the OpenAPI snapshot changes, and
test against the `Testing` branch before promoting the accepted source tree to
`main`/Stable and re-running the gate on the resulting commit.
The current remote has not yet provisioned literal `main`; legacy/default
`claude/main` must not be treated as Stable without a deliberate repository-wide
release-contract change.
See [Compatibility](compatibility.md) and [Documentation versions](../releases/documentation-versions.md).
