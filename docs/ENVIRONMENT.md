# ENVIRONMENT.md — every environment, in detail

There are **two distinct environments**. Confusing them causes most build/deploy
pain, so they are documented separately.

---

## 1. The build / development sandbox (Claude Code on the web)

Where the code is written, the backend tests run, and the plugin zips are built.

### 1.1 Nature
- **Ephemeral, isolated cloud container.** The repo is cloned fresh when the
  session starts and the container is reclaimed on inactivity. **Anything not
  committed + pushed is lost.** Push to `claude/sharp-tesla-t73bqy`.
- ~252 GB volume, typically **18–22 GB free** (Kibana checkouts in `/tmp` are
  large — ~6 GB each). 15 GB RAM, 4 CPUs.

### 1.2 Tooling
| Tool | Where / version | Notes |
|---|---|---|
| Node (default) | `/opt/node22` → `node v22.x` on PATH | WRONG for plugin builds; use the per-version pin |
| nvm | `/opt/nvm/nvm.sh` | `nvm use "$(cat <checkout>/.nvmrc)"` |
| Node for Kibana 8.19.12 | `22.22.0` (repo `.nvmrc`/`.node-version`) | Bazel removed in 8.19 |
| Node for Kibana 8.12.2 | `18.18.2` | Bazel-based bootstrap |
| Python | `3.11` | backend venv at `backend/.venv` |
| Docker | daemon startable (`sudo dockerd &`) | **image registries blocked — see below** |
| git, jq, curl, unzip | present | |

### 1.3 Network egress policy (allowlist)
**Reachable (HTTP 200):** `github.com`, `pypi.org`, `registry.npmjs.org`,
`nodejs.org`.

**BLOCKED (403 / not in allowlist):**
- Container image registries: `docker.elastic.co`, Docker Hub blob CDN
  (`production.cloudfront.docker.com`). → **You cannot pull Elasticsearch/Kibana
  images or run the real stack in this sandbox.**
- Browser binaries during Kibana bootstrap: `edgedl.me.gvt1.com` (Chrome),
  `cdn.playwright.dev` / `playwright.download.prss.microsoft.com` (Playwright).
- `ci-stats.kibana.dev` (Kibana build telemetry — harmless).

### 1.4 Consequences for verification
- **Backend:** fully testable offline — `pytest -q` uses the in-memory fake ES and
  the mock LLM provider. This is the primary correctness gate.
- **Plugin:** builds fully (the npm registry is reachable). Verify **statically**:
  `tsc --noEmit` clean, `unzip -l` shows `target/public/tlsocAgenticTriage.plugin.js`,
  manifest `kibanaVersion` correct, `grep -c tlsoc-backend` in the browser bundle = 0.
- **Live install on a real Kibana is NOT possible here** (no images). It is a
  deploy-time step with a checklist in `DEPLOY.md`.

### 1.5 Plugin build env vars (export before bootstrap AND build)
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
  to free disk.

---

## 2. The deploy target (the SIEM server)

Where the suite actually runs in production, alongside the upstream pipeline.

### 2.1 The existing stack (`sankettaware16/TLSOCDockerDeploy`)
- Docker-Compose with containers (8.19.12): `elasticsearch`, `kibana`, `logstash`,
  `kafka`. **TLS** via a locally generated CA under `./certs/`. Single default
  Compose network; services reach each other by container-name DNS.
- Elasticsearch: `https://elasticsearch:9200` (TLS; CA at `./certs/ca/ca.crt`).
  Superuser `elastic` (password in the stack's `.env`) — used by an operator ONLY
  to mint scoped API keys; the suite never uses it at runtime.
- Kibana: container `kibana`, port `5601` (often TLS), plugins dir
  `/usr/share/kibana/plugins`.
- Logs land in `all-logs-*` (the wizard default data view may be
  `fosstlsoc-logs-*` — confirm on the live stack and set it in Settings).

### 2.2 What the suite adds (see `deploy/docker-compose.tlsoc.yml`)
- `tlsoc-backend` (FastAPI) — joins the default network, reaches
  `https://elasticsearch:9200`, mounts `./certs/ca/ca.crt:ro`, listens on `8088`.
- `tlsoc-redis` (optional) — enrichment cache; the backend degrades to an
  in-memory cache without it.
- The plugin zip installed into the `kibana` container.

### 2.3 Secrets model (read this)
- All secrets live in the deploy `.env` (`TLSOC_*` vars) / container environment —
  **never** in the plugin, **never** in an ES index, **never** committed.
- Two scoped ES API keys (never the superuser): `ES_API_KEY` (read-only
  `all-logs-*`) and `ES_MGMT_API_KEY` (read/write/create `tlsoc-agent-*`).
- The wizard can push keys at runtime, but `state.apply_secrets` keeps them
  **in process memory only — lost on backend restart.** `.env` is the durable
  path. (Roadmap: optional persisted encrypted secret store.)
- The plugin browser bundle contains **no** backend URL; `backendUrl`
  (default `http://tlsoc-backend:8088`) is server-side only, overridable via
  `tlsocAgenticTriage.backendUrl` in `kibana.yml`.

### 2.4 Connectivity map
```
analyst browser ─TLS─ Kibana(5601) ─proxy /api/tlsoc/*─ tlsoc-backend(8088)
                                                          │
                          read-only key ─ https://elasticsearch:9200 (all-logs-*)
                          mgmt key       ─ https://elasticsearch:9200 (tlsoc-agent-*)
                          enrichment ─ Redis(tlsoc-redis:6379) + AbuseIPDB/VirusTotal (egress)
                          LLM ─ api.anthropic.com / api.openai.com (egress)
```

> A production deploy needs **outbound HTTPS** from `tlsoc-backend` to the
> configured LLM + enrichment providers (or a local/vLLM gateway). Without LLM
> egress, investigations fail safe to NEEDS_HUMAN (never dropped).
