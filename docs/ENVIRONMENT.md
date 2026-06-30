# ENVIRONMENT.md — every environment, in detail

There are **two distinct environments**. Confusing them causes most build/deploy
pain, so they are documented separately.

> The suite is now **vendor-agnostic**: the backend (FastAPI+LangGraph) plus a
> **standalone web UI** (`webui/`, Vite+React+TS+**Tailwind+shadcn/Radix** — EUI was
> removed in the UI overhaul) are the primary artifacts; the Kibana plugin is
> **archived** (`archive/kibana-plugin/`). The suite's own state runs on a
> **selectable backend** (Elasticsearch, PostgreSQL, or SQLite). Optional auth
> (RBAC/MFA/SSO + **server-enforced sessions** with idle/absolute/revocation and
> refresh rotation) is **DEFAULT OFF** — `TLSOC_AUTH_ENABLED=true` to turn it on.
> A reversible, $0 **Demo Mode** populates the product with synthetic data without
> any source wiring (see `DEMO.md`). See `COMPATIBILITY.md` for the full matrix.

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
| Node for the webui | **22** | Vite+React+TS+Tailwind+shadcn/Radix; the default `/opt/node22` works |
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
  pytest -q` uses the in-memory fake ES and the mock LLM provider. **772 tests**
  green is the primary correctness gate (auth DEFAULT OFF, so the suite runs
  unauthenticated). The **SQL state backend is tested offline
  on SQLite** (`sqlalchemy`+`aiosqlite`); `asyncpg`/`pgvector` are imported lazily,
  so no Postgres is needed in the sandbox.
- **Web UI (primary surface):** builds fully (the npm registry is reachable).
  ```bash
  cd webui && npm install && npm run build   # = tsc --noEmit && vite build
  ```
  The clean `tsc + vite` build (a `dist/` bundle) **is the check** here — there is
  no browser to render it in this sandbox. A dev-only **Vitest** harness
  (`npm run test`, **86 tests**) covers render/regression of key surfaces (Settings,
  Demo Mode, command palette, customization) and runs in the CI gate. **Zero new
  runtime deps** were added in Round 2.
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
- `tlsoc-webui` — the standalone React/Tailwind SPA (nginx) on `8080`; talks to the
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
| `TLSOC_AUTH_ENABLED` | `AUTH_ENABLED` | **DEFAULT OFF.** `true` turns on login + 6-role RBAC + MFA/SSO and (on first run, no users) seeds **Admin / Admin@123** (super_admin). Leaving it unset preserves the no-auth "old version" + the offline test path. |
| `TLSOC_AUTH_JWT_SECRET` | `AUTH_JWT_SECRET` | HS256 signing secret for the session/access JWTs (auto-generated per process if unset → **all sessions invalidated on restart**; set a stable 32+ byte value in prod, e.g. `openssl rand -hex 32`, so sessions survive restarts). |
| `TLSOC_AUTH_TOKEN_HOURS` | `AUTH_TOKEN_HOURS` | session-cookie / access-token lifetime in **hours** (default `12`). NOTE: the *richer* session policy below (idle / absolute / refresh / step-up) is **UI-editable Preferences**, not env. |
| `TLSOC_AUTH_COOKIE_SECURE` | `AUTH_COOKIE_SECURE` | set `true` behind TLS so the session cookie is HTTPS-only (default `false`). |
| `TLSOC_AUTH_ADMIN_USERNAME` / `TLSOC_AUTH_ADMIN_PASSWORD` | `AUTH_ADMIN_USERNAME` / `AUTH_ADMIN_PASSWORD` | optional env single-admin (hashed in memory at boot, never stored; granted super_admin) — separate from the auto-seeded `Admin/Admin@123`. |
| `TLSOC_MFA_OBFUSCATION_KEY` | `MFA_OBFUSCATION_KEY` | obfuscation key for per-user TOTP secrets at rest (blank → derived from `AUTH_JWT_SECRET`; stdlib, not a KMS). |
| `TLSOC_SSO_CLIENT_SECRETS` | `SSO_CLIENT_SECRETS` | JSON map `provider_id → client_secret` for OIDC SSO (Google / Microsoft / generic); the rest of each provider (issuer / client-id / redirect / group→role) is configured in **Settings**. May also be pushed at runtime via `POST /api/auth/sso/providers/{id}/secret`. Redirect/callback URI to register with the IdP: `<base-url>/api/auth/sso/callback`. |
| `TLSOC_NOTIFICATION_SECRETS` | `NOTIFICATION_SECRETS` | JSON map `channel_id → {field: value}` seeding the per-channel **secret tier** at boot — covers the **SMTP password**, the **Resend API key**, the **SES IAM secret**, and Slack/Teams/webhook URLs + PagerDuty/Telegram tokens. The rest of each channel (provider/host/port/region/from/recipients) is **non-secret config set in Settings**. May also be pushed at runtime via `POST /api/notifications/channels/{id}/secret`. |

> **Most auth/MFA/SSO/notification/session settings are configured in the UI**, not
> env. In particular, the **session & access policy** (idle timeout, absolute
> lifetime, refresh TTL, step-up "sudo" re-auth window, new-device/terminate
> notify toggles) lives in **UI-editable Preferences** (`session_policy`), enforced
> by the async session check in `require_auth` — there are **no env vars** for those
> values; only `AUTH_JWT_SECRET` + `AUTH_TOKEN_HOURS` above bootstrap them.
> Channel + SSO **secrets** can also be pushed via the API into the in-memory secret
> tier (`POST /api/notifications/channels/{id}/secret`,
> `POST /api/auth/sso/providers/{id}/secret`) — durable only when set via env
> (`TLSOC_NOTIFICATION_SECRETS` / `TLSOC_SSO_CLIENT_SECRETS`). The env vars above are
> the durable/bootstrap path; the only one usually needed to turn the platform "on"
> is `TLSOC_AUTH_ENABLED=true`.

> **Email channels (Round 2):** alongside the stdlib **`email`** SMTP channel
> (13 provider presets), the suite now ships a **`resend`** channel (Resend HTTPS
> API — secret = the Resend API key) and an **SES** SMTP preset
> (`email-smtp.{region}.amazonaws.com`; the channel's `region` + optional AWS
> access-key-id are non-secret config, the SES SMTP/IAM secret is the channel
> secret). All three put their credential in the **secret tier**
> (`TLSOC_NOTIFICATION_SECRETS` at boot, or the runtime push above) — never in the
> config store, never in the UI bundle. Email bodies use 5 preloaded,
> operator-overridable **templates** rendered server-side with HTML-escaping of
> every interpolated variable (#9).

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
