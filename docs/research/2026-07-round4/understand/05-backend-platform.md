# Round 4 — Understand Map 05: Backend Platform

> Domain: **stores/KV · SQL backend · auth/RBAC · deps · routes · notifications ·
> middleware · tests · demo.** This is the plumbing every Round-4 feature bolts onto.
> Emphasis: the **KVStore zero-migration store pattern** to mirror for the tuning +
> batch stores (with SQL parity), the **RBAC `require_permission` + route-auth-coverage
> CI** every new endpoint must satisfy, where the new Round-4 routers mount, and how a
> **reset** stays secret-safe. Cross-cutting facts from the other 16 readers are folded
> in where they touch this plumbing; the primary subject is the platform.

---

## 0. TL;DR for a build agent

- **New durable state → mirror `stores/user_prefs.py`.** ONE JSON doc in a KV
  namespace (`ns`/`key`), read-modify-write via `stores/base.py::kv_mutate` (CAS +
  per-store `asyncio.Lock`), never-raises, zero new ES index / SQL table / migration.
  Add the `NS`/`KEY`/`DOC_ID` triple to `constants.py`. SQL parity is FREE — the shared
  `KVRow` table + `SqlKVStore` already back every KV store on SQLite/Postgres.
- **New endpoint → it MUST pass the route-auth-coverage CI.** Every `/api` route is
  mounted under `Depends(require_auth)`; every **non-GET** `/api` route MUST also carry a
  `require_permission(...)` (or `require_admin`/`require_role`/`require_fresh_auth`) authZ
  gate, OR be listed in `PUBLIC_API_PATHS`. `tests/test_route_auth_coverage.py` fails the
  build otherwise.
- **Round-4 endpoints land where:** `/api/logs`, `/api/tuning/*`, `/api/batch/*`,
  reset, `/api/cases/{id}/forwarding`, `/api/sources/health` are all NEW. Either add to
  the big `router` in `routes.py` or create a new `routes_*.py` feature router and mount
  it in `main.py` **with the same `dependencies=[Depends(require_auth)]`**.
- **Reset (item #7) rides `PUT /api/settings` restore-defaults semantics:** rebuild a
  fresh `Preferences()` but NEVER touch `Secrets` (env tier), and (per scope) preserve
  `sources[]` / `setup_complete` / the `demo` block. `put_settings` already force-preserves
  `demo`; the reset must extend that discipline.
- **`decide()` is byte-identical, guarded by `tests/test_wave6_decide_guard.py` (4
  tests).** Nothing in this domain (routes, tuning, batch, reset) may import/call it.

---

## 1. How the platform works today, end to end

### 1.1 The DI hub + app entry
- `backend/app/state.py::AppState` is the dependency-injection hub and lifecycle owner.
  `AppState.create(secrets)` builds the ES client; `_wire()` (state.py:124) is the ONE
  place that (re)constructs every ES-derived component: state stores, `LLMGateway`,
  `AuthService`, the 13 KV stores, RAG, pipeline, chat, standup, overview, **poller**,
  ingest, notifications, threshold automation. A wizard credential change re-points the
  whole graph without a restart (`apply_secrets → _wire`).
- `backend/app/main.py::lifespan` builds `AppState` inside the async context manager,
  sets `app.state.tlsoc`, `await state.startup()`, `await state.shutdown()` on exit.
- **Router mounting (main.py:71-87):** `app.include_router(router,
  dependencies=[Depends(require_auth)])` plus the 8 Round-3 feature routers
  (`routes_metrics · routes_standup · routes_enrichment · routes_models · routes_inapp ·
  routes_cases_collab · routes_triage · routes_roles`) each mounted with the SAME
  `require_auth` dependency. Security middleware (`security_headers · csrf · rate_limit`)
  is added from a second import-time `Secrets()` (`main.py:56 _sec`) — note this is a
  DIFFERENT secrets object from the lifespan one; it only drives middleware toggles.

### 1.2 State backend + StateStore abstraction
- `STATE_BACKEND` selects Elasticsearch (default, `tlsoc-agent-*`), PostgreSQL+pgvector,
  or SQLite. `stores/base.py` defines the backend-agnostic abstract repositories
  (`CaseStore`, `AuditLogger`, `UsageStore`, `ConfigStore`, `CursorStore`, `KVStore`).
- **The KV zero-migration pattern (THE thing to mirror):**
  - Abstract `KVStore` (base.py:240): `async get(ns, key) -> dict|None`,
    `async put(ns, key, value)`.
  - ES adapter: `stores/memory.py::EsKVStore` — one doc inside the existing
    `tlsoc-agent-config` index (no new index).
  - SQL adapter: `stores/sql/repositories.py::SqlKVStore` (line 399) — one row in the
    shared `KVRow` table (`sql/models.py`), keyed `(namespace, key)`. **SQL parity is
    automatic** for any new KV store: no new table, no migration.
  - `stores/base.py::kv_mutate` (line 48): atomic, lost-update-safe read-modify-write
    over ONE doc. Two defences: (1) a caller-owned per-store `asyncio.Lock` serialises
    in-process writers; (2) a `_rev` compare-and-set retries (`_KV_MUTATE_RETRIES=8`) on
    a cross-process race. `mutator(snapshot) -> new_value` MUST be pure (may run >once).
    **Never raises** — degrades to a best-effort write. The `_rev` field is additive and
    byte-compatible with the old hand-rolled save.
- 13 KV stores today all ride this: `memory · proposals · users · sessions · user_prefs ·
  case_thread · case_activity · case_tasks · inbox · notif_prefs · custom_roles ·
  price_overlay · shift_handoff`. Their `NS`/`KEY`/`DOC_ID` triples live in
  `constants.py` (lines 44-142).

### 1.3 Auth / RBAC (default OFF)
- `auth/service.py` — multi-user (`stores/users.py` over KV) + 6 built-in roles
  (`super_admin · soc_manager · analyst_tier2 · analyst_tier1 · responder · auditor`) +
  a permission matrix + `require_permission`. Custom roles layer on the `custom_roles`
  KV store + `Preferences.rbac` (inheritance + explicit DENY + row-scope hook).
- `auth/mfa.py` (stdlib RFC-6238 TOTP + recovery codes), `auth/oidc.py`
  (Google/Microsoft/generic SSO), `auth/passwords.py` (PBKDF2), `auth/tokens.py`
  (stdlib HS256 JWT carrying `sid`+`tv`).
- **Deps** (`api/deps.py`):
  - `require_auth` (line 68) — the async router-level gate; **no-op when auth disabled**;
    honors `PUBLIC_API_PATHS` (line 15) + `_PUBLIC_INGEST_RE`; enforces session
    idle/absolute/revocation via `SessionStore` (NOT the sync `verify()` hot path).
  - `require_permission(resource, action)` (line 385) — the per-route authZ factory; the
    inner `_dep` name is what the coverage test greps for.
  - `require_admin` (424), `require_fresh_auth(window)` (433) — step-up gate.
  - `_enforce(request, resource, action)` — the imperative check the case-action route
    calls inline (routes.py:3225-3227) instead of a `Depends`.
- **Auth is DEFAULT OFF** (`Secrets.auth_enabled`), so the no-auth profile + the offline
  test suite run unchanged. `TLSOC_AUTH_ENABLED=true` seeds **Admin / Admin@123**
  (`super_admin`) via `state.seed_users`.

### 1.4 OOBE / setup (extension point for item #7)
- Public OOBE routes (in `PUBLIC_API_PATHS`): `GET /api/setup/status` (routes.py:169 —
  returns auth/RBAC/user-count/`setup_complete`), `POST /api/setup/init-admin`
  (routes.py:207 — creates the FIRST `super_admin`, **409 if any user exists**, 400 if
  auth disabled), `POST /api/setup/secrets` (routes.py:244 → `apply_secrets`),
  `POST /api/setup/complete` (routes.py:254 → sets `setup_complete=True`, starts poller).
- `setup/init-admin` is the seam Round-4 OOBE **account setup** extends: it is the ONLY
  path that mints the first admin, is one-shot (count>0 → 409), and clears
  `state._seeded_default_admin`. A "full factory reset → fresh OOBE" (item #7) must flip
  `setup_complete=False` and (when auth on) leave `init-admin` re-usable ONLY if users
  were also cleared — decide the scope explicitly.

### 1.5 Notifications / middleware / demo (context)
- `notifications/` — `NotificationChannel` SPI (mirror for any new channel): `email`
  (stdlib SMTP + SES preset), `webhook` (Slack/Teams/generic/PagerDuty/Telegram),
  `resend`, `dispatch` (per-condition triggers + dedup/rate-limit/digest; dedup key
  derives from `cluster_signature` — dispatch.py:184), `templates` (stdlib
  mustache-subset, `header_safe`/`text_safe` CRLF-strip). Channel secrets live in the
  in-memory secret tier (`Secrets.notification_secrets`), never persisted, booleans-only.
- `middleware/` — `security_headers · csrf · rate_limit` (Starlette middleware, wired in
  main.py).
- **Demo** — `AppState` owns a throwaway isolated store stack (`DemoStack` +
  `DemoSimulator`) surfaced via `@property` indirection (state.py:84-122: `cases`/`audit`/
  `usage`/`pipeline`/`ingest_service`/...). While `prefs.demo.active` the REAL poller/
  gateway are gated OFF and writes are $0/isolated. `PUT /api/settings` force-preserves
  the `demo` block (routes.py:665) so a settings write can't corrupt Demo Mode.

---

## 2. Exact key symbols / files / wire keys / endpoints

### 2.1 KV store scaffolding
| Concern | Symbol / path |
|---|---|
| Abstract KV | `stores/base.py::KVStore` (line 240) |
| Atomic RMW | `stores/base.py::kv_mutate(...)` (line 48), `KV_REV_FIELD`/`_rev_of` |
| ES KV adapter | `stores/memory.py::EsKVStore` (line 51) → doc in `tlsoc-agent-config` |
| SQL KV adapter | `stores/sql/repositories.py::SqlKVStore` (line 399) → `KVRow` |
| SQL row model | `stores/sql/models.py::KVRow` (PK `(namespace, key)`) |
| Reference store | `stores/user_prefs.py::UserPrefsStore` (copy this shape) |
| Namespace triples | `constants.py:44-142` (`*_NS`/`*_KEY`/`*_DOC_ID`) |

### 2.2 Auth / deps / RBAC
| Concern | Symbol / path |
|---|---|
| Router gate | `api/deps.py::require_auth` (68) |
| AuthZ factory | `api/deps.py::require_permission(resource, action)` (385) |
| Admin gate | `api/deps.py::require_admin` (424) |
| Step-up | `api/deps.py::require_fresh_auth(window)` (433) |
| Inline check | `api/deps.py::_enforce(request, resource, action)` |
| Public allowlist | `api/deps.py::PUBLIC_API_PATHS` (15) + `_PUBLIC_INGEST_RE` |
| Coverage CI | `tests/test_route_auth_coverage.py` |

### 2.3 The case-action map (item #3 lives here)
`api/routes.py` around line 3127:
- `_ACTION_STATUS: dict[str, CaseStatus | None]` (3127) — the lifecycle-target map.
  **`"acknowledge": None` (line 3136) is bug #3.**
- `_CLOSE_ACTIONS = {"close","confirm_fp","resolve","reopen"}` (3143) — need `cases:close`.
- `_TERMINAL = {CaseStatus.CLOSED, CaseStatus.RESOLVED}` (3147).
- `_guard_transition(action, current, target)` (3150) — blocks illegal terminal exits;
  `set_status → CLOSED` is rejected (must go through `close`).
- `_case_action_grant` / `_grant_for_body` (3170/3191) — RBAC grant resolution.
- `POST /api/cases/{id}/action` (3209) → `_perform_case_action` (3232) — the SINGLE human
  analyst layer; **never calls `decide()`**; audits every transition (#2).

### 2.4 Settings / reset surface (item #7)
- `GET /api/settings` (633) — `{prefs, configured (booleans only), read_only}`.
- `GET /api/settings/schema` (642, `settings:read`) — descriptive, no values, NO secrets.
- `PUT /api/settings` (654, `settings:manage`) — `_deep_update` merge → `Preferences.model_validate`
  → `state.update_prefs`; **force-preserves `merged["demo"]`** (665); restarts poller if
  eligible. Respects `read_only_settings_mode`.
- `POST /api/settings/case-id/preview` (682), `GET /api/settings/{section}` (698).
- **No `restore-defaults`/reset route exists yet** — item #7 adds it, sharing
  `put_settings`' discipline (validate + `update_prefs` + demo-preserve).

### 2.5 Feature routers to mirror / mount
Mount pattern (main.py:71-87): create `api/routes_<feature>.py` with a `router =
APIRouter(prefix="/api")`, gate non-GET routes with `require_permission`, then
`app.include_router(routes_<feature>.router, dependencies=[Depends(require_auth)])` in
`main.py`. Existing budget/model routes (`routes_models.py`: `GET/PUT /api/budget`,
`GET /api/budget/status`, `POST /api/llm/cost/estimate`) are the closest template for a
new `routes_tuning.py` / `routes_batch.py`.

---

## 3. Where the Round-4 bugs live + exact fix surface (platform view)

### Bug #3 — "Acknowledge" maps to `None` (does nothing)
- **Location:** `api/routes.py:3136`, `_ACTION_STATUS["acknowledge"] = None`.
- **Fix:** change to `CaseStatus.INVESTIGATING`.
- **Why it is #3-safe:** `_perform_case_action` is the HUMAN analyst layer; it NEVER calls
  `case_manager.decide()`. `INVESTIGATING` is a valid, additive, NON-terminal status (in
  `OPEN_CASE_STATUSES`). `_guard_transition` only blocks terminal EXITS — `open →
  investigating` passes cleanly. RBAC stays `cases:write` (acknowledge is not in
  `_CLOSE_ACTIONS`, and INVESTIGATING is not in `_TERMINAL`, so `_grant_for_body` does not
  upgrade to `cases:close`). **Do NOT add `acknowledge` to `_CLOSE_ACTIONS` and do NOT add
  `INVESTIGATING` to `_TERMINAL`.** Constants need no change (`CaseStatus.INVESTIGATING`
  already exists). Stamp `case.acknowledged_at` here for MTTA (models.py has the datetime
  anchor; mind the str-vs-datetime asymmetry on `created_at`).

### Bug #1 — single-source poller (state.py, not this domain's core, but the router glue is here)
- The manual poll route `POST /api/poll` (routes.py:3987) calls `state.poller.poll_once`.
  With a `PollerManager` this becomes ambiguous — decide "poll all" vs "poll primary" and
  keep the route + tests green. `state.poller.start()/stop()` are also called from routes
  (259/672) and state (758/878/891/1065); the manager MUST expose the same
  `start()/stop()/poll_once(prefs)`/`_source` surface.

### Bug #2 — LLM pricing (NOT in this domain)
- Lives in `llm/pricing.py` + `llm/model_registry.json` + wiring `providers.with_retry`.
  Platform touchpoint: `UsageDoc` (`models.py`) has NO cache/batch/`custom_id` fields
  today; item #2/#5/#11 add them additively. The route-auth-coverage + KV patterns are
  unaffected.

### Feature endpoints (all NEW, all must satisfy §4 CI)
`/api/logs` (item #8 scatter-gather), `/api/tuning/*` (item #4), `/api/batch/*` (item #5),
reset (item #7), `/api/cases/{id}/forwarding` (item #10), `/api/sources/health`. Non-GET
variants need `require_permission`; public ones (unlikely here) need `PUBLIC_API_PATHS`.

---

## 4. Invariants this domain ENFORCES (and exactly where)

| # | What | Where enforced in this domain |
|---|---|---|
| **#1** | Two physically-separate ES clients (`_ro` all-logs-*, `_mgmt` tlsoc-agent-*) never cross | `es/client.py::RealESClient._ro/_mgmt`; KV stores + own state only ever ride `_mgmt`; `state.es_client_for_source` forces `es_mgmt_api_key=None` on per-source clients. **New KV/tuning/batch stores use the `_mgmt`/StateStore path only; never point `_ro` at own-state indices.** |
| **#3** | Close/escalate = ONLY `case_manager.decide()`, byte-identical | `tests/test_wave6_decide_guard.py` (**4 tests**) greps `decide()`/`apply()` source for exact strings AND asserts `'threshold_automation'`/`'automation'` never appear. Routes' analyst layer (`_perform_case_action`) and any new tuning/batch code must NEVER import `decide()`. |
| **#4** | `cluster_signature` idempotency byte-identical | Attach path via `stores/cases.py::find_open_by_signature` (ES) + `stores/sql/repositories.py:94` (SQL), both keyed on `cluster_signature` over `OPEN_CASE_STATUSES`. Routes/reset never recompute signatures. |
| **#6** | 100% LLM calls through ONE gateway, one `UsageDoc` per result | `llm/gateway.py`; the platform only READS the ledger (budget status, metrics). Batch results keyed by `custom_id` still emit one `UsageDoc` each — the store just persists them. |
| **#9** | All source/operator/AI text fenced/escaped before prompts + in UI | Routes return PLAIN DATA; `notifications/templates.py` escapes (`{{var}}` auto-`html.escape`, `header_safe`/`text_safe` CRLF-strip). New endpoints must not interpolate case/log text into prompts and must keep bodies plain. |
| **authZ CI** | Every state-changer RBAC-gated | `tests/test_route_auth_coverage.py`: every `/api` route auth-covered or in `PUBLIC_API_PATHS`; every non-GET `/api` route carries an authZ dependency (`require_permission.<locals>._dep` / `require_role`/`require_admin`/`require_fresh_auth`). |

### The route-auth-coverage CI in detail (build agents WILL hit this)
`tests/test_route_auth_coverage.py`:
1. Walks every `/api` route; fails if a route is neither under an auth-covering dependency
   nor listed in `PUBLIC_API_PATHS` (line ~87-91).
2. Separately fails if any **non-GET** `/api` route lacks an authZ dep (line ~164) — the
   allowlisted dep names are `require_permission.<locals>._dep`, `require_role.<locals>...`,
   `require_admin`, `require_fresh_auth` (lines 45-49).
3. Pins the `PUBLIC_API_PATHS` contents: `/api/setup/status` + `/api/setup/init-admin` +
   `/api/auth/refresh` MUST be public (400/401/428); `/api/users`, `/api/roles`,
   `/api/auth/change-password` MUST NOT be public.
- **Consequence for Round-4:** a new `POST /api/tuning/rollback` or
  `POST /api/batch/submit` without a `require_permission(...)` gate = red build. Pick the
  resource/action pair (likely `settings`/`manage` for tuning, a new `batch` resource, or
  `cases`/`write`). If you add a new resource, extend the RBAC permission matrix in
  `auth/service.py` so the 6 built-in roles resolve it (auditor stays read-only).

---

## 5. Contracts a refactor MUST preserve (byte-identical or aliased)

- **KV namespace triples are on-disk contract** (`constants.py:44-142`). New Round-4
  stores ADD triples (auto-tune state/rollback, anomaly baseline, batch-job registry,
  reset audit) — never rename existing ones. `USER_PREFS_DEFAULT_BUCKET="default"`,
  `CURSOR_DOC_ID="primary"`, `CONFIG_DOC_ID="preferences"` are frozen.
- **`kv_mutate` mutator purity + `_rev` field**: any new store MUST use `kv_mutate` (or
  reproduce its CAS) and keep `_rev` additive; a mutator that mutates external state
  breaks the retry.
- **SQL parity is implicit** — a new KV store gets SQLite/Postgres for free via `KVRow`.
  Do NOT add a bespoke SQL table/repository for KV-shaped state (that would need a
  migration and break the zero-migration rule).
- **`_ACTION_STATUS` wire keys** (`close/confirm_fp/reopen/escalate/deescalate/hold/
  resume/resolve/acknowledge/set_disposition/set_status`) are the case-action API; the #3
  fix changes only the VALUE of `acknowledge`, not the key set.
- **`PUBLIC_API_PATHS` membership** (setup + refresh public; users/roles/change-password
  NOT) is pinned by tests — reset routes are state-changers and MUST NOT be public.
- **`GET /api/settings` shape** (`{prefs, configured, read_only}`) and `configured` =
  BOOLEANS ONLY (never secret values) — `Secrets.configured_status()`. Reset must keep
  this and must never echo a secret.
- **`Preferences` additive-defaulted**: every new block (`threshold_tuning`, `batch`,
  `caps.max_concurrent`, reset config) defaults OFF/sane so an existing
  `tlsoc-agent-config` doc loads byte-identically. `_migrate_fp_auto_close` +
  `upgrade_feed` legacy readers stay idempotent.
- **`NotificationChannel` SPI** shape (for any new channel) + channel secrets stay in the
  in-memory secret tier (booleans-only surfacing).
- **`decide()`/`apply()` source byte-identical** — `tests/test_wave6_decide_guard.py`
  greps exact strings and asserts `automation`/`threshold_automation` absent. The tuning
  observer (item #4) mirrors `threshold_automation.py`'s discipline but is a SEPARATE
  module and must not touch decide.

---

## 6. Risks / gotchas

- **BIGGEST RISK (this domain): a new Round-4 endpoint that skips `require_permission`
  turns the build red via `tests/test_route_auth_coverage.py`, and a wrongly-public one
  (in `PUBLIC_API_PATHS`) is a real authZ hole.** Every `/api/tuning/*`, `/api/batch/*`,
  `/api/logs`, reset, `/api/cases/{id}/forwarding`, `/api/sources/health` non-GET route
  needs an explicit authZ gate; reset/tuning/batch mutators must NEVER be public. If you
  introduce a new RBAC resource, update the permission matrix in `auth/service.py` or the
  6 built-in roles can't resolve it (403 for everyone incl. super_admin unless mapped).
- **Reset must be secret-safe (item #7):** `Secrets` is the env/.env + in-memory tier and
  is NEVER persisted to the config doc; a reset that rebuilds `Preferences` is fine, but
  do NOT also wipe `connector_secrets`/`notification_secrets`/`sso_client_secrets` (those
  are lost on restart anyway — wiping them mid-session breaks live sources). Per the
  three reset scopes (logs only / sources+logs / full factory→OOBE), preserve `demo`
  (mirror `put_settings`), and for full reset flip `setup_complete=False` rather than
  deleting the config doc.
- **`kv_mutate` never raises → silent write loss on exhausted retries** (logs + returns
  last value). Fine at operator scale; a high-frequency Round-4 writer (batch job status
  churn) should batch mutations, not hammer one doc.
- **Two `Secrets()` objects:** the lifespan one (drives the app) and `main.py:56 _sec`
  (drives middleware toggles only). Don't assume a runtime `apply_secrets` re-toggles
  middleware.
- **Demo isolation via `@property` indirection (state.py:84-122):** any new store the
  pipeline/ingest touches must be reachable through the active-store property or Demo Mode
  silently writes to the real store. New KV stores that are read-only in the pipeline are
  usually safe, but batch/tuning writers must respect the demo gate.
- **`UsageDoc` lacks cache/batch/`custom_id` fields** — item #2/#5/#11 add them; adding
  fields is safe (additive), but the ES mapping + SQL `UsageRow` must accept them and old
  docs must still deserialize (default the new fields).
- **`main.py` mounts all 8 feature routers under the SAME `require_auth`** — a new router
  that forgets the `dependencies=[Depends(require_auth)]` on `include_router` bypasses the
  session gate even if individual routes have `require_permission`. Copy the mount line
  exactly.
- **`_perform_case_action` is shared by the single-case AND bulk endpoints** — the #3
  acknowledge fix automatically applies to bulk; verify the bulk grant resolution
  (`_grant_for_body`) still returns `cases:write` for acknowledge (it does).
- **Cross-domain note:** the auto-tuning observer (item #4) and daily campaign pass (item
  #5) need a scheduler that does NOT exist yet — `StandupConfig.interval_seconds=86400` is
  declared but `main.py` spawns no standup/scheduler task. A new deterministic nightly loop
  lives OUTSIDE the live request path, makes ZERO LLM calls, routes suppression DROPs
  through the existing HITL Proposal queue (`stores/proposals.py` → `POST
  /api/proposals/{id}/approve`, `require_admin`), and persists its state in a NEW KV store
  mirroring `user_prefs.py`.
