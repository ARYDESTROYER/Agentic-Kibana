# DEPLOY.md — Deploying the Agentic SOC Triage Suite

This is the deployment guide for the **vendor-agnostic, self-hosted Agentic SOC
triage suite**. The product is a read-only triage layer that consumes alerts from
**any** SIEM / EDR / XDR and turns raw alert volume into audited, cost-metered,
human-reviewable cases.

> **The SIEM is NOT baked into the stack.** You connect your log source(s) from
> the **first-run wizard** ("add a source") AFTER the stack is up — not in a
> compose file. One deployment can read from Elasticsearch, OpenSearch, Wazuh, a
> webhook, syslog, Kafka, and more.

---

## 1. Overview — two deployment modes

| | **Mode A — Agnostic stack (RECOMMENDED)** | **Mode B — Legacy ELK merge (optional)** |
|---|---|---|
| What runs | A self-contained stack: Postgres (+pgvector), Redis, the backend, and the standalone React/EUI web UI (nginx). | Just the backend (+Redis) bolted into an existing ELK stack; the UI is the **Kibana plugin**. |
| Own state | PostgreSQL — **no Elasticsearch required** for the app's own bookkeeping. | The suite's own `tlsoc-agent-*` Elasticsearch indices. |
| UI | Standalone SPA at `http://localhost:8080`. | Inside Kibana, as the `tlsocAgenticTriage` plugin. |
| Log source | Connected from the wizard (pull or push). | Connected from the wizard (pull or push). |
| When to use | New deployments; any SIEM/EDR/XDR; no Kibana dependency. | You already run Kibana 8.12.2 / 8.19.12 and want the UI inside it. |
| Compose file | `deploy/docker-compose.agnostic.yml` | `deploy/docker-compose.tlsoc.yml` (a service block to merge) |

In **both** modes the agent's log-reading surface is the **connector layer**
configured in the wizard — the product reads from any source, and the state
backend choice is independent of where logs come from.

---

## 2. Prerequisites

- **Docker** and **Docker Compose v2** (`docker compose`, not the legacy
  `docker-compose`).
- **At least one LLM provider key** — Anthropic **or** OpenAI. (A built-in `mock`
  provider exists for offline/eval, but real triage needs a real key.)
- **For a PULL log source** (Elasticsearch / OpenSearch / Wazuh): a **read-only**
  credential (an ES-compatible API key) and the cluster URL. PUSH sources
  (webhook/HEC/syslog/Kafka/…) need no log-source credential at all.
- Outbound network access for: pulling base images (`pgvector/pgvector:pg16`,
  `redis:7-alpine`, `python:3.11-slim`, `node:22-alpine`, `nginx:1.27-alpine`),
  building the two local images, and reaching your LLM provider's API.

---

## 3. Mode A — Agnostic stack (primary)

`deploy/docker-compose.agnostic.yml` brings up four services:

| Service | Image | Role |
|---|---|---|
| `tlsoc-postgres` | `pgvector/pgvector:pg16` | The app's OWN state (cases/audit/usage/config/cursor + RAG vectors). Replaces the `tlsoc-agent-*` ES indices. |
| `tlsoc-redis` | `redis:7-alpine` | Enrichment + dedup cache (recommended; backend falls back to in-memory without it). |
| `tlsoc-backend` | built from `backend/Dockerfile` | FastAPI + LangGraph agent. Started with `STATE_BACKEND=postgres`. Listens on `:8088`. |
| `tlsoc-webui` | built from `webui/Dockerfile` | The standalone React/EUI SPA served by nginx on `:80`, published as `:8080`. Proxies `/api/*` to the backend. |

### 3.1 Configure `.env`

From the **repo root**:

```bash
cp .env.example .env
```

For Mode A you must fill in:

- **`TLSOC_PG_PASSWORD`** — required; the Postgres password. The compose file
  refuses to start without it.
- **At least one LLM key** — `TLSOC_ANTHROPIC_API_KEY` and/or
  `TLSOC_OPENAI_API_KEY`.

Optional for Mode A:

- `TLSOC_ES_URL` + `TLSOC_ES_API_KEY` — pre-seed an Elasticsearch / OpenSearch /
  Wazuh **pull** log source so it's wired at boot (you can instead add it in the
  wizard). `TLSOC_ES_CA_CERT` + `TLSOC_ES_VERIFY_CERTS` if that cluster uses a
  private CA.
- `TLSOC_ABUSEIPDB_API_KEY`, `TLSOC_VIRUSTOTAL_API_KEY` — enrichment (degrades
  gracefully if absent).
- `TLSOC_EMBEDDING_API_KEY` — embeddings for RAG (falls back to the OpenAI key,
  then to local hashing embeddings).
- `TLSOC_PG_USER` / `TLSOC_PG_DB` (default `tlsoc` / `tlsoc`), `TLSOC_REDIS_URL`,
  `TLSOC_LOG_LEVEL`.

> **`TLSOC_ES_MGMT_API_KEY` is NOT used in Mode A** — that key is only for the
> legacy Elasticsearch state backend (Mode B). Postgres holds the app's state here.

### 3.2 The env-var mapping (READ THIS — it trips everyone up)

**The backend reads UNPREFIXED env names** (`config.py` `Secrets`): `ES_API_KEY`,
`ES_URL`, `STATE_BACKEND`, `STATE_DB_URL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`REDIS_URL`, etc. **Your `.env` uses `TLSOC_*` names.** The **compose file** is
what maps one onto the other — you never set the unprefixed names yourself.

In `deploy/docker-compose.agnostic.yml` specifically:

- It hard-codes **`STATE_BACKEND=postgres`** itself.
- It **builds `STATE_DB_URL` for you** from the `TLSOC_PG_*` vars:
  `postgresql+asyncpg://${TLSOC_PG_USER}:${TLSOC_PG_PASSWORD}@tlsoc-postgres:5432/${TLSOC_PG_DB}`.
- It maps `TLSOC_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY`, `TLSOC_ES_API_KEY →
  ES_API_KEY`, `TLSOC_REDIS_URL → REDIS_URL`, and so on.

So in Mode A you only ever edit `TLSOC_*` in `.env`; the compose file translates.

### 3.3 Bring it up

From the **repo root**:

```bash
docker compose -f deploy/docker-compose.agnostic.yml up -d --build
```

This builds the backend and web-UI images and starts all four services. Then open:

```
http://localhost:8080
```

You land on the **first-run wizard**.

### 3.4 The first-run wizard

Walk through the steps:

1. **Welcome / demo** — overview; optionally explore with the `mock` provider.
2. **Add a source** — pick a connector and configure it (see §3.5 / §3.6). The
   wizard lists every available connector and its field schema, served from
   `GET /api/connectors`.
3. **Test connection** — validates the wired primary log source
   (`POST /api/connectors/test`). For a pull source this confirms the URL + key +
   field mapping reach the cluster.
4. **LLM providers + per-role models** — confirm provider keys (shown as
   `configured ✓`, never as values) and choose the model per role (router /
   investigator / formatter / standup / chat / overview / embedding). Catalog
   served from `GET /api/models`.
5. **Detection settings** — data scope (`data_view_pattern`, time field), entity
   field mapping (source IP / user / host), severity threshold, in-scope /
   excluded rules, correlation, caps.
6. **Review → Finish** — calls `POST /api/setup/complete`, which flips
   `setup_complete` and starts polling.

After finishing, trigger an immediate poll for the demo with **`POST /api/poll`**
(or the Settings page button).

### 3.5 Connecting a PULL source (Elasticsearch / OpenSearch / Wazuh)

A pull source is one ES-API-compatible cluster the poller queries on a durable
cursor. In the wizard, for the chosen connector, provide:

- the cluster **URL** (e.g. `https://elasticsearch:9200`),
- a **read-only API key** (least-privilege; see §8),
- a private-CA cert path if the cluster uses one,
- the **per-source field mapping** (defaults: data view `all-logs-*`, time field
  `@timestamp`, `source.ip` / `user.name` / `host.name`, rule field
  `event.module`, severity field `event.severity`).

You can also pre-seed one pull source at boot via `TLSOC_ES_URL` +
`TLSOC_ES_API_KEY` (mapped to `ES_URL` / `ES_API_KEY`).

> **Honesty about scope.** Today's **pull** connectors are **Elasticsearch,
> OpenSearch, and Wazuh** (Wazuh via its indexer). Wiring **multiple distinct pull
> clusters simultaneously**, and **native PULL** for Splunk / Microsoft Sentinel /
> QRadar / Chronicle / EDR-XDR vendors, are on the roadmap — those `SourceType`s
> exist in the enum but do not yet ship a pull driver. Those vendors can push to
> the suite today via the generic receivers below.

### 3.6 Connecting a PUSH source (webhook / HEC / syslog / queues / object stores)

A push source forwards events **to** the suite; no log-source credential needed.

**HTTP push (webhook / HEC)** — the simplest path. After adding a webhook/HEC
source in the wizard, the source POSTs alerts to:

```
POST /api/ingest/{source_id}
```

The receiver verifies auth, parses (JSON/NDJSON/CEF/LEEF/syslog/GELF/kv —
auto-detected), normalises to OCSF, and the events flow into the **same**
correlate → case pipeline the poller feeds.

Set the per-source auth secret (bearer token / HMAC key) via the secrets endpoint
— it goes to the **secret tier (in memory), never to the persisted config**:

```bash
# Set a bearer token for a source whose id is "my-webhook":
curl -X POST http://localhost:8080/api/sources/my-webhook/secrets \
  -H 'Content-Type: application/json' \
  -d '{"token": "REPLACE_WITH_A_LONG_RANDOM_SECRET"}'

# The source then pushes alerts (one or many, JSON/NDJSON/CEF/LEEF/…):
curl -X POST http://localhost:8080/api/ingest/my-webhook \
  -H 'Authorization: Bearer REPLACE_WITH_A_LONG_RANDOM_SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"event.module":"web_auth","source.ip":"203.0.113.7","user.name":"alice"}'
```

(The web UI proxies `/api/*` to the backend, so you can hit either
`http://localhost:8080/api/...` through nginx or `http://localhost:8088/api/...`
directly.)

**Listener / queue / object-store receivers** run as background drivers inside the
backend container. **For socket-based receivers (e.g. syslog) you must publish the
listener port** by editing the `ports:` of `tlsoc-backend` in
`deploy/docker-compose.agnostic.yml` (the file ships with the lines commented):

```yaml
    ports:
      - "8088:8088"
      - "1514:1514/udp"   # syslog UDP
      - "1514:1514/tcp"   # syslog TCP
```

Then `docker compose -f deploy/docker-compose.agnostic.yml up -d` to apply.

The **16 built-in push receivers** (`SourceType` → optional pip dependency; the
core image is intentionally lean and ships **none** of these — install a
receiver's deps only if you use it):

| SourceType | Mode | Optional pip dep |
|---|---|---|
| `webhook` | PUSH_HTTP | none (stdlib; the FastAPI app owns the port) |
| `hec` | PUSH_HTTP | none |
| `syslog` | PUSH_SYSLOG / PUSH_SOCKET | none (stdlib asyncio) |
| `kafka` | QUEUE | `confluent-kafka` |
| `aws_sqs` | QUEUE | `boto3` |
| `aws_kinesis` | QUEUE / STREAM | `boto3` |
| `azure_event_hub` | QUEUE | `azure-eventhub` |
| `gcp_pubsub` | QUEUE | `google-cloud-pubsub` |
| `rabbitmq` | QUEUE | `aio-pika` |
| `nats` | QUEUE | `nats-py` |
| `mqtt` | QUEUE | `paho-mqtt` |
| `redis_streams` | QUEUE | `redis` |
| `s3` | OBJECT_STORE | `boto3` |
| `gcs` | OBJECT_STORE | `google-cloud-storage` |
| `azure_blob` | OBJECT_STORE | `azure-storage-blob` |
| `file` | OBJECT_STORE / PUSH_SOCKET | none (stdlib tail) |

Every optional client is imported **lazily**; configuring a receiver whose dep is
missing returns a clear error carrying the exact `pip install` hint instead of
crashing. **To add a connector's deps**, the simplest path is a one-line image
overlay — create `backend/Dockerfile.extra` (or add to your own build) layering
on the core image:

```dockerfile
FROM tlsoc-agentic-triage-backend:1.0.0
RUN pip install --no-cache-dir confluent-kafka boto3   # only what you need
```

…then point the `tlsoc-backend` service's `image:`/`build:` at it and rebuild.

### 3.7 Verify

```bash
# Backend health (directly, or through the UI proxy at :8080/api/health):
curl -s http://localhost:8088/api/health
#   -> {"status":"ok","version":"...","es_connected":...,"store_type":"...","setup_complete":...}
#   In Mode A, store_type reflects the Postgres-backed store; es_connected is the
#   LOG-SOURCE connection (false until you add+test a pull source — expected).

# Service status + logs:
docker compose -f deploy/docker-compose.agnostic.yml ps
docker compose -f deploy/docker-compose.agnostic.yml logs -f tlsoc-backend

# The wizard's "Test connection" (or directly):
curl -s -X POST http://localhost:8088/api/connectors/test -H 'Content-Type: application/json' -d '{}'

# After a poll, the first cases:
curl -s -X POST http://localhost:8088/api/poll
curl -s http://localhost:8088/api/cases
```

---

## 4. State backend choice

The suite's OWN bookkeeping — cases, audit log, usage/cost ledger, preferences,
the durable polling cursor, and RAG vectors — is stored in a **state backend**,
chosen with `STATE_BACKEND` (and `STATE_DB_URL` for SQL backends). This is
**independent** of where your logs come from (that's always the connector layer).

| `STATE_BACKEND` | `STATE_DB_URL` | What it needs | When to pick it |
|---|---|---|---|
| `postgres` | `postgresql+asyncpg://user:pass@host:5432/db` | PostgreSQL **with pgvector** (for RAG) | **Mode A default.** Production self-hosting with no Elasticsearch dependency; durable, scalable. |
| `sqlite` | `sqlite+aiosqlite:////data/tlsoc.db` (blank → `./tlsoc.db`) | nothing extra | Single-node / evaluation / smallest footprint. |
| `elasticsearch` (default in `config.py`) | n/a | The suite's `tlsoc-agent-*` indices + a management ES key | **Mode B.** You already run Elasticsearch and want the app's state there too. |

Notes:
- **pgvector** is required for RAG on Postgres — Mode A's `pgvector/pgvector:pg16`
  image provides it. Without a vector backend, RAG retrieval degrades gracefully.
- For Postgres/sqlite, `ES_MGMT_API_KEY` is **not** required (no `tlsoc-agent-*`
  indices). For the `elasticsearch` state backend it **is** (see Mode B).
- In `.env`, the equivalents are `TLSOC_STATE_BACKEND` and `TLSOC_STATE_DB_URL`,
  but **Mode A's compose sets `STATE_BACKEND=postgres` and builds `STATE_DB_URL`
  itself** — leave those `.env` lines alone for Mode A.

---

## 5. Secrets model

- **All secrets live in the env / secret tier only** — never in any persisted
  config document, never returned to a UI, never logged. The UI shows boolean
  `configured ✓` status only (`config.py` `configured_status()`).
- **Provider + connection secrets** come from the environment (mapped by compose
  from `TLSOC_*`), and the wizard can also push them at runtime
  (`POST /api/setup/secrets`) — runtime-pushed values are **in process memory
  only** and lost on a backend restart. **`.env` is the durable path.**
- **Per-source secrets** (a webhook bearer token, an HMAC key, a vendor API
  token) are set via `POST /api/sources/{id}/secrets` (or the wizard). They go to
  the secret tier keyed by source id, are **never persisted to the config store**,
  and only the secret field **names** are recorded on the source
  (`configured_secrets`) so the UI can show which are set without revealing them.

---

## 6. Operations

**Start / stop / restart / logs / health** (Mode A; for Mode B use your stack's
compose file and the service names):

```bash
cd <repo-root>
docker compose -f deploy/docker-compose.agnostic.yml up -d            # start
docker compose -f deploy/docker-compose.agnostic.yml ps              # status
docker compose -f deploy/docker-compose.agnostic.yml logs -f tlsoc-backend
docker compose -f deploy/docker-compose.agnostic.yml restart tlsoc-backend
docker compose -f deploy/docker-compose.agnostic.yml down            # stop (keeps volumes)
curl -s http://localhost:8088/api/health
```

**Backups.**

- *Postgres state backend (Mode A):* dump the database (the `tlsoc-pgdata` named
  volume holds everything):
  ```bash
  docker exec tlsoc-postgres pg_dump -U tlsoc tlsoc > tlsoc-backup-$(date +%F).sql
  # restore:
  cat tlsoc-backup-YYYY-MM-DD.sql | docker exec -i tlsoc-postgres psql -U tlsoc -d tlsoc
  ```
- *sqlite backend:* back up the `.db` file (copy the bind-mount / volume path you
  set in `STATE_DB_URL`).
- *Elasticsearch state backend (Mode B):* use Elasticsearch **snapshots** of the
  `tlsoc-agent-*` indices via your stack's snapshot repository.

**Upgrades.** Pull the new code and rebuild in place (data in the volumes /
indices is preserved; preference fields are additive with safe defaults and the
built-in rule catalog is version-guarded so operator edits are never clobbered):

```bash
cd <repo-root>
git pull
docker compose -f deploy/docker-compose.agnostic.yml up -d --build
```

**Resource notes.** The backend image is small (pure-Python on
`python:3.11-slim`). Postgres+pgvector and Redis are modest. The heaviest cost is
LLM API usage — watch the in-app **Cost** panel (`GET /api/usage/summary`) and the
per-case caps (`caps.max_tokens`, `caps.max_tool_calls`, `caps.timeout_seconds`,
and the `kill_switch`). LLM investigations can run for a while; the web-UI nginx
proxy is configured with 300s read/send timeouts for that reason.

---

## 7. Mode B — Legacy ELK merge + Kibana plugin (optional)

Use this only if you already run a Kibana 8.12.2 / 8.19.12 stack and want the UI
**inside Kibana** with the suite's state in Elasticsearch.

### 7.1 Add the backend to the existing stack

Clone this repo next to your stack's `docker-compose.yml` so the build context
resolves (the merge block expects `./agentic-kibana/backend`), then **copy the
`tlsoc-backend` and optional `tlsoc-redis` entries from
`deploy/docker-compose.tlsoc.yml` into the `services:` map of your existing
`docker-compose.yml`** — do not modify any existing service. The block:

- joins the existing default network and reaches `https://elasticsearch:9200` by
  container name,
- mounts the existing CA read-only (`./certs/ca/ca.crt:/certs/ca.crt:ro`),
- reads its config from `TLSOC_*` env vars (mapped to `ES_URL`, `ES_API_KEY`,
  `ES_MGMT_API_KEY`, `ANTHROPIC_API_KEY`, …).

### 7.2 Two scoped Elasticsearch API keys (NEVER the superuser)

Mode B uses the `elasticsearch` state backend, which needs **two** least-privilege
keys (this is non-negotiable #1 — never `kibana_system` or the `elastic`
superuser). Mint them once with the superuser, then never use it again. The role
descriptors are documented in `.env.example`:

**Read-only key** → `TLSOC_ES_API_KEY` (`ES_API_KEY`): scoped to your log indices.

```json
{ "tlsoc_agent_readonly": {
    "indices": [ { "names": ["all-logs-*"], "privileges": ["read","view_index_metadata"] } ] } }
```

**Management key** → `TLSOC_ES_MGMT_API_KEY` (`ES_MGMT_API_KEY`): scoped to the
suite's own indices only.

```json
{ "tlsoc_agent_mgmt": {
    "indices": [ { "names": ["tlsoc-agent-*"],
      "privileges": ["read","write","create_index","view_index_metadata","manage"] } ] } }
```

Mint via Kibana → **Stack Management → Security → API keys → Create API key →
Restrict privileges**, or via the `_security/api_key` API. Put the `encoded`
values into `.env`. Then bring up the backend:

```bash
docker compose up -d --build tlsoc-backend tlsoc-redis
docker exec tlsoc-backend curl -fsS http://localhost:8088/api/health ; echo
```

### 7.3 Install the pre-built Kibana plugin

The plugin ships **pre-built** in `plugin/dist/`. **Do not compile on the server.**
Install the zip that matches your Kibana version, then restart Kibana:

| Running Kibana | Install this committed zip |
|---|---|
| 8.12.2 | `plugin/dist/tlsocAgenticTriage-8.12.2.zip` |
| 8.19.12 | `plugin/dist/tlsocAgenticTriage-8.19.12.zip` |

```bash
docker cp plugin/dist/tlsocAgenticTriage-8.19.12.zip kibana:/tmp/
docker exec kibana ./bin/kibana-plugin install file:///tmp/tlsocAgenticTriage-8.19.12.zip
docker restart kibana
```

The plugin talks to the backend through a Kibana server-side proxy and defaults to
`http://tlsoc-backend:8088` (resolves on the shared Docker network because the
container is named `tlsoc-backend`). Override with `tlsocAgenticTriage.backendUrl`
in `kibana.yml` if needed. Then open the **TLSOC Agentic Triage** app in Kibana
and complete the same wizard described in §3.4.

> The Kibana plugin folder is ephemeral; a `compose down/up` or image pull removes
> it — just re-run the install + restart. (See `plugin/BUILD.md` for building the
> zip in a separate session; never run `yarn kbn bootstrap` on a production
> server.)

---

## 8. Production hardening

- **TLS / reverse proxy in front of the UI.** The web UI serves plain HTTP on
  `:8080` (nginx) with no auth of its own. In production, place it behind a TLS
  terminator / reverse proxy (e.g. nginx, Caddy, Traefik) and add
  authentication / SSO in front. In Mode B, the Kibana plugin inherits Kibana's
  authenticated session.
- **Restrict the `:8088` backend port.** The compose files publish `8088:8088`
  for direct API access / debugging. In production, remove that mapping (the UI
  reaches the backend over the internal Docker network at
  `http://tlsoc-backend:8088`) or firewall it to trusted hosts only.
- **Network policy for push receivers.** Only publish the listener ports you
  actually use (e.g. syslog `1514`), and firewall them to your forwarders.
  Require auth on HTTP push (`POST /api/ingest/{id}` with a per-source bearer/HMAC
  secret) and prefer TLS in front of it.
- **Least-privilege source keys.** A pull source's key must be **read-only** and
  scoped to the log indices it needs — never a superuser, never write-capable.
  In Mode B keep the read-only ↔ management key split intact.
- **Secrets stay in `.env` / the secret tier**; never commit a real `.env`, never
  expose secret values through the UI.
- For the full threat model and posture, see **`SECURITY.md`**.

---

## 9. Troubleshooting

For runtime / usage / deploy failures (health checks, `es_connected:false`,
no cases after polling, connector errors, plugin install issues), see
**`docs/TROUBLESHOOTING.md`**.
