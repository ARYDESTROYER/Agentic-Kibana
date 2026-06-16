# CONTRIBUTING.md — Developer workflow

How to work on the **TLSOC Agentic Triage Suite**. Read [`CLAUDE.md`](CLAUDE.md)
first — it is the master context (architecture, the 12 non-negotiables,
environment, and the Journal mandate). This file is the practical workflow that
sits on top of it.

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

## 3. Plugin (`plugin/tlsoc_agentic_triage/`)

### 3.1 Conventions

- **`@kbn/*` import aliases**, never deep relative platform paths — they move
  between Kibana versions (`COMPATIBILITY.md` §; `CLAUDE.md` §8).
- **NO new npm deps.** Only monorepo packages are available; adding a dependency
  breaks the build. Use **EUI** for all UI; functional components + hooks.
- **Backend ↔ plugin contract.** Additive request/response JSON fields are safe
  — the Kibana proxy forwards arbitrary JSON, so additive fields need **no proxy
  change** (`CLAUDE.md` §3). **Keep `common/index.ts` types in sync with
  `backend/app/models.py`** whenever a contract changes.

### 3.2 Build & verify

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

## 4. Extending the suite

Each extension point is small and deterministic by design. Whatever you add,
**the 12 non-negotiables (`CLAUDE.md` §5) must never regress.**

- **A new tool** — add an MCP-shaped tool under `tools/` following
  `tools/base.py` (name, description, input schema, async `run`). It is exposed
  to the investigator via `tool_defs_text` (`agents/prompts.py`). Log-derived
  output stays untrusted; reads only — never write the log surface.
- **A new agent role** — add the role to `constants.py:Role`, give it a system
  prompt in `agents/prompts.py` (include `_INJECTION_NOTE`), a `ModelConfig` in
  `config.py:Preferences` wired into `model_for(...)`, and call it through the
  **single gateway** (`llm/gateway.py`) — never a provider directly, so the cost
  ledger stays complete (non-negotiable #6).
- **A new surface** — add a backend route in `api/routes.py` (return
  `model_dump(mode="json")`), the matching plugin component + `lib/api.ts` call,
  and keep `common/index.ts` in sync. Additive JSON needs no proxy change.
- **A new Preference** — add the field (with a working default) to
  `config.py:Preferences`. It **round-trips automatically** through
  `GET`/`PUT /api/settings` (the deep-merge + `Preferences.model_validate` in
  `routes.py`), so the only extra work is surfacing it in the Settings UI.

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

- [ ] `pytest -q` green (backend).
- [ ] `tsc --noEmit` clean; 8.19.12 zip rebuilt + verified (if plugin changed).
- [ ] `common/index.ts` in sync with `models.py` (if the contract changed).
- [ ] No new npm deps; `@kbn/*` aliases only; EUI only.
- [ ] No secret in git / ES / logs; UI shows booleans only.
- [ ] None of the 12 non-negotiables regressed.
- [ ] Companion docs updated (USAGE / TROUBLESHOOTING / BUILD / DEPLOY / README
      as relevant).
- [ ] **`Journal.md` updated**; commit carries the session trailer.
