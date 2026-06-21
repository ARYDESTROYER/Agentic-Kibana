# CLAUDE.md — TLSOC Agentic Triage Suite (master context for all agents)

> **READ THIS FIRST, EVERY SESSION.** This is the single source of truth for the
> project: what it is, how it is built/deployed, the environment, the rules, and
> the current roadmap. It is written for Claude Code agents (and humans) so any
> fresh session can become productive immediately.
>
> ## ⛔ NON-NEGOTIABLE PROCESS RULE — UPDATE THE JOURNAL
> **Every agent (including the orchestrator) MUST append an entry to
> [`Journal.md`](Journal.md) at the start and end of any work session**, and after
> any meaningful milestone (a feature done, a build produced, a test run, a
> decision, a blocker). The Journal is our shared memory across context resets and
> across sub-agents. If you did work and did not journal it, the work is not done.
> Sub-agents that cannot commit must return their Journal entry in their final
> report so the orchestrator appends it. See the Journal format at the bottom.

---

## 1. What this is

The **TLSOC Agentic Triage Suite** is a **vendor-agnostic** agentic SOC (Security
Operations Center) triage system. It turns raw alert volume into audited,
cost-metered, human-reviewable cases. It was **built next to** the original
TrustLab / IIT Bombay ELK pipeline and still attaches to it cleanly as a
**read-only consumer**, but it is no longer tied to that one stack:

- **Source-agnostic ingest.** Log sources are pluggable **connectors**
  (`backend/app/connectors/`): pull (Elasticsearch/OpenSearch/Wazuh) + 16 push /
  queue / object-store receivers. Every connector normalises native records into
  **OCSF** (`backend/app/ocsf/`), the canonical internal schema.
- **Selectable state backend.** The suite's OWN bookkeeping runs on Elasticsearch
  (default), PostgreSQL+pgvector, or SQLite via `STATE_BACKEND`.
- **Standalone web UI** is the **primary** surface; the Kibana plugin is legacy.

The original upstream pipeline (when attached, we do NOT modify it):
```
rsyslog (omkafka) → Kafka → foss-soc-engine → Logstash → Elasticsearch (all-logs-*) → Kibana
```

Components, loosely coupled:
- **Backend** (`backend/`) — FastAPI + LangGraph. ALL the agentic logic:
  connectors + OCSF normalisation, polling/ingestion, correlation, risk scoring,
  the two-tier LLM investigation, the deterministic case manager, tools
  (es_query/enrich/rag), the single LLM gateway + cost ledger, and the suite's own
  state (ES | Postgres | SQLite) behind a `StateStore` abstraction.
- **Web UI** (`webui/`) — the **primary** surface: a standalone Vite + React +
  @elastic/eui SPA (the first-run wizard + console), talking to the backend via an
  `/api` proxy. Ships in the agnostic compose stack as `tlsoc-webui` (nginx).
- **Plugin** (`plugin/tlsoc_agentic_triage/`) — **LEGACY/optional**: a thin Kibana
  plugin (React + EUI) for sites that want the console embedded in an existing
  Kibana; talks to the backend ONLY through a Kibana server-side proxy.

Authoritative companion docs (keep them in sync when you change behavior):
`README.md` (overview), `plugin/BUILD.md` (build), `DEPLOY.md` (deploy),
`docs/USAGE.md` (use + examples), `docs/TROUBLESHOOTING.md` (failures),
`COMPATIBILITY.md` (upstream compatibility), `docs/ENVIRONMENT.md` (environments),
`ROADMAP.md` (work tracking).

## 2. Target versions

- **Primary target: Elastic / Kibana / Elasticsearch 8.19.12.** New plugin builds
  MUST produce `plugin/dist/tlsocAgenticTriage-8.19.12.zip`.
- Legacy target kept: 8.12.2 (`plugin/dist/tlsocAgenticTriage-8.12.2.zip`).
- One source tree builds both via `@kbn/*` import aliases + `--kibana-version`
  stamping. See `plugin/BUILD.md` and `COMPATIBILITY.md`.

## 3. Architecture (end to end)

```
┌──────────── PRIMARY surface: standalone Web UI (webui/, Vite+React+EUI) ──────────┐
│ SPA: Wizard · Chat · Investigate · Automated Scans · Standup · Cost · Settings     │
│ api (webui/src/lib) → /api proxy (nginx) ───────────────────────▶ tlsoc-backend    │
└────────────────────────────────────────────────────────────────────────┬──────────┘
  (LEGACY surface) Kibana plugin → core.http /api/tlsoc/{path*}            │
  → server proxy (server/routes/index.ts) → ${backendUrl}/api/{path} ─────┤
┌──────────────────── tlsoc-backend (FastAPI + LangGraph) ─────────────────┴──────────┐
│ SOURCES (SIEM/EDR/queues/object-stores)                                              │
│   → CONNECTORS  pull (Elastic/OpenSearch/Wazuh) · push/queue/object receivers (16)   │
│   → OCSF normalisation (canonical schema)                                            │
│   → poll(durable cursor) / ingest → correlate (det.) → risk (det.)                   │
│   → cost-gate → router (cheap LLM) → investigator (strong LLM, ReAct)                 │
│   → formatter → Case Manager (deterministic close/escalate)                          │
│ tools: es_query (READ-ONLY logs) · enrich (Redis-cached) · rag_retrieve              │
│ single LLM gateway ──▶ usage/cost ledger (every call)                                │
│ StateStore (own bookkeeping): Elasticsearch (tlsoc-agent-*) | PostgreSQL+pgvector |  │
│   SQLite  ── selected by STATE_BACKEND                                               │
└──── read-only key → log surface (e.g. all-logs-*)   ·   own state → StateStore ──────┘
```

Request path detail (memorize it):
- **Primary (webui):** `webui api.get('cases')` → nginx `/api/*` proxy →
  `${BACKEND}/api/cases` → FastAPI route in `backend/app/api/routes.py`.
- **Legacy (Kibana plugin):** `browser TlsocApi.get('cases')` → `core.http GET
  /api/tlsoc/cases` → Kibana route `/api/tlsoc/{path*}` (`server/routes/index.ts`)
  → `fetch(${backendUrl}/api/cases)` (default `http://tlsoc-backend:8088`) → same
  FastAPI route.

**Both proxies forward arbitrary JSON bodies, so additive request fields need NO
proxy change.**

## 4. Repository layout

```
backend/app/
  config.py          Secrets (env-only; incl. STATE_BACKEND/STATE_DB_URL +
                     per-source connector_secrets) + Preferences (UI-editable,
                     incl. sources[] SourceInstance list)
  constants.py       enums (incl. SourceType/IngestMode/CursorKind + OCSF_VERSION),
                     index names, verdict/role/action types, untrusted fences
  models.py          Pydantic data contracts (Case/AuditDoc/UsageDoc/Cursor/
                     RawEvent/...)
  utils.py           dotted_get, time helpers, extract_json, coerce_float, ...
  ocsf/              OCSF canonical schema: model (OCSFEvent + unmapped/raw_data) ·
                     ecs (ECS→OCSF mapping) · generic_to_ocsf
  connectors/        base (Connector/PullConnector/PushReceiver SPI) · registry
                     (built-ins + tlsoc.connectors entry points) · elastic ·
                     opensearch · wazuh · receivers/ (webhook · syslog · queues ·
                     objectstore · formats · common) — 16 push receivers
  es/                base (ABC) · client (real, two-key) · fake (in-memory) ·
                     querybuilder · indices (templates + bootstrap)
  llm/               gateway (THE cost-ledger choke point) · providers · pricing
  tools/             base (MCP-shaped) · es_query · enrich · rag · vectorstore
  engine/            correlation · risk · cost_gate · case_manager · signatures ·
                     poller · ingest (push/queue → OCSF → pipeline)
  agents/            prompts · router · investigator · formatter · chat · standup ·
                     graph (LangGraph) · pipeline · common
  stores/            base (abstract repositories — backend-agnostic StateStore) ·
                     cases · usage · config_store · cursor_store · audit/audit_log
                     (ES-backed) · sql/ (engine · models · repositories ·
                     vectorstore — SQLite/Postgres+pgvector)
  api/               routes (UI contract; incl. /sources, /sources/{id}/secrets) ·
                     deps    state.py (DI hub) · main.py
backend/tests/       offline tests (fake ES + mock LLM; SQL store on SQLite) — green
webui/               PRIMARY surface: standalone Vite+React+TS+@elastic/eui SPA
  package.json       Node 22, @elastic/eui 95; build = tsc --noEmit && vite build
  src/               App.tsx · main.tsx · components/ · lib/ (api etc.)
  Dockerfile         nginx image (tlsoc-webui) with the /api proxy
plugin/tlsoc_agentic_triage/   LEGACY/optional Kibana surface
  kibana.json        legacy manifest (the BUILD input; kibanaVersion stamped via --kibana-version)
  kibana.jsonc       in-tree-schema reference only (NOT used by the build)
  common/index.ts    shared TS types (Case, etc.)
  public/            plugin.ts · application.tsx · index.ts · types.ts
                     components/ (app, chat, investigate, verdict_card, scans,
                                  standup, cost, settings, wizard)
                     lib/ (api.ts, discover.ts)
  server/            index.ts · plugin.ts · config.ts · routes/index.ts (the proxy)
plugin/dist/         committed built zips (8.12.2 + 8.19.12) — deploy artifacts
plugin/BUILD.md      authoritative build guide (both versions)
deploy/              docker-compose.agnostic.yml (Postgres+Redis+backend+webui) ·
                     docker-compose.tlsoc.yml (legacy ELK merge) · mappings/ · dashboards/
docs/                USAGE.md · TROUBLESHOOTING.md · ENVIRONMENT.md
.env.example  README.md  DEPLOY.md  COMPATIBILITY.md  CLAUDE.md  Journal.md  ROADMAP.md
```

## 5. The 12 non-negotiables (never regress these)

1. Read-only, scoped ES key for the agent's log access; **never** `kibana_system`
   or the `elastic` superuser. Two physically separate ES clients
   (`es/client.py`): `_ro` (read-only `all-logs-*`) and `_mgmt` (`tlsoc-agent-*`).
2. Every agent action audited, append-only (`tlsoc-agent-audit-*`).
3. Verdict from the LLM; **close/escalate decision from deterministic code; a
   TRUE_POSITIVE is NEVER auto-closed** (`engine/case_manager.py`).
4. Durable polling cursor (no skip / no dup); cases idempotent by cluster
   signature (`engine/poller.py`, `engine/signatures.py`).
5. ONE chat engine, two entry points (`agents/chat.py`).
6. 100% of LLM calls through ONE gateway → usage/cost ledger (`llm/gateway.py`).
7. Aggregate-then-summarise (never raw logs to a model) (`agents/standup.py`).
8. Enrichment Redis-cached (`tools/enrich.py`, `cache.py`).
9. Log-derived values are UNTRUSTED DATA in prompts — fenced + labelled
   (`agents/prompts.py`, `UNTRUSTED_OPEN/CLOSE`). Applies to chat context,
   selections, queries — anything attacker-influenceable. The OCSF `unmapped`
   catch-all and `raw_data` (`ocsf/model.py`) carry source-controlled values and
   are treated as UNTRUSTED the same way.
10. Sane defaults; only keys + data scope required to run (`config.py`).
11. Spine first & tested (Gate 1); breadth degrades gracefully (Gate 2).
12. Read-only consumer; upstream untouched; cold-deployable.

## 6. Environment (build/dev sandbox AND deploy target)

See `docs/ENVIRONMENT.md` for the full detail. Summary:

### 6a. This build/dev sandbox (Claude Code on the web)
- Ephemeral container; repo cloned fresh; **commit + push or it's lost.**
- Tooling: `/opt/node22` (Node 22) default on PATH — **fine for the `webui` build**,
  WRONG for the Kibana **plugin** build (use the nvm per-version pin at
  `/opt/nvm/nvm.sh`); Python 3.11 + `backend/.venv`; Docker daemon can be started
  (`sudo dockerd &`) but **image registries are BLOCKED** (docker.elastic.co +
  Docker Hub blobs incl. `pgvector/pgvector` 403) — you CANNOT pull ES/Kibana/
  Postgres images or run any compose stack here.
- Network: `github.com`, `pypi.org`, `registry.npmjs.org`, `nodejs.org` reachable.
  BLOCKED by the egress allowlist: container registries, some Chrome/Playwright
  CDNs (`edgedl.me.gvt1.com`, `cdn.playwright.dev`,
  `playwright.download.prss.microsoft.com`), `ci-stats.kibana.dev` (telemetry).
- **webui (primary surface) builds fully here:** `cd webui && npm install &&
  npm run build` (= `tsc --noEmit && vite build`); no browser/Playwright needed —
  the static `dist/` bundle IS the check.
- **Backend tests run fully offline:** `pytest -q` (fake ES + mock LLM). The SQL
  state backend is testable on **SQLite** (sqlalchemy+aiosqlite) — no Postgres
  needed; asyncpg/pgvector are imported lazily.
- Kibana source checkouts live in `/tmp` (e.g. `/tmp/kibana-8.19`, bootstrapped).
  Keep them warm; `rm -rf` an unused one if disk is tight (~18-22GB free).
- **Consequence:** we verify the webui + plugin builds statically (tsc + vite /
  unzip + manifest checks) and the backend via offline tests; building/running the
  Docker images (agnostic or legacy compose) is a DEPLOY step.

### 6b. Deploy target (separate session) — two shapes
- **Agnostic stack** (`deploy/docker-compose.agnostic.yml`): Postgres+pgvector
  (`tlsoc-postgres`) + Redis + `tlsoc-backend` (`STATE_BACKEND=postgres`) +
  `tlsoc-webui` (nginx, port 8080). **No Elasticsearch for the app's own state;**
  connect SIEM/EDR sources from the wizard.
- **Legacy ELK merge** (`deploy/docker-compose.tlsoc.yml`): `tlsoc-backend`
  (`STATE_BACKEND=elasticsearch`, own state in `tlsoc-agent-*`) joins an existing
  `TLSOCDockerDeploy` stack (`elasticsearch`/`kibana`/`logstash`/`kafka`, 8.19.12,
  TLS via `./certs/`), reaches `https://elasticsearch:9200` by container name,
  mounts `./certs/ca/ca.crt:ro`; logs in `all-logs-*` (wizard default data view may
  be `fosstlsoc-logs-*` — confirm live); legacy plugin zip installed into Kibana.
- Backend env names are **UNPREFIXED** (`ES_API_KEY`/`STATE_BACKEND`/
  `STATE_DB_URL`/…); compose maps `.env` `TLSOC_*` → them (see ENVIRONMENT.md §2.3).
- Global secrets via `.env` (`TLSOC_*`); wizard-pushed global secrets are IN-MEMORY
  only (lost on restart). Per-source connector secrets via the wizard /
  `POST /api/sources/{id}/secrets` — also the in-memory secret tier.

## 7. Build / run / test cheatsheet

```bash
# Backend tests (offline; MUST stay green) — currently 221 tests
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
python -m pytest -q

# Backend run locally (in-memory store, mock LLM if no keys)
uvicorn app.main:app --port 8088

# Web UI build (PRIMARY surface; Node 22 — /opt/node22 is fine) — tsc + vite
cd webui && npm install && npm run build   # produces webui/dist/

# Full agnostic stack (DEPLOY target — NOT runnable in this sandbox: images blocked)
cp .env.example .env   # set TLSOC_PG_PASSWORD + at least one LLM key
docker compose -f deploy/docker-compose.agnostic.yml up -d --build   # webui on :8080

# Plugin build for 8.19.12 (LEGACY; see plugin/BUILD.md for the full recipe + troubleshooting)
source /opt/nvm/nvm.sh && nvm use "$(cat /tmp/kibana-8.19/.nvmrc)"   # Node 22.22.0
export PUPPETEER_SKIP_DOWNLOAD=true PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
       CYPRESS_INSTALL_BINARY=0 CHROMEDRIVER_SKIP_DOWNLOAD=true \
       PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 BROWSERSLIST_IGNORE_OLD_DATA=true \
       NODE_OPTIONS=--max-old-space-size=4096
# copy plugin/tlsoc_agentic_triage/{public,server,common,kibana.json} over the
# generated /tmp/kibana-8.19/plugins/tlsoc_agentic_triage, then:
cd /tmp/kibana-8.19/plugins/tlsoc_agentic_triage && node ../../scripts/plugin_helpers build --kibana-version 8.19.12
# MANDATORY verify: unzip -l build/*.zip | grep tlsocAgenticTriage.plugin.js
```

## 8. Conventions

- **Python:** `from __future__ import annotations`, type hints, module docstrings,
  Pydantic v2 (`model_dump(mode="json")` for ES writes). Async throughout.
  Never let an LLM/ES/tool error drop an alert → route to NEEDS_HUMAN.
- **TS/React:** functional components + hooks + EUI; NO new npm deps (only
  monorepo packages — adding deps breaks the build). Import platform code via
  `@kbn/*` aliases (NOT deep relative paths — they move between versions).
- **UI design system (the suite's shared look — use it, don't re-roll it):**
  `public/lib/format.ts` = framework-free formatters (`humanizeAge`,
  `formatTimestamp`, `fmtMoney/Number/Tokens/Percent`, `humanizeToken`, `DASH`);
  `public/components/ui.tsx` = the single source of truth for the colour scheme
  (`COLORS` + `tint()`), semantic helpers (`verdictColor/verdictHex/statusHex/
  riskHex`) and reusable primitives (`SectionHeader`, `StatTile`, `EmptyState`,
  `RiskBadge`, `VerdictBadge`, `StatusBadge`, `ConfidenceBadge`); layout/elevation
  utility classes live in `public/index.scss` (`tlsocIconChip`, `tlsocStatTile`,
  `tlsocCard`, `tlsocBoard__*`). Every surface composes these so the console stays
  consistent. Semantic colours are defined ONCE in `COLORS` and applied via inline
  style; the scss is plain (no deps) so it builds for both 8.12 and 8.19.
- **Backend↔plugin contract:** additive request/response fields are safe (proxy
  forwards arbitrary JSON). Keep `common/index.ts` types in sync with `models.py`.
- **Secrets:** env only; UI shows booleans (`configured ✓`) never values.
- **Tests:** add/keep offline tests; `pytest -q` green before every commit.
  Triple-verify plugin builds (tsc + unzip + manifest + no-leak grep).
- **Git:** branch `claude/sharp-tesla-t73bqy`. Commit focused changes; push.
  Commit/PR trailer: `https://claude.ai/code/session_01JxMk6xXxXEgQ1JKUnD7EF6`.

## 9. Sub-agent workflow (how we parallelize)

- Delegate context-heavy or isolated work to Opus sub-agents (builds, tests, docs,
  isolated modules). Give each agent: the exact files, interfaces, acceptance, and
  "run pytest/tsc until green." Sequence agents that touch shared files
  (`models.py`, `config.py`, `routes.py`, plugin `app.tsx`) to avoid edit
  conflicts; parallelize only non-overlapping work.
- Each sub-agent MUST end its report with a **Journal entry** (see format) for the
  orchestrator to append, since sub-agents don't commit.
- The orchestrator owns cross-cutting contracts and integration, reviews diffs,
  runs the final build + tests, commits, pushes, and updates the Journal.

## 10. Current status & roadmap

Current: Phase-1 spine + the vendor-agnostic transition shipped — **221 backend
tests green**; the standalone **webui builds clean** (tsc+vite); both legacy plugin
zips still build. See `ROADMAP.md` for live status.

Done (the vendor-agnostic epochs):
- **Epoch A — Selectable state backend.** `StateStore` abstraction
  (`stores/base.py`) + SQL backend (`stores/sql/`): SQLite (dev/test) and
  PostgreSQL+pgvector (prod), selected by `STATE_BACKEND`; ES remains the default.
- **Epoch B — Connector SPI + OCSF.** `connectors/` SPI + registry; OCSF canonical
  schema (`ocsf/`); pull connectors (Elasticsearch/OpenSearch) + 16 push/queue/
  object-store receivers (`connectors/receivers/`) + ingestion (`engine/ingest.py`).
- **Epoch C — Wazuh connector** (reuses the OpenSearch connector + alert→OCSF).
- **Epoch D — Standalone web UI + wizard** (`webui/`, Vite+React+EUI) — now the
  primary surface.

Remaining (see `ROADMAP.md`):
- Deep UI surface port (parity of all console surfaces into the webui).
- More pull connectors — **Splunk + Microsoft Sentinel** next (enum'd, not yet built).
- **Epoch E — scale-out** (Kafka/Redpanda buffer, stateless workers) as needed.

Every item ends with: `pytest -q` green (keep the count current), `webui` build
clean, the legacy **8.19.12** plugin zip still building, docs updated, **Journal
updated**, commit + push.

---

## Journal entry format (copy into Journal.md)

```
### YYYY-MM-DD HH:MMZ — <agent/role> — <short title>
- Context: <what you set out to do / which roadmap item>
- Did: <concrete changes: files, endpoints, decisions>
- Tests: <pytest/tsc/build results>
- Status: <done | in-progress | blocked: why>
- Next: <handoff for the next agent>
```
