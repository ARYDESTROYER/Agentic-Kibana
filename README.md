# Agentic SOC — open-source, self-hosted, vendor-agnostic triage

> An open-source, self-hosted **agentic AI SOC triage** system. It ingests
> alerts/logs from **any** SIEM/EDR/XDR, normalises everything to **OCSF**,
> correlates and risk-gates in deterministic code, runs a two-tier LLM
> investigation (cheap router → strong investigator), and lets a deterministic
> case manager close or escalate — **a TRUE_POSITIVE is never auto-closed**. It is
> a **read-only consumer**: your upstream pipeline is never modified.

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
- **Notifications.** A pluggable `NotificationChannel` abstraction with **email**
  (stdlib SMTP, 13 provider presets), plus **Slack / Microsoft Teams / webhook /
  PagerDuty / Telegram** channels. Per-condition triggers (create / verdict-change /
  escalate / close) with dedup, rate-limiting, and digest batching; sends are
  fire-and-forget *after* the deterministic decision + save (never inside it), and
  channel secrets live in the secret tier.
- **Two-axis case taxonomy + custom case IDs.** Lifecycle **status**
  (`new` / `investigating` / `escalated` / `on_hold` / `resolved`, plus the retained
  `open` / `needs_human` / `closed`) and analyst **disposition**
  (`true_positive` / `false_positive` / `benign` / `suspicious` / `duplicate` /
  `undetermined`), with guarded lifecycle transitions and a status history.
  `case_manager.decide()` is **byte-identical** — the taxonomy is an additive layer.
  A configurable `case_id_format` template (e.g. `CASE-2026-000123`) with a KV
  sequence and a live preview gives human-facing case numbers.
- **Multi-source correlation + Auto-Correlate toggles.** An **Auto-Correlate**
  switch per source *and* per sub-source (index pattern); an opt-in **cross-source
  correlation** pass links RELATED cases that share an entity (IP / host / user /
  file hash / domain) without forcing a merge (1:1 cluster→case preserved).
  Per-source field-mapping overrides and per-connector contextual setup help.
- **Playbook automation + threat context.** A **run-a-playbook** action
  re-investigates a case with a chosen playbook injected as context (recommend-only,
  #3-safe); **threshold automation** matches cases after the decision and may tag /
  recommend / notify / queue a playbook run / raise a HITL approval — but it **never
  sets status directly**. A **threat-context** panel assembles IOC reputation, a
  bundled MITRE ATT&CK corpus (697 techniques), and related cases (fail-open); a
  resolved-case → RAG knowledge loop lets future investigations learn from closures.
- **Consolidated Settings.** A single Settings surface organised into 13 sections
  across 4 nav groups (`GET /api/settings/schema`) covering every Preferences
  subtree and the admin areas (Users, RBAC, MFA, SSO, notifications, automation).

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

## Status & verification

Verified offline this cycle: **649 backend tests green** (fake/in-memory backends
+ mock LLM, no network); the standalone **web UI builds clean** (`tsc` + Vite) with
a dev-only Vitest harness (27 tests). The seven-wave SOC overhaul (identity / RBAC /
MFA / SSO, notifications, taxonomy + case-ID, multi-source correlation, playbook
automation + threat context, consolidated Settings + UI) was **additive with zero
new runtime dependencies** and left `case_manager.decide()` byte-identical.
Live-stack validation against a real SIEM is a deploy step. See
[`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md) for roadmap
status and [`CHANGELOG.md`](CHANGELOG.md) for the change history.
