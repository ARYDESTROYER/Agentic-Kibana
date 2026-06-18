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

The **TLSOC Agentic Triage Suite** is an agentic SOC (Security Operations Center)
triage system for the TrustLab / IIT Bombay ELK pipeline. It sits **next to** an
existing production pipeline as a **read-only consumer** and turns raw alert
volume into audited, cost-metered, human-reviewable cases.

Upstream pipeline (we do NOT modify it):
```
rsyslog (omkafka) → Kafka → foss-soc-engine → Logstash → Elasticsearch (all-logs-*) → Kibana
```

Two components, loosely coupled:
- **Backend** (`backend/`) — FastAPI + LangGraph. ALL the agentic logic: polling,
  correlation, risk scoring, the two-tier LLM investigation, the deterministic
  case manager, tools (es_query/enrich/rag), the single LLM gateway + cost ledger,
  and the suite's own Elasticsearch indices.
- **Plugin** (`plugin/tlsoc_agentic_triage/`) — a thin Kibana plugin (React + EUI)
  that renders the surfaces and talks to the backend ONLY through a Kibana
  server-side proxy.

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
┌──────────────────────── Kibana 8.19.12 ─────────────────────────────────┐
│ Plugin (browser, React/EUI):                                            │
│  • In-nav app: Chat · Investigate · Automated Scans · Standup · Cost ·  │
│    Settings/Wizard                                                       │
│  • (roadmap) global header chat button + flyout; per-log AI overview    │
│  TlsocApi (public/lib/api.ts) → core.http → /api/tlsoc/{path}           │
└───────────────────────────────────────────────┬─────────────────────────┘
                       Kibana server proxy        │ server/routes/index.ts
                       /api/tlsoc/{path*} ─────────▶ ${backendUrl}/api/{path}
                       (backendUrl default http://tlsoc-backend:8088)
┌──────────────────── tlsoc-backend (FastAPI + LangGraph) ─────────────────┐
│ poll(durable cursor) → correlate (deterministic) → risk (deterministic)  │
│   → cost-gate → router (cheap LLM) → investigator (strong LLM, ReAct)     │
│   → formatter → Case Manager (deterministic close/escalate)              │
│ tools: es_query (READ-ONLY logs) · enrich (Redis-cached) · rag_retrieve   │
│ single LLM gateway ──▶ usage/cost ledger (every call)                     │
│ owns indices: tlsoc-agent-{cases,audit,usage,config,cursor}              │
└──── read-only key → all-logs-*    ·    mgmt key → tlsoc-agent-* ──────────┘
```

Request path detail (memorize it):
`browser TlsocApi.get('cases')` → `core.http GET /api/tlsoc/cases` → Kibana route
`/api/tlsoc/{path*}` (`server/routes/index.ts`) → `fetch(${backendUrl}/api/cases)`
→ FastAPI route in `backend/app/api/routes.py`. **The proxy forwards arbitrary
JSON bodies, so additive request fields need NO proxy change.**

## 4. Repository layout

```
backend/app/
  config.py          Secrets (env-only) + Preferences (UI-editable, ~91 fields)
  constants.py       enums, index names, verdict/role/action types, fences
  models.py          Pydantic data contracts (Case/AuditDoc/UsageDoc/Cursor/...)
  utils.py           dotted_get, time helpers, extract_json, coerce_float, ...
  es/                base (ABC) · client (real, two-key) · fake (in-memory) ·
                     querybuilder · indices (templates + bootstrap)
  llm/               gateway (THE cost-ledger choke point) · providers · pricing
  tools/             base (MCP-shaped) · es_query · enrich · rag · vectorstore
  engine/            correlation · risk · cost_gate · case_manager · signatures · poller
  agents/            prompts · router · investigator · formatter · chat · standup ·
                     graph (LangGraph) · pipeline · common
  stores/            cases · usage · config_store · cursor_store    audit/audit_log
  api/               routes (plugin contract) · deps    state.py (DI hub) · main.py
backend/tests/       offline tests (fake ES + mock LLM) — MUST stay green
plugin/tlsoc_agentic_triage/
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
deploy/              docker-compose.tlsoc.yml · mappings/ · dashboards/
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
   selections, queries — anything attacker-influenceable.
10. Sane defaults; only keys + data scope required to run (`config.py`).
11. Spine first & tested (Gate 1); breadth degrades gracefully (Gate 2).
12. Read-only consumer; upstream untouched; cold-deployable.

## 6. Environment (build/dev sandbox AND deploy target)

See `docs/ENVIRONMENT.md` for the full detail. Summary:

### 6a. This build/dev sandbox (Claude Code on the web)
- Ephemeral container; repo cloned fresh; **commit + push or it's lost.**
- Tooling: `/opt/node22` default on PATH (WRONG for Kibana builds); nvm at
  `/opt/nvm/nvm.sh` (use the per-version pin); Python 3.11 + `backend/.venv`;
  Docker daemon can be started (`sudo dockerd &`) but **image registries are
  BLOCKED** (docker.elastic.co + Docker Hub blobs 403) — you CANNOT pull
  ES/Kibana images or run the real stack here.
- Network: `github.com`, `pypi.org`, `registry.npmjs.org`, `nodejs.org` reachable.
  BLOCKED by the egress allowlist: container registries, some Chrome/Playwright
  CDNs (`edgedl.me.gvt1.com`, `cdn.playwright.dev`,
  `playwright.download.prss.microsoft.com`), `ci-stats.kibana.dev` (telemetry).
- Kibana source checkouts live in `/tmp` (e.g. `/tmp/kibana-8.19`, bootstrapped).
  Keep them warm; `rm -rf` an unused one if disk is tight (~18-22GB free).
- **Consequence:** we verify builds statically (tsc + unzip + manifest checks) and
  the backend via offline tests; live install on a real Kibana is a DEPLOY step.

### 6b. Deploy target (the SIEM server — separate session)
- `TLSOCDockerDeploy` stack running: containers `elasticsearch`, `kibana`,
  `logstash`, `kafka` (8.19.12), TLS via local CA under `./certs/`, default Compose
  network, logs in `all-logs-*` (data view default `fosstlsoc-logs-*` per the
  wizard — confirm on the live stack).
- The backend joins that network as `tlsoc-backend`; reaches
  `https://elasticsearch:9200` by container name; mounts `./certs/ca/ca.crt:ro`.
- Plugin installed via `kibana-plugin install file://…zip` + restart (ephemeral
  Phase-1; Phase-2 = derived image/mount).
- Secrets via `.env` (`TLSOC_*` vars). Wizard-pushed secrets are IN-MEMORY only
  (lost on backend restart) — `.env` is the durable path.

## 7. Build / run / test cheatsheet

```bash
# Backend tests (offline; MUST stay green)
cd backend && python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
python -m pytest -q

# Backend run locally (in-memory store, mock LLM if no keys)
uvicorn app.main:app --port 8088

# Plugin build for 8.19.12 (see plugin/BUILD.md for the full recipe + troubleshooting)
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

Current: Phase-1 spine complete + 49 backend tests green; both plugin zips built;
docs complete. Active work order (see `ROADMAP.md` for live status):
- **P0** Case detail + lifecycle in the UI.
- **P1** Case/verdict stability + provenance; RAG improvements.
- **P2** Risk/verdict correctness.
- **Feature 1** Global header chat button + context-aware flyout.
- **Feature 2** Per-log "AI overview" (Discover doc-viewer tab + in-app).
- **Feature 3** "Why was this triggered" trigger-reason on findings.
- **Feature 4** Comprehensive settings + per-task model selection.
- **Feature 5** First-run setup wizard rewrite.
Every item ends with: rebuild the **8.19.12** zip, `pytest -q` green, plugin
build verified, docs updated, **Journal updated**, commit + push.

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
