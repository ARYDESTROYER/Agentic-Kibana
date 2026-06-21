# ENVIRONMENT.md — every environment, in detail

There are **two distinct environments**. Confusing them causes most build/deploy
pain, so they are documented separately.

> The suite is now **vendor-agnostic**: the backend (FastAPI+LangGraph) plus a
> **standalone web UI** (`webui/`, Vite+React+@elastic/eui) are the primary
> artifacts; the Kibana plugin (`plugin/`) is a legacy/optional surface. The
> suite's own state runs on a **selectable backend** (Elasticsearch, PostgreSQL,
> or SQLite). See `COMPATIBILITY.md` for the full matrix.

---

## 1. The build / development sandbox (Claude Code on the web)

Where the code is written, the backend tests run, the **web UI is built**, and the
plugin zips are built.

### 1.1 Nature
- **Ephemeral, isolated cloud container.** The repo is cloned fresh when the
  session starts and the container is reclaimed on inactivity. **Anything not
  committed + pushed is lost.** Push to `claude/sharp-tesla-t73bqy`.
- ~252 GB volume, typically **18–22 GB free** (Kibana checkouts in `/tmp` are
  large — ~6 GB each). 15 GB RAM, 4 CPUs.

### 1.2 Tooling
| Tool | Where / version | Notes |
|---|---|---|
| Node (default) | `/opt/node22` → `node v22.x` on PATH | Fine for the **webui** build; WRONG for **plugin** builds (use the per-version pin) |
| nvm | `/opt/nvm/nvm.sh` | `nvm use "$(cat <checkout>/.nvmrc)"` for the Kibana plugin |
| Node for the webui | **22** | Vite+React+TS+EUI; the default `/opt/node22` works |
| Node for Kibana 8.19.12 | `22.22.0` (repo `.nvmrc`/`.node-version`) | Bazel removed in 8.19 |
| Node for Kibana 8.12.2 | `18.18.2` | Bazel-based bootstrap |
| Python | `3.11` | backend venv at `backend/.venv` |
| Docker | daemon startable (`sudo dockerd &`) | **image registries blocked — see below** |
| git, jq, curl, unzip | present | |

### 1.3 Network egress policy (allowlist)
**Reachable (HTTP 200):** `github.com`, `pypi.org`, `registry.npmjs.org`,
`nodejs.org`.

**BLOCKED (403 / not in allowlist):**
- Container image registries: `docker.elastic.co`, `pgvector/pgvector` & other
  Docker Hub blob CDN (`production.cloudfront.docker.com`). → **You cannot pull
  Elasticsearch/Kibana/Postgres images or run any Docker stack in this sandbox.**
  Building/running the agnostic or legacy compose is a **deploy-time** step.
- Browser binaries during Kibana bootstrap: `edgedl.me.gvt1.com` (Chrome),
  `cdn.playwright.dev` / `playwright.download.prss.microsoft.com` (Playwright). The
  webui build needs **no browser** — `vite build` is a static bundle, no headless
  Chromium.
- `ci-stats.kibana.dev` (Kibana build telemetry — harmless).

### 1.4 Consequences for verification
- **Backend:** fully testable offline — `cd backend && . .venv/bin/activate &&
  pytest -q` uses the in-memory fake ES and the mock LLM provider. **221 tests**
  green is the primary correctness gate. The **SQL state backend is tested offline
  on SQLite** (`sqlalchemy`+`aiosqlite`); `asyncpg`/`pgvector` are imported lazily,
  so no Postgres is needed in the sandbox.
- **Web UI (primary surface):** builds fully (the npm registry is reachable).
  ```bash
  cd webui && npm install && npm run build   # = tsc --noEmit && vite build
  ```
  The clean `tsc + vite` build (a `dist/` bundle) **is the check** here — there is
  no browser to render it in this sandbox.
- **Plugin (legacy):** builds fully. Verify **statically**: `tsc --noEmit` clean,
  `unzip -l` shows `target/public/tlsocAgenticTriage.plugin.js`, manifest
  `kibanaVersion` correct, `grep -c tlsoc-backend` in the browser bundle = 0.
- **Live install / running stacks are NOT possible here** (no images). They are
  deploy-time steps with a checklist in `DEPLOY.md`.

### 1.5 Plugin build env vars (legacy plugin only — export before bootstrap AND build)
```bash
export PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
       CYPRESS_INSTALL_BINARY=0 CHROMEDRIVER_SKIP_DOWNLOAD=true \
       PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 BROWSERSLIST_IGNORE_OLD_DATA=true \
       NODE_OPTIONS=--max-old-space-size=4096
# 8.12.2 only, if releases.bazel.build 403s:
#   BAZELISK_BASE_URL=https://github.com/bazelbuild/bazel/releases/download (+ cached bazel binary)
```
- `BROWSERSLIST_IGNORE_OLD_DATA=true` is **mandatory at build time** or the
  optimizer silently drops the browser bundle.
- Running as **root** trips 8.19's kbn root guard inside `buildWebpackPackages`
  (it calls `yarn kbn build-shared` without `--allow-root`). Fix without patching
  Kibana: put a `yarn` shim first on PATH that appends `--allow-root` to
  `yarn kbn …` subcommands. (Non-root dev users do not hit this.)
- Warm checkouts live in `/tmp` (e.g. `/tmp/kibana-8.19`). `rm -rf` an unused one
  to free disk. (None of this applies to the webui build.)

---

## 2. The deploy target (the SOC server)

Where the suite actually runs in production. Two supported shapes (see
`COMPATIBILITY.md` §E and the compose files under `deploy/`).

### 2.1 Shape A — the agnostic stack (recommended, `deploy/docker-compose.agnostic.yml`)
Self-contained; **no Elasticsearch required for the app's own state.** Brings up:
- `tlsoc-postgres` — PostgreSQL + **pgvector** (`pgvector/pgvector:pg16`): the
  app's OWN state (cases/audit/usage/config/cursor/RAG), replacing the
  `tlsoc-agent-*` ES indices. Backend runs with `STATE_BACKEND=postgres`.
- `tlsoc-redis` — enrichment/dedup cache (optional; degrades to in-memory).
- `tlsoc-backend` — FastAPI+LangGraph agent on `8088`.
- `tlsoc-webui` — the standalone React/EUI SPA (nginx) on `8080`; talks to the
  backend via an `/api` proxy. This is the first-run wizard + console.

Your SIEM/EDR/XDR is **not** part of this stack — connect to it from the UI's
first-run wizard ("add a source"). Pull sources today: Elasticsearch / OpenSearch
/ Wazuh (point `ES_URL` + a read-only `ES_API_KEY` at that cluster). Push sources
(webhook/HEC/syslog/Kafka/SQS/…) need no ES at all; publish the inbound port(s)
you configure in the wizard (e.g. `1514/udp` for syslog).

```bash
cp .env.example .env   # fill TLSOC_PG_PASSWORD + at least one LLM key
docker compose -f deploy/docker-compose.agnostic.yml up -d --build
# open http://localhost:8080 and complete the setup wizard
```

### 2.2 Shape B — the legacy ELK merge (`deploy/docker-compose.tlsoc.yml`)
Attach to an existing ELK stack (e.g. `sankettaware16/TLSOCDockerDeploy`,
containers `elasticsearch`/`kibana`/`logstash`/`kafka`, 8.19.12, TLS via a local
CA under `./certs/`) as a **read-only consumer**:
- `tlsoc-backend` joins the existing default Compose network, reaches
  `https://elasticsearch:9200` by container-name DNS, mounts `./certs/ca/ca.crt:ro`,
  listens on `8088`, and runs `STATE_BACKEND=elasticsearch` (own-state in
  `tlsoc-agent-*` via `ES_MGMT_API_KEY`).
- `tlsoc-redis` (optional) — enrichment cache.
- The legacy Kibana plugin zip installed into the existing `kibana` container.
- Logs land in `all-logs-*` (the wizard default data view may be
  `fosstlsoc-logs-*` — confirm on the live stack and set it in Settings).

### 2.3 Environment-variable surface (the `.env` → backend mapping)
Backend env names are **UNPREFIXED** (`ES_API_KEY`, `STATE_BACKEND`, …). The
compose blocks read **`TLSOC_`-prefixed** names from `.env` and map them onto the
unprefixed backend vars, so the suite's `.env` cannot clash with the host stack's
`ELASTIC_PASSWORD`/`KIBANA_PASSWORD`/etc.

| `.env` (compose) | Backend env (`Secrets`) | Purpose |
|---|---|---|
| `TLSOC_ES_URL` | `ES_URL` | log cluster URL (pull source) |
| `TLSOC_ES_API_KEY` | `ES_API_KEY` | **read-only** key for the log surface (the agent's only path to logs) |
| `TLSOC_ES_MGMT_API_KEY` | `ES_MGMT_API_KEY` | own-state key for `tlsoc-agent-*` (only when `STATE_BACKEND=elasticsearch`) |
| `TLSOC_ES_CA_CERT` / `TLSOC_ES_VERIFY_CERTS` | `ES_CA_CERT` / `ES_VERIFY_CERTS` | private-CA path + TLS verification toggle |
| `TLSOC_STATE_BACKEND` | `STATE_BACKEND` | `elasticsearch` (default) \| `postgres` \| `sqlite` |
| `TLSOC_STATE_DB_URL` | `STATE_DB_URL` | SQLAlchemy async URL for SQL backends (agnostic compose derives it from the PG vars below) |
| `TLSOC_PG_USER` / `TLSOC_PG_PASSWORD` / `TLSOC_PG_DB` | (compose builds `STATE_DB_URL`) | Postgres creds for the agnostic stack (`TLSOC_PG_PASSWORD` REQUIRED there) |
| `TLSOC_ANTHROPIC_API_KEY` | `ANTHROPIC_API_KEY` | LLM provider key |
| `TLSOC_OPENAI_API_KEY` | `OPENAI_API_KEY` | LLM provider key |
| `TLSOC_ABUSEIPDB_API_KEY` | `ABUSEIPDB_API_KEY` | enrichment key |
| `TLSOC_VIRUSTOTAL_API_KEY` | `VIRUSTOTAL_API_KEY` | enrichment key |
| `TLSOC_EMBEDDING_API_KEY` | `EMBEDDING_API_KEY` | embeddings (falls back to the OpenAI key) |
| `TLSOC_REDIS_URL` | `REDIS_URL` | enrichment cache (degrades to in-memory) |
| `TLSOC_LOG_LEVEL` | `LOG_LEVEL` | backend log level |

### 2.4 Secrets model (read this)
- **Global secrets** live in the deploy `.env` (`TLSOC_*`) / container environment —
  **never** in the UI bundle, **never** in a state index/table, **never**
  committed. The settings UI only ever sees a boolean `configured ✓` status, never
  values.
- **Two scoped ES API keys** (never the superuser): `ES_API_KEY` (read-only log
  surface) and `ES_MGMT_API_KEY` (read/write/create `tlsoc-agent-*`, only for the
  ES state backend).
- **Per-source connector secrets** (a webhook bearer token, an HMAC secret, a
  Splunk API token, …) are set per source via the first-run wizard or
  `POST /api/sources/{id}/secrets`. They live in the **in-memory secret tier**
  keyed `<source_id>.<field>`; the UI sees only the configured field *names*
  (`SourceInstance.configured_secrets`), never values.
- The wizard can push global keys at runtime too, but `state.apply_secrets` keeps
  them **in process memory only — lost on backend restart.** `.env` is the durable
  path for global secrets. (Roadmap: optional persisted encrypted secret store.)

### 2.5 Connectivity map (agnostic stack)
```
analyst browser ─ webui:80 (nginx) ─ /api proxy ─ tlsoc-backend:8088
                                                    │
        own state ── postgresql+asyncpg ── tlsoc-postgres:5432 (cases/audit/usage/config/cursor/RAG via pgvector)
        log source ── pull: https://<your-cluster>:9200 (read-only ES_API_KEY)  [Elastic/OpenSearch/Wazuh]
                    ── push: webhook/HEC :8088 · syslog :1514 · queues/object-stores (egress)
        enrichment ── Redis(tlsoc-redis:6379) + AbuseIPDB/VirusTotal (egress)
        LLM ────────── api.anthropic.com / api.openai.com (egress)
```

> A production deploy needs **outbound HTTPS** from `tlsoc-backend` to the
> configured LLM + enrichment providers (or a local/vLLM gateway). Without LLM
> egress, investigations fail safe to NEEDS_HUMAN (never dropped).
