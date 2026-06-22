# CONTRIBUTING.md — Developer workflow

How to work on the **Agentic SOC Triage Suite** (vendor-agnostic). Read
[`CLAUDE.md`](CLAUDE.md) first — it is the master context (architecture, the 12
non-negotiables, environment, and the Journal mandate). This file is the practical
workflow that sits on top of it.

> **Surfaces.** The standalone web UI (`webui/`, Vite + React + EUI) is the
> **primary** UI; the Kibana plugin (`plugin/tlsoc_agentic_triage/`) is **legacy**.
> The backend (`backend/`) is OCSF-canonical with a pluggable connector layer and a
> selectable state backend (ES / Postgres / SQLite).

> The build/dev environment is an **ephemeral** cloud container: the repo is
> cloned fresh and reclaimed on inactivity. **Commit + push or it is lost.**
> (`docs/ENVIRONMENT.md` §1.)

## 1. Branch, commits, and the Journal mandate

- **Branch:** `claude/sharp-tesla-t73bqy`. Commit focused changes; push often.
- **Commit / PR trailer** (every commit and PR body):

  ```
  https://claude.ai/code/session_01JxMk6xXxXEgQ1JKUnD7EF6
  ```

- **The Journal mandate (non-negotiable process rule).** Every agent (and the
  orchestrator) **MUST** append an entry to [`Journal.md`](Journal.md) at the
  start and end of any session, and after any meaningful milestone (a feature
  done, a build produced, a test run, a decision, a blocker). The Journal is the
  shared memory across context resets and sub-agents. **If you did work and did
  not journal it, the work is not done** (`CLAUDE.md` §0). Sub-agents that cannot
  commit must **return their Journal entry in their final report** so the
  orchestrator appends it. Use the format at the bottom of `CLAUDE.md`.

## 2. Backend (`backend/`)

### 2.1 Setup & the test gate

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q          # MUST be green before every commit
```

Tests run **fully offline** — fake ES + mock LLM provider, no network
(`docs/ENVIRONMENT.md` §1.4). This is the primary correctness gate; keep it
green and **add/keep offline tests** for any behaviour you touch.

### 2.2 Conventions

- `from __future__ import annotations`, full type hints, module docstrings,
  **async throughout** (`CLAUDE.md` §8).
- **Pydantic v2.** Use `model_dump(mode="json")` for every ES write and every
  response body (see `api/routes.py`, `config.py`).
- **Never drop an alert.** Any LLM / ES / tool error must route to
  **`NEEDS_HUMAN`**, never silently fail. The gateway raises `GatewayError`
  (`llm/gateway.py`) and the case manager fails safe to a human
  (`engine/case_manager.py`).
- **Secrets are env-only.** Never persist a secret to ES, git, or logs; the UI
  sees booleans only (`config.py:configured_status`).

## 3. Web UI (`webui/`) — the primary frontend

A standalone Vite + React + `@elastic/eui` SPA that talks to the backend directly
over `/api/*` (see `webui/README.md`).

### 3.1 Conventions

- **No Kibana / `@kbn/*` imports** — this is a self-contained npm project, so new
  dependencies **are** allowed here (unlike the plugin). Use **EUI**; functional
  components + hooks.
- **Reuse `ConnectorForm`** (`src/components/common/`) for anything that renders an
  `AuthField[]` — it turns a connector manifest into a validated form, so a new
  source needs zero bespoke UI.
- **Typed API client.** Route all calls through `src/lib/api.ts` (non-2xx →
  `ApiError` carrying the backend `detail`).

### 3.2 Develop & build

```bash
cd webui
npm install
npm run dev          # http://localhost:5173, proxies /api -> :8088
npm run build        # tsc --noEmit + vite build -> dist/  (MUST stay clean)
npm run typecheck    # type check only
```

## 3b. Legacy Kibana plugin (`plugin/tlsoc_agentic_triage/`)

> The plugin is **legacy** (superseded by `webui/`). Touch it only for legacy
> deployments; the rules below still apply if you do.

### Conventions

- **`@kbn/*` import aliases**, never deep relative platform paths — they move
  between Kibana versions (`COMPATIBILITY.md`; `CLAUDE.md` §8).
- **NO new npm deps.** Only monorepo packages are available; adding a dependency
  breaks the build. Use **EUI** for all UI; functional components + hooks.
- **Backend ↔ plugin contract.** Additive request/response JSON fields are safe
  — the Kibana proxy forwards arbitrary JSON, so additive fields need **no proxy
  change** (`CLAUDE.md` §3). **Keep `common/index.ts` types in sync with
  `backend/app/models.py`** whenever a contract changes.

### Build & verify

Build per [`plugin/BUILD.md`](plugin/BUILD.md) (the authoritative recipe, both
versions). New builds **MUST** produce `plugin/dist/tlsocAgenticTriage-8.19.12.zip`
(`CLAUDE.md` §2). Triple-verify statically (live install is a deploy step,
`docs/ENVIRONMENT.md` §1.4):

```bash
tsc --noEmit                                                   # clean
unzip -l build/*.zip | grep tlsocAgenticTriage.plugin.js       # bundle present
unzip -p <zip> kibana/tlsocAgenticTriage/kibana.json | grep kibanaVersion   # correct version
# no-leak: the backend URL must NOT appear in the browser bundle
grep -c tlsoc-backend <browser-bundle>                         # == 0
```

## 4. Repo layout & extension points

The pieces you are most likely to extend:

```
backend/app/
  ocsf/         canonical event schema. model.py (OCSFEvent + unmapped/raw_data
                catch-alls), ecs.py (ecs_to_ocsf + generic_to_ocsf). Every
                connector normalises to OCSF before the engine sees anything.
  connectors/   the source SPI. base.py (PullConnector / PushReceiver +
                ConnectorManifest/AuthField), registry.py (built-in + entry-point
                discovery), elastic.py / opensearch.py / wazuh.py (pull),
                receivers/ (the 16 push receivers; optional deps lazy-imported).
  stores/       persistence. stores/sql/ (SQLAlchemy async engine + models +
                repositories + vectorstore) backs STATE_BACKEND=postgres|sqlite;
                the ES stores back STATE_BACKEND=elasticsearch.
  engine/ agents/ tools/ llm/   correlation/risk/case-manager, the ReAct agents,
                MCP-shaped tools, and the single cost-ledger gateway.
  api/routes.py the HTTP contract (connectors, sources, ingest, analytics).
webui/          the standalone SPA (primary UI). plugin/  the legacy Kibana plugin.
```

Each extension point is small and deterministic by design. Whatever you add,
**the 12 non-negotiables (`CLAUDE.md` §5) must never regress.**

- **A new tool** — add an MCP-shaped tool under `tools/` following
  `tools/base.py` (name, description, input schema, async `run`). It is exposed
  to the investigator via `tool_defs_text` (`agents/prompts.py`). Event-derived
  output stays untrusted; reads only — never write a source.
- **A new agent role** — add the role to `constants.py:Role`, give it a system
  prompt in `agents/prompts.py` (include `_INJECTION_NOTE`), a `ModelConfig` in
  `config.py:Preferences` wired into `model_for(...)`, and call it through the
  **single gateway** (`llm/gateway.py`) — never a provider directly, so the cost
  ledger stays complete (non-negotiable #6).
- **A new surface** — add a backend route in `api/routes.py` (return
  `model_dump(mode="json")`), then the matching web UI component + `webui/src/lib/api.ts`
  call. (Keep `plugin/common/index.ts` in sync only if you also touch the legacy
  plugin.)
- **A new Preference** — add the field (with a working default) to
  `config.py:Preferences`. It **round-trips automatically** through
  `GET`/`PUT /api/settings` (the deep-merge + `Preferences.model_validate` in
  `routes.py`); the only extra work is surfacing it in Settings.
- **A new state backend table/repo** — extend `stores/sql/models.py` +
  `repositories.py`; keep Postgres-only deps (asyncpg/pgvector) **lazy** so the ES/
  SQLite paths still import without them.

## 4a. Writing a connector

A connector turns an external source into a stream of normalised OCSF/`RawEvent`s.
Implement one of the two SPI shapes in `backend/app/connectors/base.py`:

- **`PullConnector`** — *we drive it.* Implement `ping`, `poll(prefs, cursor,
  from_millis)` (in-scope events at/after the inclusive lower bound, time-ascending;
  the poller advances the cursor + dedups), `search(prefs, StructuredQuery)` (backs
  the `es_query` tool — compile the source-neutral `StructuredQuery` IR to your
  dialect; the LLM never emits raw DSL), and `fetch_by_ids`. See `elastic.py` /
  `opensearch.py` / `wazuh.py`.
- **`PushReceiver`** — *it drives us.* Implement `start(emit, prefs)` /`stop` (run a
  listener / consume a broker / poll an object store; deliver each normalised batch
  via the `emit` callback) and `parse(payload, prefs)`. HTTP receivers also expose
  `verify_auth` + `handle_request` and are route-driven via `POST /api/ingest/{id}`
  (no socket). See `receivers/webhook.py` (auth modes), `receivers/syslog.py`
  (socket), `receivers/queues.py` / `objectstore.py`.

Then:

1. **Ship a `ConnectorManifest`** from the classmethod `manifest()` (static — no
   credentials/instance needed). Its `auth_fields` + `config_fields`
   (`AuthField`s) **drive the wizard form** with zero per-connector UI code; mark
   credentials `secret=True` (UI shows configured-only). Set `category`,
   `ingest_modes`, `capabilities`, and `requires_pip` (any optional deps).
2. **Normalise to OCSF** by overriding `to_ocsf(raw, prefs)` with a precise mapper,
   or rely on the default `generic_to_ocsf`. Map what you can; everything else goes
   to `unmapped`, and keep the original record in `raw_data`. The engine NEVER sees
   source-native records.
3. **Register it.** Built-in: add the class to `_BUILTIN_PULL` (registry.py) or
   `BUILTIN_RECEIVERS` (`receivers/__init__.py`). Out-of-tree: publish it under the
   **`tlsoc.connectors` entry-point group** so `pip install
   tlsoc-connector-<vendor>` makes it appear in the wizard with no core change.
4. **Lazy-import optional deps** inside `start()`/runtime — never at module import
   — so the base image stays slim and importable. Raise the wizard-friendly
   `ConnectionError("… Install it with: pip install <lib>")` pattern (see
   `receivers/queues.py:_require`).
5. **Add offline tests** — exercise `manifest()`, `to_ocsf`/`parse` (call them
   directly, no socket/network), and auth. Keep `pytest -q` green.

A new `SourceType` enum value (`constants.py`) and (for receivers) the right
`IngestMode`(s) are the only core touch-points for a built-in.

## 5. Sub-agent workflow

- Delegate context-heavy or isolated work (builds, tests, docs, isolated modules)
  to sub-agents. Give each the exact files, interfaces, acceptance criteria, and
  "run `pytest`/`tsc` until green" (`CLAUDE.md` §9).
- **Sequence** agents that touch shared files (`models.py`, `config.py`,
  `routes.py`, plugin `app.tsx`) to avoid edit conflicts; **parallelize** only
  non-overlapping work.
- Every sub-agent ends its report with a **Journal entry** for the orchestrator
  to append (sub-agents don't commit). The orchestrator owns cross-cutting
  contracts and integration, runs the final build + tests, commits, pushes, and
  updates the Journal.
- **Update `Journal.md` every session** — start, end, and at each milestone.

## 6. Pre-commit checklist (every change)

- [ ] `pytest -q` green (backend, offline).
- [ ] `webui`: `npm run build` clean (if the web UI changed).
- [ ] New connector: manifest + OCSF mapping + registration + lazy deps + offline
      tests (if you added one).
- [ ] Legacy plugin (only if touched): `tsc --noEmit` clean; 8.19.12 zip rebuilt +
      verified; `common/index.ts` in sync with `models.py`.
- [ ] No secret in git / state store / logs; UI shows booleans only.
- [ ] None of the 12 non-negotiables regressed.
- [ ] Companion docs updated (USAGE / TROUBLESHOOTING / RUNBOOK / SECURITY /
      webui/README / DEPLOY / README as relevant).
- [ ] **`Journal.md` updated**; commit carries the session trailer.

---

## Continuous integration (merge gate)

`.github/workflows/ci.yml` runs on every pull request (and pushes to `main` /
`Testing`) and must be green before merge. Two jobs:

1. **Backend tests (offline)** — `cd backend && pip install -r requirements-dev.txt
   && python -m pytest -q`. Fully offline (fake ES + mock LLM, no network or keys).
   This includes `tests/test_route_auth_coverage.py`, so a new `/api` route that
   bypasses the auth gate fails CI.
2. **Web UI build** — `cd webui && npm ci && npm run build` (`tsc --noEmit && vite
   build`). Fails on a type error or a build break; also catches accidental new npm
   deps via the committed `package-lock.json`.

An aggregate **`CI passed`** check depends on both. To enforce it:

> **GitHub → Settings → Branches → Branch protection rule** for `main`: require the
> status check **`CI passed`** (and "Require branches to be up to date before
> merging"). PRs then cannot merge until backend tests and the web UI build pass.

Run both locally before pushing — they are the same commands CI runs.
