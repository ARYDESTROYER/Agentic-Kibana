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
no longer depends on Kibana at all.

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
suite's own state; and a **standalone web UI** (`webui/`, Vite + React +
`@elastic/eui`) that talks to the backend directly over `/api`. The legacy Kibana
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
   case + audit + usage store  (Elasticsearch | Postgres+pgvector | SQLite)
                          ▼
                 standalone web UI  (webui/, /api)
```

Every LLM call goes through one gateway → a usage/cost ledger; every agent action
is appended to an append-only audit trail; log-derived values are treated as
UNTRUSTED data in prompts. See [`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md)
for the full design.

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
- **RAG.** Resolved cases are indexed as retrievable baseline memory so future
  investigations learn from prior analyst decisions (backed by pgvector or an ES
  dense-vector store, depending on the state backend).
- **Choice of state backend** (`STATE_BACKEND`): `elasticsearch` (default),
  `postgres` (asyncpg + pgvector), or `sqlite`. The app's own state
  (cases/audit/usage/config/cursor/RAG) lives there; with **postgres or sqlite no
  Elasticsearch is required at all**.
- **Standalone web UI + first-run wizard.** A self-hosted SPA (`webui/`) with a
  multi-step setup wizard that lists connectors, renders a dynamic form per
  connector, tests the connection, configures LLM providers and per-role models,
  and manages multiple sources — all without Kibana.

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
    engine/             correlation · risk · cost_gate · case_manager · poller · signatures
    agents/             router · investigator (ReAct) · formatter · chat · standup · graph
    stores/             cases · usage · config · cursor (+ audit)
      sql/              SQL StateStore: engine · models · repositories · vectorstore
    api/                routes (the backend contract) · deps   state.py · main.py
webui/                  standalone Vite + React + @elastic/eui SPA (primary UI)
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

Verified offline this cycle: **221 backend tests green** (fake/in-memory backends
+ mock LLM, no network); the standalone **web UI builds clean** (`tsc` + Vite).
Live-stack validation against a real SIEM is a deploy step. See
[`docs/AGNOSTIC_ARCHITECTURE.md`](docs/AGNOSTIC_ARCHITECTURE.md) for roadmap
status and [`CHANGELOG.md`](CHANGELOG.md) for the change history.
