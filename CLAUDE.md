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
- **Plugin** (`archive/kibana-plugin/`) — **ARCHIVED (2026-06-21)**: the original
  thin Kibana plugin (React + EUI). Retired into `archive/` when we went
  vendor-neutral (the standalone webui is the sole primary surface). It is no longer
  built, tested, or shipped; see `archive/README.md`. Do NOT develop it; if a site
  truly needs the embedded-in-Kibana experience, revive it from the archive.

Authoritative companion docs (keep them in sync when you change behavior):
`README.md` (overview), `DEPLOY.md` (deploy), `docs/USAGE.md` (use + examples),
`docs/TROUBLESHOOTING.md` (failures), `COMPATIBILITY.md` (upstream compatibility),
`docs/ENVIRONMENT.md` (environments), `docs/VIGIL_STUDY.md` (Vigil study + overhaul
plan), `ROADMAP.md` (work tracking).

## 2. Target versions

- **The webui (the only surface) targets no specific Kibana version** — it is a
  standalone SPA. The suite connects to Elastic/OpenSearch/Wazuh + 16 push sources
  as data sources, independent of any Kibana.
- When attached to a legacy ELK stack, the compatibility target is Elastic/
  Elasticsearch **8.19.12** (read-only consumer); see `COMPATIBILITY.md`.
- The Kibana **plugin** that used to target 8.19.12 / 8.12.2 is **archived** (see
  `archive/kibana-plugin/`); it is no longer built or version-stamped.

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
  tools/             base (MCP-shaped, + ToolTier safety tier) · es_query · enrich ·
                     rag (hybrid BM25+vector retrieval; import/list/get/delete +
                     stats) · vectorstore (+ list_documents/list_chunks/
                     delete_document/stats)
  engine/            correlation · risk · cost_gate · case_manager (AutoClosePolicy) ·
                     signatures · poller · ingest (push/queue → OCSF) · runbooks
                     (RAG-knowledge loader) · chunking (chunk_text; dep-free
                     paragraph-pack + overlap)
  runbooks/          plain-text Markdown runbooks (RAG knowledge corpus)
  playbooks/         Markdown PLAYBOOK engine: manifest · loader · registry
                     (deterministic per-cluster selection + atomic hot-reload)
  auth/              passwords (PBKDF2) · tokens (stdlib HS256 JWT) · service
  middleware/        security_headers · csrf · rate_limit (Starlette middleware)
  agents/            prompts · router · investigator · formatter · chat · standup ·
                     graph (LangGraph) · pipeline · common · personas (multi-agent roster)
  stores/            base (abstract repositories — backend-agnostic StateStore) ·
                     cases · usage · config_store · cursor_store · memory
                     (MemoryStore over the KVStore — durable operator facts;
                     EsKVStore/SqlKVStore adapters, no new index) · audit/audit_log
                     (ES-backed) · sql/ (engine · models · repositories ·
                     vectorstore — SQLite/Postgres+pgvector)
  api/               routes (UI contract; incl. /sources, /sources/{id}/secrets) ·
                     deps    state.py (DI hub) · main.py
backend/playbooks/   operator-authored *.md PLAYBOOKS (+ README) — data, not code;
                     dir overridable via Preferences.playbooks.dir
backend/tests/       offline tests (fake ES + mock LLM; SQL store on SQLite) — green
webui/               PRIMARY surface: standalone Vite+React+TS+@elastic/eui SPA
  package.json       Node 22, @elastic/eui 95; build = tsc --noEmit && vite build
  src/               App.tsx · main.tsx · components/ (incl. Knowledge/ = RAG
                     corpus page, Memory/ = agent-memory page; both new Platform
                     nav entries) · lib/ (api etc.)
  Dockerfile         nginx image (tlsoc-webui) with the /api proxy
archive/             FROZEN legacy code (not built/tested/shipped) — see archive/README.md
  kibana-plugin/     the retired Kibana plugin (tlsoc_agentic_triage/ + dist/ + BUILD.md)
deploy/              docker-compose.agnostic.yml (Postgres+Redis+backend+webui) ·
                     docker-compose.tlsoc.yml (legacy ELK merge) · mappings/ · dashboards/
docs/                USAGE.md · TROUBLESHOOTING.md · ENVIRONMENT.md · VIGIL_STUDY.md
.env.example  README.md  DEPLOY.md  COMPATIBILITY.md  CLAUDE.md  Journal.md  ROADMAP.md
```

## 5. The 12 non-negotiables (never regress these)

1. Read-only, scoped ES key for the agent's log access; **never** `kibana_system`
   or the `elastic` superuser. Two physically separate ES clients
   (`es/client.py`): `_ro` (read-only `all-logs-*`) and `_mgmt` (`tlsoc-agent-*`).
2. Every agent action audited, append-only (`tlsoc-agent-audit-*`).
3. Verdict from the LLM; **the close/escalate decision is made by deterministic
   code against the operator-configured `AutoClosePolicy`** — never by raw LLM
   output and never by playbook text (`engine/case_manager.py`, `decide()` is a pure
   fn over `(verdict, confidence, risk_score, policy)`). Auto-close is a tunable,
   per-verdict-class policy (enable/min-confidence/max-risk/objection-window):
   FALSE_POSITIVE on above a bar by default; **TRUE_POSITIVE auto-close is an
   explicit opt-in, OFF by default**; **NEEDS_HUMAN never auto-closes (code-enforced,
   not policy-tunable)**. A playbook can recommend but can never change this policy.
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
# Backend tests (offline; MUST stay green) — currently 300 tests
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
python -m pytest -q

# Backend run locally (in-memory store, mock LLM if no keys)
uvicorn app.main:app --port 8088

# Web UI build (PRIMARY surface; Node 22 — /opt/node22 is fine) — tsc + vite
cd webui && npm install && npm run build   # produces webui/dist/

# Full agnostic stack (DEPLOY target — NOT runnable in this sandbox: images blocked)
cp .env.example .env   # set TLSOC_PG_PASSWORD + at least one LLM key
docker compose -f deploy/docker-compose.agnostic.yml up -d --build   # webui on :8080

# NOTE: the Kibana plugin is ARCHIVED (archive/kibana-plugin/) and no longer built.
# The standalone webui above is the sole supported surface. To revive the plugin,
# see archive/kibana-plugin/BUILD.md — it is a do-it-yourself exercise.
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

Current: Phase-1 spine + vendor-agnostic transition + the Vigil-inspired overhaul
(**Waves 1–3**) shipped — **380 backend tests green**; the standalone **webui
builds clean** (tsc+vite). Latest round: **entity-agnostic correlation** (no-source-IP
fix — events without an IP no longer silently dropped; `entity_strategy` IP→host→user→rule),
**per-source multiple index patterns with `events`/`alerts` roles** (auto-investigate
all alerts), `source_id`/`source_name` on cases + **filter-by-source** + sort everywhere
+ a Chat **source selector**, per-source field mapping + `message_field` + **CA-cert
file/drag-drop**, a **chat layout rebuild** (full-height, hides all-empty columns),
Knowledge/Memory feature upgrades, and a **design-token standardization** pass. Competitor
research + an **RBAC** and **cross-source-aggregation** design captured in
`docs/research/` (both scoped as the next round). Prior round: EUI icon fix
(`appendIconComponentCache`), Chat redesign + `ChatPanel`, in-case chat,
**Reinvestigate**, structured lifecycle actions, robust Standup. The legacy Kibana
plugin is **archived** (`archive/`).
Active development branch: **`Testing`**. See `docs/VIGIL_STUDY.md` for the study +
multi-wave plan and `ROADMAP.md` for live status.

Done (this round — browse logs per source + connection-test/TLS fixes; additive,
spine + the 12 non-negotiables intact):
- **Browse a source's logs** — `GET /api/sources/{id}/logs?limit=&query=&from=&to=`
  (auth-protected): PULL sources run a bounded (hard-cap 200), read-only,
  field-mapping-aware scoped search honoring the source's own
  `data_view_pattern`/mapping/TLS; PUSH sources return the last N events from a new
  in-memory **live-tail ring buffer** (cap 500/source) in `IngestService`. Each row
  is `{ts, source_ip, user, host, rule, severity, message, _raw}`; **secrets are
  never returned**. `capabilities:["browse"]` on pull manifests + auto-applied to
  every push receiver gates the new webui **SourceLogsFlyout** (search + time range
  + 10s live-tail).
- **Test-connection works for read-only keys** — `ElasticConnector.test_connection`
  no longer gates on `ping()` (a scoped read-only key cannot `HEAD /`); the cheap
  scoped read is now authoritative (`ok:true, mode:"read_only"`), `ping()` only an
  extra `cluster_monitor` signal (`mode:"full"`). `ConnectionTest` gained
  `mode` + `cluster_monitor`; the webui shows a green read-only/full success callout.
- **Per-source TLS honored** — `AppState.es_client_for_source()` builds a per-source
  ES client from the source's merged config+secrets (`es_verify_certs`/`es_ca_cert`/
  `es_url`/`es_api_key`, mgmt key dropped); the primary log source + browse endpoint
  use it; sources with no overrides keep the shared global client.

Done (prior round — explainability, RAG management, agent memory, dashboards/
collaboration; additive, spine + the 12 non-negotiables intact):
- **RAG ingest + management + visibility** ("see the RAG") — `engine/chunking.py`
  (`chunk_text`, dep-free paragraph-pack + overlap); `VectorStore` ABC gained
  `list_documents/list_chunks/delete_document/stats` (InMemory + ES `dense_vector`
  + SQL); `RagService.import_document/list_documents/get_document/delete_document/
  rag_stats` (built-in seed sources `runbook/mitre/suppression/resolved_case`
  guarded unless `force=true`). Routes: `GET /api/rag/stats`, `GET /api/rag/
  documents`, `GET /api/rag/documents/{id}`, `POST /api/rag/import`, `DELETE
  /api/rag/documents/{id}?force=`, `GET /api/rag/search?q=&top_k=` (live retrieval).
- **Agent memory (Claude.ai-style durable operator facts)** — `stores/memory.py`
  `MemoryStore` over the existing KVStore (no new index/migration; `EsKVStore` /
  `SqlKVStore` adapters), `MemoryEntry` model; auto-injected into BOTH automated
  investigations and chat as a DISTINCT `<<<MEMORY>>>` TRUSTED block
  (precedence policy>base>playbook>MEMORY>untrusted; `render_memory()` + `fence()`
  neutralises forged markers). Memory NEVER overrides the deterministic CaseManager
  (#3) — it only informs the LLM. Edited explicitly via REST
  (`GET/POST/PUT/DELETE /api/memory`, source=human) or in chat ("remember:"/"forget",
  source=agent, audited); chat JSON gained `memory_action` (executed) +
  `memory_suggestion` (UI-confirm, never auto-saved).
- **Case explainability** — investigator emits a CONTEXT audit record (new
  `ActionType.CONTEXT`) of the persona/playbook/memory/knowledge/enrichment given,
  + a reasoning excerpt on VERDICT; `GET /api/cases/{id}/rationale` assembles a
  pure "why" object (verdict/confidence/status/decision_by, persona, playbook+reason,
  memory_used, knowledge[RAG/runbook snippets], enrichment, tools[commands/queries
  run], reasoning, the DETERMINISTIC `decision_rationale`, mitre, evidence).
- **webui** — new **Knowledge** page (RAG corpus stats, import paste/file upload,
  documents table + chunk drill-in, guarded force-delete, "try a retrieval") and
  **Memory** page (add/inline-edit/delete/active-toggle, human-vs-agent source
  badges) under a new **Platform** nav; case **"Why"** tab (consumes `/rationale`);
  chat memory-action echo + dismissible "remember this?" suggestion; Metrics
  "Knowledge base & memory" section + Overview RAG/memory tiles; Cases-list
  collaboration (sortable assignee, tags + comment-count badges, filters). All
  attacker-influenceable text renders as plain text / `EuiCodeBlock` (#9 upheld);
  no new npm deps.

Done (Wave 3 — analytics, eval loop, collaboration, white-label UI + CI; additive):
- **Metrics/analytics** (`engine/metrics.py`, `GET /api/metrics`) + a Metrics page:
  verdict/status mix, persona/playbook usage, MTTR, per-day trend, feedback rollup.
- **AI-decision feedback loop** (`Case.feedback`, `POST /api/cases/{id}/feedback`,
  `GET /api/feedback/stats`) — analyst grades the AI verdict; agreement/quality stats.
- **Case collaboration** (`Case.tags/comments/assignee` + routes) + flyout/list UI.
- **Org branding / white-label** (`BrandingConfig` on Preferences; public
  `GET /api/branding`, protected `PUT`): runtime-themeable accent (CSS vars), logo
  upload, branding settings panel + branded shell/login.
- **Case export** (`GET /api/cases/{id}/export?format=json|md`) + flyout menu.
- **Case hover preview** + a broad webui visual polish pass (skeletons, page headers,
  KPI deltas, inline-markdown chat, reduced-motion).
- **CI/CD** (`.github/workflows/ci.yml`): PR merge gate = offline backend suite
  (incl. auth route-coverage) + webui build; aggregate `CI passed` check.

Done (Wave 2 — Markdown playbooks + optional auth, additive, spine intact):
- **Markdown playbook engine** (`app/playbooks/` + `backend/playbooks/*.md`):
  operator-authored phased procedures, DETERMINISTICALLY selected per cluster
  (`registry.select_playbook`, no LLM in the default path), injected as a DISTINCT
  TRUSTED block (`<<<PLAYBOOK>>>`) separate from the fenced UNTRUSTED evidence; a
  playbook can only RECOMMEND. Atomic hot-reload; `GET /api/playbooks`,
  `POST /api/playbooks/reload`, `GET /api/playbooks/selection/{case_id}`. 3 seed
  playbooks. Selection/fallback audited; `Case.playbook_id` recorded.
- **AutoClosePolicy** (`engine/case_manager.decide`): per-verdict-class auto-close
  (see #3) — FP on above a bar, TP opt-in (off), NEEDS_HUMAN never; stored
  `fp_auto_close` migrated for back-compat.
- **Optional auth (default OFF — the no-auth "old version" stays the default)**:
  `app/auth/` (PBKDF2 + stdlib HS256 JWT) + `app/middleware/` (security-headers /
  CSRF / rate-limit); router-level `require_auth` gate (no-op when disabled) with a
  tiny `PUBLIC_API_PATHS` allowlist; `/api/auth/{login,me,logout}`; a CI
  route-coverage test that fails if any `/api` route bypasses auth.

Done (the Vigil-inspired overhaul — Wave 1, additive, spine intact):
- **Multi-agent roster** — declarative `AgentPersona` registry (`agents/personas.py`):
  the cluster is routed deterministically to a specialist (identity / web / recon /
  malware / threat-intel) that specialises the ONE investigator; persona recorded
  on the case + audit; `GET /api/personas`.
- **Plain-text runbooks** — Markdown runbooks (`backend/app/runbooks/*.md`) loaded by
  `engine/runbooks.py` and indexed into the RAG corpus as retrievable knowledge;
  `GET /api/runbooks`. (Per-cluster PROCEDURE injection moved to the Wave-2 playbook
  system; runbooks are RAG knowledge only.)
- **Hybrid RAG** — drawer-floor-first vector + dependency-free BM25 re-ranking in
  `tools/rag.py` (recovers exact IOC/rule tokens that embed as noise).
- **Tool safety tiers** — `ToolTier` (safe/managed/requires_approval/forbidden) on
  the tool base; the investigator gates non-safe tools (proposes, never executes).
- **Hardened fencing + cost provenance** — `fence()` escapes forged close-markers +
  carries source/tool provenance (#9); `pricing_source` (exact/heuristic/zero/
  default) threaded onto every `UsageDoc`.

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

Remaining (see `ROADMAP.md` + `docs/VIGIL_STUDY.md`):
- **Wave 2 leftovers:** an approval workflow (HITL action gating) + a pre-flight
  projected-cost gate + a `$`-budget ceiling (the `ToolTier.requires_approval`
  groundwork + `AutoClosePolicy` are in place). Optional: default auth ON for a
  hardened profile (compose), CSRF cookie issuance for the webui.
- **Wave 3:** durable operator memory + case explainability + RAG management/
  visibility shipped this round (see "Done (this round)" above). Still open: a
  temporal knowledge graph + cross-case memory linkage; a real MITRE module from a
  bundled STIX file; a detection-rule RAG corpus; HITL / Auto-Ops webui surfaces.
- **Wave 4 / Epoch E:** ARQ workers + KEDA scale-out; a Helm chart; OTEL+Grafana.
- More pull connectors — **Splunk + Microsoft Sentinel** next (enum'd, not yet built).

Every item ends with: `pytest -q` green (keep the count current), `webui` build
clean, docs updated, **Journal updated**, commit + push.

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
