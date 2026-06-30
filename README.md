# Agentic SOC — open-source, self-hosted, vendor-agnostic triage

> An open-source, self-hosted **agentic AI SOC triage** system. It ingests
> alerts/logs from **any** SIEM/EDR/XDR, normalises everything to **OCSF**,
> correlates and risk-gates in deterministic code, runs a two-tier LLM
> investigation (cheap router → strong investigator), and lets a deterministic
> case manager close or escalate — **a TRUE_POSITIVE is never auto-closed**. It is
> a **read-only consumer**: your upstream pipeline is never modified.

> **New here? Start with [`docs/HANDOFF.md`](docs/HANDOFF.md)** — the authoritative
> onboarding doc (what's built, how to run it, where everything lives).

It builds on the prior **TLSOC Agentic Triage Suite** (an ELK/Kibana-coupled
backend + Kibana plugin) but is now **product-agnostic**: it works against
Elasticsearch, OpenSearch, Wazuh, Splunk-HEC, syslog, Kafka, cloud queues, object
stores, plain webhooks, and more — and ships its **own standalone web UI** so it
no longer depends on Kibana at all. The UI is a self-hosted **Vite + React +
Tailwind + shadcn** SPA (the old `@elastic/eui` UI has been retired).

**Docs:** deploy → [`DEPLOY.md`](DEPLOY.md) · use → [`docs/USAGE.md`](docs/USAGE.md)
· ingestion → [`docs/INGESTION.md`](docs/INGESTION.md) · architecture →
[`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md) · environments →
[`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) · fix →
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) · security →
[`SECURITY.md`](SECURITY.md) · contribute → [`CONTRIBUTING.md`](CONTRIBUTING.md).

## What it is

Raw alert volume from any source becomes audited, cost-metered, human-reviewable
**cases**. Two loosely-coupled components do the work: a **backend** (`backend/`,
FastAPI + LangGraph) that holds all the agentic logic, connectors, OCSF
normalisation, the deterministic funnel, the LLM gateway + cost ledger, and the
suite's own state; and a **standalone web UI** (`webui/`, Vite + React + Tailwind
+ shadcn) that talks to the backend directly over `/api`. The legacy Kibana
plugin (`plugin/`) still works but is **optional** — the standalone UI is the
primary front door.

## Architecture

```
   any SIEM / EDR / XDR / queue / object store / webhook
                          │
        ┌─────────────────┴──────────────────┐
        │  PULL connectors        PUSH receivers (16)
        │  (we poll a search API) (they forward to us)
        │  Elastic·OpenSearch·    webhook·HEC·syslog·Kafka·
        │  Wazuh                  SQS·Kinesis·EventHub·PubSub·
        │                         RabbitMQ·NATS·MQTT·Redis·
        │                         S3·GCS·AzureBlob·file
        └─────────────────┬──────────────────┘
                          ▼
         OCSF normalisation  (backend/app/ocsf/)
                          ▼
   correlate (deterministic) ─▶ risk gate (deterministic) ─▶ cost gate
                          ▼
   router (cheap LLM) ─▶ investigator (strong LLM, ReAct) ─▶ formatter
                          ▼
   Case Manager (deterministic close/escalate; never auto-closes a TP)
                          ▼
   Case Manager decides ─▶ notifications (fire-and-forget) ─▶ threshold automation
                          ▼
   case + audit + usage + users store  (Elasticsearch | Postgres+pgvector | SQLite)
                          ▼
   standalone web UI  (webui/, /api) — optional auth: RBAC · MFA (TOTP) · OIDC SSO
```

Every LLM call goes through one gateway → a usage/cost ledger; every agent action
is appended to an append-only audit trail; log-derived values are treated as
UNTRUSTED data in prompts. Notifications and threshold automation run only **after**
the deterministic close/escalate decision and never alter it. See
[`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md) for the full design.

## Features

- **Vendor-agnostic ingestion.** A connector SPI (`backend/app/connectors/`) with
  a registry + `tlsoc.connectors` entry points (third-party connectors install via
  `pip` and appear in the wizard with zero core change). Two physical shapes:
  - **PULL** — we poll a search API on a durable cursor: **Elasticsearch,
    OpenSearch, Wazuh** today (per-source field mapping set in the wizard).
  - **PUSH (16 receivers)** — sources forward to us: webhook, Splunk-HEC, syslog,
    Kafka, AWS SQS, AWS Kinesis, Azure Event Hub, GCP Pub/Sub, RabbitMQ, NATS,
    MQTT, Redis Streams, S3, GCS, Azure Blob, file. Formats parsed:
    JSON / NDJSON / CEF / LEEF / GELF / syslog / kv. Optional client libs are
    imported lazily, so the core has no new hard dependency.
- **OCSF canonical schema** (`backend/app/ocsf/`). Whatever the source, every
  record is normalised to OCSF before the engine reasons over it.
- **Deterministic funnel + LLM tiering.** Correlation, risk scoring, the cost
  gate, and the close/escalate decision are deterministic code; only the verdict
  comes from the LLM, and investigation is tiered (cheap router → strong
  investigator) to control spend.
- **Cost ledger.** 100% of LLM calls pass through one gateway that records token
  usage and cost on every call.
- **RAG with management & visibility.** Resolved cases are indexed as retrievable
  baseline memory so future investigations learn from prior analyst decisions
  (backed by pgvector or an ES dense-vector store, depending on the state backend).
  You can also **see and grow the corpus**: import your own documents, browse the
  documents/chunks, run a live test retrieval (`GET /api/rag/search`), and delete
  (built-in seeds are guarded behind a `force` flag) — via the **Knowledge** page or
  the `/api/rag/*` routes.
- **Agent memory (durable operator facts).** Claude.ai-style memory: add facts in the
  **Memory** page or conversationally in Chat ("remember:" / "forget"); they are
  injected into investigations and chat as a DISTINCT **TRUSTED** context block —
  but **never override the deterministic close/escalate decision**.
- **Case explainability.** Every case exposes a "Why" view (`GET /api/cases/{id}/
  rationale`): the agent's reasoning, the knowledge (RAG/runbook) and operator memory
  it used, the exact commands/queries it ran, enrichment, MITRE — and, prominently,
  the **deterministic** close/escalate rationale.
- **Choice of state backend** (`STATE_BACKEND`): `elasticsearch` (default),
  `postgres` (asyncpg + pgvector), or `sqlite`. The app's own state
  (cases/audit/usage/config/cursor/RAG) lives there; with **postgres or sqlite no
  Elasticsearch is required at all**.
- **Standalone web UI + first-run wizard.** A self-hosted SPA (`webui/`,
  Vite + React + Tailwind + shadcn) with a multi-step setup wizard that lists
  connectors, renders a dynamic form per connector, tests the connection,
  configures LLM providers and per-role models, and manages multiple sources — all
  without Kibana.
- **Multi-user identity + RBAC (optional, default OFF).** When auth is enabled
  (`TLSOC_AUTH_ENABLED=true`), the suite persists real users (a KV-doc store — no
  new index/table) and enforces a six-role permission matrix in code:
  `super_admin` / `soc_manager` / `analyst_tier2` / `analyst_tier1` / `responder` /
  `auditor`. A first-run OOBE seeds an `Admin` / `Admin@123` super-admin (forced to
  change the password on first login); `require_permission` FastAPI deps gate every
  state-changing route and `<Can>` guards filter the UI. Default-OFF preserves the
  zero-auth back-compat behaviour and the offline tests.
- **MFA + SSO.** Stdlib RFC-6238 **TOTP** (no new backend dep) with a browser
  inline-SVG QR enrolment, single-use recovery codes, and a two-phase login;
  **OIDC SSO** for Google / Microsoft / generic providers via server-side code
  exchange + `userinfo` (no `id_token`-verify dependency), with group→role
  auto-provisioning.
- **Account self-service + a redesigned login.** A two-column (brand hero + form)
  login, and a self-service profile (display name, avatar, alternate email, timezone,
  locale, personal prefs) on the user model via `GET/PUT /api/account/me` (env-managed
  single-admin is read-only). Secrets stay excluded from the public projection.
- **Sessions & access policy.** Short-lived access tokens carry a session id (`sid`)
  + token version (`tv`); a backend-agnostic `SessionStore` (over the existing KV
  layer, survives restarts) enforces idle / absolute / revocation in `require_auth`,
  with refresh rotation + reuse-detection. Users see + revoke their own sessions
  (`GET /api/sessions`, `POST /api/sessions/{sid}/revoke`,
  `POST /api/sessions/revoke-others`); admins can force-terminate any
  (`GET /api/admin/sessions`, `POST /api/admin/sessions/{sid}/revoke`). Sensitive
  routes can demand a fresh step-up (`POST /api/auth/reauth`); the token policy
  (TTL / idle / absolute / sudo window) is UI-editable.
- **Demo Mode (reversible, isolated, $0).** A first-class tenant state
  (`off` / `seeded` / `live`): synthetic OCSF events from a `DemoPullConnector` flow
  through the REAL pipeline, but all writes land in a SEPARATE in-memory store with a
  deterministic mock LLM, so the demo is free, isolated, and one-flip reversible.
  Seeded scenarios backfill "old" cases plus a live simulator; FP still runs through
  the real (but sandboxed-policy) `decide()`, NEEDS_HUMAN still stays open.
  `POST /api/demo/{enable,reset,disable}`, `GET /api/demo/status` (admin-gated); demo
  rows are namespaced + tagged so disable hard-deletes by run id.
- **Notifications.** A pluggable `NotificationChannel` abstraction with **email**
  (stdlib SMTP, 13 provider presets, plus an **Amazon SES** preset that can derive
  SMTP creds from a raw IAM key pair, and a **Resend** HTTPS-API channel), plus
  **Slack / Microsoft Teams / webhook / PagerDuty / Telegram** channels.
  Operator-overridable **email templates** (5 preloaded — `case.new` / `case.escalation`
  / `case.resolved` / `digest.daily` / `test`) rendered by a tiny stdlib
  mustache-subset renderer with hard UNTRUSTED-escaping + header-injection guards;
  server-side preview via `POST /api/notifications/preview`. Per-condition triggers
  (create / verdict-change / escalate / close) with dedup, rate-limiting, and digest
  batching; sends are fire-and-forget *after* the deterministic decision + save (never
  inside it), and channel secrets live in the secret tier.
- **Per-user customization.** A two-store model — org **Preferences** + a per-user
  `UserPrefsStore` (over the existing KV layer, no new index) — backs **saved views**,
  per-table column state, **terminology** overrides (relabel "case" → "incident", etc.),
  and a personal light / dark / system **theme**, resolved through a merged cascade
  (`GET /api/prefs/effective`). Routes: `GET/PUT /api/prefs/{user,org}`,
  `GET/POST/PUT/DELETE /api/views` (+ `/clone`), `GET/PUT /api/terminology` (PUT admin).
- **Command palette, global search, bulk actions, audit viewer.** A Cmd/Ctrl-K
  command palette; a cross-entity **global search** (`GET /api/search`) over cases /
  sources / pages; **bulk case actions** (`POST /api/cases/bulk`) that run each id
  through the EXACT single-case human action path (`_perform_case_action`) — never
  `decide()` — audited per id and partial-failure tolerant; and an **audit viewer**
  (`GET /api/audit`) over the append-only trail.
- **Two-axis case taxonomy + custom case IDs.** Lifecycle **status**
  (`new` / `investigating` / `escalated` / `on_hold` / `resolved`, plus the retained
  `open` / `needs_human` / `closed`) and analyst **disposition**
  (`true_positive` / `false_positive` / `benign` / `suspicious` / `duplicate` /
  `undetermined`), with guarded lifecycle transitions and a status history.
  `case_manager.decide()` is **byte-identical** — the taxonomy is an additive layer.
  A configurable `case_id_format` template (e.g. `CASE-2026-000123`) with a KV
  sequence and a live preview gives human-facing case numbers.
- **Multi-source correlation + per-feed source config.** An opt-in **cross-source
  correlation** pass links RELATED cases that share an entity (IP / host / user /
  file hash / domain) without forcing a merge (1:1 cluster→case preserved). Each
  pull source can declare multiple **feeds** (index patterns) with a role —
  `events` (correlate then triage), `alerts` (auto-investigate), or `ignore` (skip) —
  plus per-feed `correlate` / `auto_investigate` switches, a connector-native query
  filter, a field-mapping override, a severity floor, and an **independent durable
  cursor** so a fast alerts feed and a slow events feed never skip each other (#4).
  A severity floor demotes auto-forwarding but **never drops events** (#4). Plus
  per-connector contextual setup help.
- **Playbook automation + threat context.** A **run-a-playbook** action
  re-investigates a case with a chosen playbook injected as context (recommend-only,
  #3-safe); **threshold automation** matches cases after the decision and may tag /
  recommend / notify / queue a playbook run / raise a HITL approval — but it **never
  sets status directly**. A **threat-context** panel assembles IOC reputation, a
  bundled MITRE ATT&CK corpus (697 techniques), and related cases (fail-open); a
  resolved-case → RAG knowledge loop lets future investigations learn from closures.
- **Settings-centric information architecture.** A single Settings surface
  (`GET /api/settings/schema`) is the home for nearly all configuration, organised
  into two scopes — **Personal Account** (profile, account security, sessions,
  preferences, notifications) and **Organization** (data sources, models, correlation
  & cases, automation, notifications, security & SSO, knowledge, enrichment,
  appearance/terminology, advanced) plus the admin areas (Users, RBAC, MFA, SSO).
  Near-duplicate top-level pages were consolidated into tabbed surfaces and the rail
  grouped into a handful of areas, with RBAC hiding sections the signed-in role can't
  see. Everything rides `GET/PUT /api/settings` (deep-merge + validate).

## Quick start (deploy)

The fastest path is the self-contained compose file
[`deploy/docker-compose.agnostic.yml`](deploy/docker-compose.agnostic.yml)
(Postgres + pgvector + Redis + backend + web UI — no Elasticsearch needed for the
app's own state):

```bash
cp .env.example .env        # set TLSOC_PG_PASSWORD + at least one LLM key
docker compose -f deploy/docker-compose.agnostic.yml up -d --build
# then open http://localhost:8080 and complete the first-run wizard
```

You add your SIEM/EDR/XDR **in the wizard** ("add a source"). For the full recipe,
TLS/CA mounts, push-receiver port publishing, and the legacy ELK path, see
**[DEPLOY.md](DEPLOY.md)**.

**Legacy path:** to merge into an existing ELK stack and keep the Kibana plugin,
use [`deploy/docker-compose.tlsoc.yml`](deploy/docker-compose.tlsoc.yml).

## Connectors / how data gets in

| Source / transport | Type | `SourceType` | Mode | How |
|---|---|---|---|---|
| Elasticsearch | pull | `elasticsearch` | `pull` | poll `_search` on a durable cursor |
| OpenSearch | pull | `opensearch` | `pull` | poll `_search` (ES-API compatible) |
| Wazuh | pull | `wazuh` | `pull` | poll the Wazuh indexer (OpenSearch `wazuh-alerts-*`) |
| Webhook | push | `webhook` | `push_http` | `POST /api/ingest/{source_id}` (JSON/NDJSON/CEF/LEEF) |
| Splunk HEC | push | `hec` | `push_http` | `POST /api/ingest/{source_id}` (HEC-compatible) |
| Syslog | push | `syslog` | `push_syslog` | background UDP/TCP/TLS listener (RFC 3164/5424) |
| Kafka | push | `kafka` | `queue` | background consumer |
| AWS SQS / Kinesis | push | `aws_sqs` / `aws_kinesis` | `queue` | background consumer |
| Azure Event Hub | push | `azure_event_hub` | `queue` | background consumer |
| GCP Pub/Sub | push | `gcp_pubsub` | `queue` | background consumer |
| RabbitMQ / NATS / MQTT / Redis Streams | push | `rabbitmq` / `nats` / `mqtt` / `redis_streams` | `queue` | background consumer |
| S3 / GCS / Azure Blob | push | `s3` / `gcs` / `azure_blob` | `object_store` | list + get on an object cursor |
| File | push | `file` | `object_store` | local file/directory tail |

Webhook/HEC ingest over `POST /api/ingest/{source_id}`; syslog/queue/object-store
receivers run as background receivers. Sources are managed through the wizard or
the backend API (`GET /api/connectors`, `GET|POST|DELETE /api/sources`, per-source
secrets via `POST /api/sources/{id}/secrets`). Full reference:
[`docs/INGESTION.md`](docs/INGESTION.md).

**Current limits (be aware):** the PULL path targets **one** ES-API-compatible
cluster today (Elastic / OpenSearch / Wazuh) via `ES_URL` + a read-only
`ES_API_KEY`. Multiple distinct pull clusters and **native** Splunk / Sentinel /
QRadar / Chronicle / CrowdStrike / Defender pull connectors are on the roadmap
(the `SourceType` enum already reserves their names). **Push / queue / object-store
ingestion is unlimited** — run as many receivers of as many types as you like, in
parallel with the pull source.

## Repository layout

```
backend/                FastAPI + LangGraph backend (all agentic logic) + tests
  app/
    ocsf/               OCSF canonical schema + ECS→OCSF mapping
    connectors/         connector SPI + registry; elastic · opensearch · wazuh (pull)
      receivers/        16 push/queue/object-store receivers + format parsers
    engine/             correlation (+ cross-source) · risk · cost_gate · case_manager ·
                        case_id · threshold_automation · threat_context · mitre · poller
    agents/             router · investigator (ReAct) · formatter · chat · standup · graph
    auth/               passwords · tokens (JWT) · service · mfa (TOTP) · oidc (SSO)
    rbac/               policy (role → resource → action permission matrix)
    notifications/      channel (ABC) · email · slack · teams · webhook · pagerduty ·
                        telegram · dispatch (dedup/rate-limit/digest) · templates
    threat/             bundled MITRE ATT&CK technique corpus (mitre_techniques.json)
    stores/             cases · usage · config · cursor · users (+ audit)
      sql/              SQL StateStore: engine · models · repositories · vectorstore
    api/                routes (the backend contract) · deps   state.py · main.py
webui/                  standalone Vite + React + Tailwind + shadcn SPA (primary UI)
deploy/                 docker-compose.agnostic.yml (self-contained) ·
                        docker-compose.tlsoc.yml (legacy ELK) · mappings · dashboards
docs/                   USAGE · INGESTION · AGNOSTIC_ARCHITECTURE · ENVIRONMENT ·
                        TROUBLESHOOTING · RUNBOOK
plugin/                 legacy Kibana plugin (optional; superseded by webui/)
```

## Configuration

Secrets and the state backend are set via environment (`.env`; see
[`.env.example`](.env.example) — `STATE_BACKEND`, `STATE_DB_URL`, LLM keys,
enrichment keys, optional `ES_URL`/`ES_API_KEY` for a pull source). Everything
operationally tunable (correlation rules, risk weights, per-role/per-rule models,
caps, kill switch) lives in UI-editable **Preferences**, surfaced in Settings and
the first-run wizard. The UI shows secrets as booleans (`configured ✓`), never the
values.

**Cloud LLM + enrichment providers (Round 3, all optional + default-off).** Beyond
`ANTHROPIC`/`OPENAI`, the gateway now supports **Azure OpenAI**, **AWS Bedrock**
(stdlib SigV4, no `boto3`), **Google Vertex**, and any **OpenAI-compatible** `base_url`
(vLLM/Ollama/OpenRouter/Together/Groq — no new key). Enrichment was generalized into an
`EnrichmentProvider` SPI with **17 providers** (keyless Shodan InternetDB / IPinfo Lite
/ abuse.ch trio / RDAP-DoH default-on; GreyNoise / Shodan / Censys / BinaryEdge / OTX /
Pulsedive / Spur / X-Force / URLscan / HIBP / Project Honeypot keyed + default-off),
multi-indicator across IP/domain/hash/url/email. All keys are env-only `TLSOC_*` entries
(see [`.env.example`](.env.example) and `docs/ENVIRONMENT.md` §2.6–2.7); enrichment is
advisory only and never feeds the deterministic close/escalate decision.

## Status & verification

Verified offline this cycle: **1109 backend tests green** (fake/in-memory backends
+ mock LLM, no network — an autouse `conftest` network guard keeps the enrichment
tests offline); the standalone **web UI builds clean** (`tsc` + Vite) with a dev-only
Vitest harness (175 tests); eslint clean (0 `react-hooks/rules-of-hooks` errors).
**Round 3** (12 requests across Waves 0–4: expandable nav, richer Settings real-estate,
deeper branding/material, per-case human+AI collaboration, a posture dashboard +
MITRE-coverage, fine-grained custom-role RBAC, +17 enrichment providers, in-app
notifications, a standardized Models page, distinctive UI, a forward-looking Standup,
and clearer cases + agent-work visualization) — like Round 2 (login redesign + account
self-service, sessions + token policy, the Settings-centric IA, Demo Mode, per-feed
sources, Resend/SES + email templates, per-user customization, command palette + global
search + bulk actions + audit viewer) and the seven-wave overhaul before it — was
**additive with zero new runtime dependencies** and left `case_manager.decide()`
byte-identical (CI-verified); the 12 non-negotiables held throughout. A shipped security
fix inverts RAG-knowledge fencing to a TRUSTED allowlist so operator-imported documents
can no longer reach the model unfenced (OWASP LLM01). Live-stack validation against a
real SIEM is a deploy step. New here? See [`docs/HANDOFF.md`](docs/HANDOFF.md). See
[`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md) for roadmap
status and [`CHANGELOG.md`](CHANGELOG.md) for the change history.
