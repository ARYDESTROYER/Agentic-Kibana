# DEPLOY.md — Deploying the Agentic SOC Triage Suite

This is the deployment guide for the **vendor-agnostic, self-hosted Agentic SOC
triage suite**. The product is a read-only triage layer that consumes alerts from
**any** SIEM / EDR / XDR and turns raw alert volume into audited, cost-metered,
human-reviewable cases.

> **The SIEM is NOT baked into the stack.** You connect your log source(s) from
> the **first-run wizard** ("add a source") AFTER the stack is up — not in a
> compose file. One deployment can read from Elasticsearch, OpenSearch, Wazuh, a
> webhook, syslog, Kafka, and more.

> **New here?** Start with **[`docs/HANDOFF.md`](docs/HANDOFF.md)** — the
> onboarding map (repo layout, the green baseline, how to run it) — then return
> here to deploy.

> **Just want a guided demo?** See **[`DEMO.md`](DEMO.md)** — `./scripts/run-demo.sh`
> brings the suite up locally with **auth enabled** (login + RBAC + MFA + SSO live)
> and the seeded `Admin` / `Admin@123` super_admin, then walks every headline
> feature in order.

---

## 1. Overview — two deployment modes

| | **Mode A — Agnostic stack (RECOMMENDED)** | **Mode B — Legacy ELK merge (optional)** |
|---|---|---|
| What runs | A self-contained stack: Postgres (+pgvector), Redis, the backend, and the standalone React + Tailwind + shadcn web UI (nginx). | Just the backend (+Redis) bolted into an existing ELK stack; the UI is the **archived Kibana plugin** (revive at your own risk). |
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
| `tlsoc-webui` | built from `webui/Dockerfile` | The standalone React + Tailwind + shadcn SPA served by nginx on `:80`, published as `:8080`. Proxies `/api/*` to the backend. |

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
- **Cloud LLM providers (Round 3, optional, default-off):** `TLSOC_AZURE_OPENAI_API_KEY`
  (+ `_ENDPOINT` / `_API_VERSION`) for Azure OpenAI; `TLSOC_AWS_ACCESS_KEY_ID` /
  `TLSOC_AWS_SECRET_ACCESS_KEY` / `TLSOC_AWS_REGION` for AWS Bedrock (stdlib SigV4, no
  `boto3`); `TLSOC_VERTEX_PROJECT` / `_LOCATION` / `_API_KEY` for Google Vertex. Any
  OpenAI-compatible endpoint (vLLM/Ollama/OpenRouter/Together/Groq) needs no new key —
  set the model's `base_url` in Settings → Models. See `docs/ENVIRONMENT.md` §2.6.
- **More enrichment providers (Round 3, optional):** 17 providers behind an
  `EnrichmentProvider` SPI. Keyless ones (Shodan InternetDB, IPinfo Lite, abuse.ch
  URLhaus/MalwareBazaar/ThreatFox, RDAP/DoH) are **default-on, no key**. Keyed +
  default-off: `TLSOC_GREYNOISE_API_KEY`, `TLSOC_SHODAN_API_KEY`, `TLSOC_CENSYS_API_ID`/
  `_SECRET`, `TLSOC_BINARYEDGE_API_KEY`, `TLSOC_IPINFO_TOKEN`, `TLSOC_OTX_API_KEY`,
  `TLSOC_PULSEDIVE_API_KEY`, `TLSOC_SPUR_API_KEY`, `TLSOC_XFORCE_API_KEY`/`_PASSWORD`,
  `TLSOC_URLSCAN_API_KEY`, `TLSOC_HIBP_API_KEY`, `TLSOC_HONEYPOT_ACCESS_KEY`,
  `TLSOC_ABUSECH_AUTH_KEY`. Toggle each in Settings → Enrichment. See
  `docs/ENVIRONMENT.md` §2.7. (When running under Compose, add the matching unprefixed
  `- AZURE_OPENAI_API_KEY=${TLSOC_AZURE_OPENAI_API_KEY:-}` line to the `tlsoc-backend`
  `environment:` block for each provider you enable.)
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

The plugin is **archived** (`archive/kibana-plugin/`) and ships **pre-built** in
`archive/kibana-plugin/dist/`. It is no longer built/version-stamped in CI — the
standalone webui is the sole supported surface. **Do not compile on the server.**
Install the zip that matches your Kibana version, then restart Kibana:

| Running Kibana | Install this committed zip |
|---|---|
| 8.12.2 | `archive/kibana-plugin/dist/tlsocAgenticTriage-8.12.2.zip` |
| 8.19.12 | `archive/kibana-plugin/dist/tlsocAgenticTriage-8.19.12.zip` |

```bash
docker cp archive/kibana-plugin/dist/tlsocAgenticTriage-8.19.12.zip kibana:/tmp/
docker exec kibana ./bin/kibana-plugin install file:///tmp/tlsocAgenticTriage-8.19.12.zip
docker restart kibana
```

The plugin talks to the backend through a Kibana server-side proxy and defaults to
`http://tlsoc-backend:8088` (resolves on the shared Docker network because the
container is named `tlsoc-backend`). Override with `tlsocAgenticTriage.backendUrl`
in `kibana.yml` if needed. Then open the **TLSOC Agentic Triage** app in Kibana
and complete the same wizard described in §3.4.

> The Kibana plugin folder is ephemeral; a `compose down/up` or image pull removes
> it — just re-run the install + restart. (See `archive/kibana-plugin/BUILD.md`
> for reviving + building the zip in a separate session; never run
> `yarn kbn bootstrap` on a production server.)

---

## 8. Production hardening

- **TLS / reverse proxy in front of the UI.** The web UI serves plain HTTP on
  `:8080` (nginx). In production, place it behind a TLS terminator / reverse proxy
  (e.g. nginx, Caddy, Traefik). The suite now ships **built-in API auth + RBAC +
  MFA + SSO** (default OFF — enable per §9); enable it (and set
  `TLSOC_AUTH_COOKIE_SECURE=true` behind TLS), and/or add proxy-level auth in
  front. In Mode B, the Kibana plugin inherits Kibana's authenticated session.
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

## 9. Authentication, RBAC, MFA & SSO

API auth ships **disabled by default** — the no-auth deployment (network /
reverse-proxy as the trust boundary) is fully supported and unchanged out of the
box. Enable it per-deploy to get a **login screen, persisted multi-user accounts,
6-role RBAC, MFA (TOTP), and SSO (OIDC)**. See `SECURITY.md` for the full posture.

> All knobs below use the `.env` `TLSOC_*` names. The **agnostic compose maps
> them** onto the backend's unprefixed names (`AUTH_ENABLED`, `AUTH_JWT_SECRET`,
> `MFA_OBFUSCATION_KEY`, `SSO_CLIENT_SECRETS`, …). A **direct uvicorn** run reads
> the **unprefixed** names directly (see `DEMO.md` Option B).

### 9.1 Enable auth + RBAC

In `.env`:

```bash
TLSOC_AUTH_ENABLED=true
TLSOC_AUTH_JWT_SECRET=$(openssl rand -hex 32)   # STABLE — else sessions die on restart
TLSOC_AUTH_COOKIE_SECURE=true                    # REQUIRED behind TLS
```

Then `docker compose -f deploy/docker-compose.agnostic.yml up -d` to apply.

- **First-run seed.** When auth is enabled **and the user store is empty**, the
  backend auto-seeds a demo **super_admin**: **`Admin` / `Admin@123`**. **Change it
  immediately** — create real users and delete/disable the seed (the suite blocks
  removing the *last* super_admin to avoid lockout).
- **6 roles:** `super_admin` · `soc_manager` · `analyst_tier2` · `analyst_tier1` ·
  `responder` · `auditor`. Enforced **server-side** (every `/api` route is gated by
  `require_permission`, deny-by-default + a CI coverage test) **and** in the UI
  (`<Can>` guards). When auth is OFF, every user is treated as `super_admin`.
- **Env fallback admin** (optional, separate from the seed):
  `TLSOC_AUTH_ADMIN_USERNAME` + `TLSOC_AUTH_ADMIN_PASSWORD` (plaintext, hashed in
  memory at startup, never stored; granted super_admin), or a boot-time map
  `TLSOC_AUTH_USERS={"alice":"pbkdf2_sha256$..."}`.
- Manage users/roles in **Settings → Users / Access** after logging in.

### 9.2 MFA (TOTP)

Per-user, opt-in **RFC-6238 TOTP** — enrolled from the UI (**Settings → Security →
My MFA**), with an **inline-SVG QR code** (no external calls) and **single-use
recovery codes**. Login becomes two-phase (password → 6-digit code).

```bash
# Optional: key used to obfuscate the per-user TOTP secret at rest.
# Blank -> derived from TLSOC_AUTH_JWT_SECRET.
TLSOC_MFA_OBFUSCATION_KEY=$(openssl rand -hex 32)
```

> This is stdlib **obfuscation, not a KMS** — a documented hardening TODO (see
> `SECURITY.md`). Treat the obfuscation key (or the JWT secret it derives from) as
> sensitive.

### 9.4 Session & token policy (revocation, idle / absolute lifetime, step-up)

With auth enabled, the stdlib HS256 JWT is the short-lived **access token**; every
login also registers a **session** (a `sid` + per-user `token_version` claim) in a
backend-agnostic `SessionStore` (persisted in the state backend, so sessions survive
a backend restart **as long as `TLSOC_AUTH_JWT_SECRET` is stable**). This is what
makes a session **revocable** — a valid-looking JWT is rejected once its `sid` is
revoked or the user's `token_version` is bumped. See `SECURITY.md` for the model.

The lifetimes are a UI-editable tuning block (**Settings → Organization → Security &
SSO → token policy**), also settable on Preferences. Defaults are **deliberately
generous** so an existing auth-on deployment never expires mid-session:

| Knob (Preferences `session_policy.*`) | Default | Meaning |
|---|---|---|
| `access_ttl` | `3600` (1h) | Access-token lifetime; a refresh rotates within this window. |
| `idle_timeout` | `43200` (12h) | Reject a session idle longer than this (`now > last_active + idle_timeout`). |
| `absolute_lifetime` | `2592000` (30d) | Reject a session older than this regardless of activity. |
| `refresh_ttl` | `2592000` (30d) | Refresh-token lifetime. |
| `sudo_reauth_window` | `600` (10m) | How recently the user must have re-authenticated for a step-up-gated action (`require_fresh_auth`). |
| `notify_on_new_device` / `notify_on_terminate` | `false` | Best-effort operator notification on a first-seen device / a termination. |

These are tuned in the UI, not `.env` (they carry no secret). Endpoints:
`POST /api/auth/refresh` (rotate + **reuse detection** — see `SECURITY.md`),
`POST /api/auth/reauth` (step-up), `GET /api/sessions` + `POST
/api/sessions/{sid}/revoke` + `POST /api/sessions/revoke-others` (own devices), and
the admin console `GET /api/admin/sessions` + `POST /api/admin/sessions/{sid}/revoke`
+ `POST /api/admin/users/{username}/revoke-all`. Users manage their own signed-in
devices in **Settings → Account → Security / Sessions**.

> **Keep `TLSOC_AUTH_JWT_SECRET` stable.** It signs the access token AND is the
> default derivation source for the MFA obfuscation key. If it is unset/ephemeral,
> every restart invalidates all tokens (the persisted session rows still load, but
> their JWTs no longer verify).

### 9.5 SSO (OIDC — Google / Microsoft / generic)

Configure providers in **Settings → Security → SSO** (issuer, client id, the
group→role mapping). The **client secret** stays in the SECRET tier — set it via
`.env` or at runtime:

```bash
# .env (JSON map of provider id -> client secret):
TLSOC_SSO_CLIENT_SECRETS={"google":"GOCSPX-...","corp":"..."}
# …or push at runtime (super_admin):
#   POST /api/auth/sso/providers/{id}/secret
```

The suite uses **server-side code exchange + userinfo** (no `id_token`
signature-verify dependency — a documented hardening TODO in `SECURITY.md`).
Group→role provisioning maps IdP groups onto the 6 roles.

**Register this redirect / callback URI with your IdP** (the suite derives it from
the request's base URL):

```
<your-base-url>/api/auth/sso/callback
# e.g. local demo:   http://localhost:5173/api/auth/sso/callback
#      docker stack:  http://localhost:8080/api/auth/sso/callback
#      production:    https://soc.example.com/api/auth/sso/callback
```

- **Google** — Google Cloud Console → APIs & Services → **Credentials** → *Create
  OAuth client ID* → *Web application* → add the callback above under **Authorized
  redirect URIs**. Copy the client id (→ Settings) + client secret (→
  `TLSOC_SSO_CLIENT_SECRETS["google"]`).
- **Microsoft (Entra ID)** — Azure Portal → **App registrations** → *New
  registration* → add the callback above as a **Web** *Redirect URI*. Copy the
  Application (client) ID + tenant/issuer (→ Settings) and a **client secret** from
  *Certificates & secrets* (→ `TLSOC_SSO_CLIENT_SECRETS["<provider-id>"]`).
- **Generic OIDC** — point the issuer at the provider's discovery document and
  register the same callback.

---

## 10. Notifications (email / Slack / Teams / webhook / PagerDuty / Telegram)

Notifications are **default OFF** and configured per-channel in **Settings →
Notifications**. Channels fire **fire-and-forget after** a case is saved, with
**per-condition triggers** and **dedup / rate-limit / digest** controls.

- **Email (SMTP)** is stdlib SMTP with provider presets (Gmail/Workspace,
  Microsoft 365/Outlook, **SES**, SendGrid, Mailgun, Postmark, …). Pick a preset, set
  the from/to addresses, and put the **SMTP password** in the SECRET tier.
- **Amazon SES** — pick the `ses` preset and set `config.region` (host is
  `email-smtp.{region}.amazonaws.com:587`, STARTTLS). Supply **either** a pre-made
  SES SMTP username (secret = the SMTP password) **or** `config.aws_access_key_id`
  as the username with the IAM **secret** access key as the channel secret — the
  suite derives the SES SMTP password from the IAM key via a stdlib HMAC ladder (no
  boto3, no console step).
- **Email (Resend)** is a separate channel `type: resend` over Resend's HTTPS API
  (`POST https://api.resend.com/emails`). The channel secret is the **Resend API
  key** (`Authorization: Bearer`); a deterministic `Idempotency-Key`
  (`case-notify/{case_id}/{trigger}`) de-dupes retries. Set the from/to addresses in
  config and the API key in the SECRET tier. (Resend retries only on 429/5xx, never
  on a 4xx config/quota error.)
- **Slack / Teams / webhook** use an incoming-webhook URL; **PagerDuty** uses a
  routing/integration key; **Telegram** a bot token + chat id.

**Email templates.** The 5 built-in templates (`case.new`, `case.escalation`,
`case.resolved`, `digest.daily`, `test`) are operator-overridable (**Settings →
Notifications → template editor**). They render through a tiny stdlib
mustache-subset engine with **mandatory HTML-escaping** of every interpolated
variable and **header-injection-safe** Subject/headers — see `SECURITY.md`.
Preview a rendered template server-side (escaping is authoritative) with
`POST /api/notifications/preview?trigger=<trigger>` before wiring it.

> **Verify the sending domain first.** For both SES and Resend, the From domain must
> be DNS-verified at the provider (SPF/DKIM, and DMARC if you enforce it) before
> mail will deliver. New SES accounts are also **sandboxed** (recipients must be
> verified, low send quota) until you request production access. Use the channel's
> **Send test** to confirm the domain is live before enabling triggers.

The channel **secret** (SMTP password / webhook URL / API token) lives in the
SECRET tier — never the config store. Set it via the UI, or:

```bash
# Runtime (the connector-secret pattern):
POST /api/notifications/channels/{id}/secret      # body: {"secret": "..."}

# …or seed at boot via .env (JSON map of channel id -> {field: value}):
TLSOC_NOTIFICATION_SECRETS={"email-ops":{"secret":"<smtp-password>"},"slack-soc":{"secret":"https://hooks.slack.com/services/..."}}
```

Use the channel's **Send test** button to verify delivery before wiring triggers.

---

## 11. Demo quick start

For a presenter-ready, copy-pasteable walkthrough that brings the suite up
**locally with auth enabled** and tours every headline feature, see
**[`DEMO.md`](DEMO.md)**. The fast path, from the repo root:

```bash
./scripts/run-demo.sh        # backend :8088 (auth on) + web UI :5173
# then open http://localhost:5173 and log in as  Admin / Admin@123
```

### 11.1 In-app Demo Mode (synthetic data, reversible, isolated)

Separate from the local demo *script* above, any running deployment has an in-app
**Demo Mode** — a reversible tenant state (`off` | `seeded` | `live`) that fills the
console with realistic synthetic cases (a benign baseline + MITRE ATT&CK
storylines) so you can show every surface without touching a real source. It is
**admin-gated** and **fully isolated**: synthetic events flow through the real
pipeline but all writes land in a **separate throwaway in-memory store** under a
`run_id`, the LLM is a deterministic `$0` mock (cost tiles show "(simulated)"), and
a write-guard prevents demo data from ever reaching the real state store. Enable /
reset / disable it from **Settings → Experimental** or via `POST /api/demo/enable`,
`POST /api/demo/reset`, `POST /api/demo/disable` (hard-deletes all demo data by
`run_id`), `GET /api/demo/status`. The real durable polling cursor (#4) is untouched
throughout, and disabling Demo Mode is a single reversible flip. See `SECURITY.md`
for the isolation guarantees.

---

## 12. Troubleshooting

For runtime / usage / deploy failures (health checks, `es_connected:false`,
no cases after polling, connector errors, plugin install issues), see
**`docs/TROUBLESHOOTING.md`**.
