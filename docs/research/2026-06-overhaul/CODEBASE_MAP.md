# CODEBASE_MAP — TLSOC Agentic Triage Suite (2026-06 overhaul)

> Consolidated subsystem map for the overhaul. Authoritative file paths are
> absolute. This is the engineering "where things live" reference that every
> feature design in `FEATURE_DESIGN.md` points back to.

---

## 0. The 12 non-negotiables that constrain every change

The ones that bite this overhaul hardest:

- **#1 Read-only scoped ES key.** Two physical clients in `es/client.py`: `_ro`
  (`all-logs-*`) and `_mgmt` (`tlsoc-agent-*`). Connectors never construct creds.
- **#2 Append-only audit** (`tlsoc-agent-audit-*` / `AuditRepository`): `write` /
  `record` only. No update/delete, ever. Audit failure never breaks a case.
- **#3 Deterministic close/escalate.** `engine/case_manager.decide()` is a *pure
  function* of `(verdict, confidence, risk_score, policy)`. The LLM verdict feeds
  the policy; it never bypasses it. A playbook can only RECOMMEND. NEEDS_HUMAN /
  unknown verdict can NEVER be auto-closed — enforced in code (`apply()` raises).
- **#9 UNTRUSTED log data.** Every log-derived value entering a prompt is fenced
  (`UNTRUSTED_OPEN`/`UNTRUSTED_CLOSE`, `agents/prompts.fence()`). The OCSF
  `unmapped`/`raw_data` catch-alls are untrusted too. UI renders such values as
  plain text / code blocks, never markup.
- **#10 Secrets are env/in-memory only.** `Secrets` (`config.py`) is never
  persisted. `connector_secrets[source_id][field]` is the only per-source secret
  store, in-memory. The UI shows boolean `configured ✓`, never values.

---

## 1. Configuration subsystem (the single source of settable state)

```
backend/app/config.py          Secrets (env-only) + Preferences (UI-editable, persisted)
backend/app/stores/config_store.py   ES ConfigRepository (load/save Preferences singleton)
backend/app/stores/sql/repositories.py  SqlConfigStore (KV-backed, namespace='config')
backend/app/state.py           AppState DI hub: update_prefs / apply_secrets / get_prefs
backend/app/api/routes.py      GET/PUT /api/settings (deep-merge + validate + persist)
```

### Secrets (`config.py:41`, env-only, never persisted)
Notable fields: `es_url/es_ca_cert/es_verify_certs`, `es_api_key` (read-only logs),
`es_mgmt_api_key` (tlsoc-agent-*), `openai_api_key`, `anthropic_api_key`,
`abuseipdb_api_key`, `virustotal_api_key`, `embedding_api_key`, `redis_url`,
`auth_enabled`, `auth_jwt_secret`, `auth_token_hours`, `auth_admin_username`,
`auth_admin_password` (plaintext env, hashed at startup), `auth_users` (username→hash),
`auth_cookie_secure`, `security_headers_enabled`, `csrf_enabled`, `rate_limit_enabled`,
`state_backend`, `state_db_url`, `connector_secrets` (per-source secret tier).
Helpers: `source_secrets(id)`, `set_source_secret(id, field, value)`,
`provider_key(provider)`, `embedding_key()`, `auth_user_map()`, `configured_status()`.

### Preferences (`config.py:624`, single persisted doc, sane defaults)
50+ fields across: `sources[]` (SourceInstance list), data scope (`data_view_pattern`,
`time_field`), entity mapping (`source_ip_field`/`user_field`/`host_field`/`message_field`,
`entity_strategy`), rule identity, polling, per-role `ModelConfig`s, `auto_close`
(AutoClosePolicy), `escalation_confidence`, `critical_severity`, `rule_catalog`,
`correlation_rules`, `risk_weights`, `asset_networks`, `caps`, `suppression_rules`,
`enrichment`, `rag`, `standup`, `trace`, `personas`, `runbooks`, `playbooks`,
`branding`, `setup_complete`, `read_only_settings_mode`.

Key methods: `correlation_for(rule)`, `entity_strategy_for(source)`,
`primary_source()`, `match_rule(src)`, `model_for(role)`, `model_for_rule(role,rule)`,
`maybe_seed_rule_catalog()`.

Back-compat pattern: `@model_validator(mode="before") _migrate_fp_auto_close`
(maps deprecated `fp_auto_close` → `auto_close.false_positive`). **This is the
template for every additive migration** (see STATUS_TAXONOMY.md).

### How settings flow (memorize)
`PUT /api/settings` → `_deep_update(current_dump, body)` → `Preferences.model_validate`
→ `state.update_prefs(prefs)` → `config_store.save()` + cache refresh. **Additive
nested fields auto-round-trip** because the body is deep-merged and validated whole.
`read_only_settings_mode` rejects PUT (403) unless the body unlocks it.

---

## 2. Models & data contracts

```
backend/app/models.py     Case, AuditDoc, UsageDoc, Cursor, RawEvent, Cluster,
                          Proposal, MemoryEntry, VerdictResult, FeedbackEntry,
                          CaseComment, Entity, TriggerReason, RiskBreakdown
backend/app/constants.py  All enums + index names + OCSF + UNTRUSTED fences
```

**Case** (`models.py:356`): `case_id`, `cluster_signature`, `created_at`,
`updated_at`, `source_surface`, `origin_surface`, `rule_ids[]`, `entity`,
`source_id`, `source_name`, `member_event_ids[]`, `risk_score`, `verdict`
(Verdict|None), `confidence`, `evidence[]`, `mitre[]`, `recommended_action`,
`reproduce_query`, `status` (CaseStatus), `decision_by`,
`objection_window_expires_at`, `agent_persona`, `playbook_id`, `feedback[]`,
`tags[]`, `comments[]`, `assignee`, `title`, `summary`, `risk_breakdown`,
`token_cost`, `error`, `history[]`, `verdict_history[]`, `trigger_reason`.

**Enums** (`constants.py`):
- `Verdict`: FALSE_POSITIVE | TRUE_POSITIVE | NEEDS_HUMAN
- `CaseStatus`: OPEN | NEEDS_HUMAN | CLOSED  ← **target of taxonomy overhaul (F8)**
- `DecisionBy`: AGENT | ANALYST | SYSTEM
- `ActionType`: PROMPT, ES_QUERY, TOOL_CALL, VERDICT, DECISION, ERROR, POLL, SCAN,
  FEEDBACK, COLLAB, CONTEXT, PROPOSAL
- `EntityType`: IP | USER | HOST | RULE
- `EntityStrategy`: AUTO | IP | HOST | USER | RULE
- `IndexRole`: EVENTS | ALERTS
- `ToolTier`: SAFE | MANAGED | REQUIRES_APPROVAL | FORBIDDEN
- `SourceType` (30+), `IngestMode`, `CursorKind`, `UsageOutcome`, `TriageBucket`

---

## 3. Authentication & authorization (current state)

```
backend/app/auth/passwords.py   PBKDF2-SHA256 (200k iters, salted), stdlib only
backend/app/auth/tokens.py      HS256 JWT encode/decode (stdlib), TokenError
backend/app/auth/service.py     AuthService + AuthUser(dataclass, username only)
backend/app/middleware/         security_headers · rate_limit · csrf
backend/app/api/deps.py         require_auth (gate) · current_username · require_admin
backend/app/api/routes.py:921   POST /auth/login · GET /auth/me · POST /auth/logout
```

- **AuthUser** today carries only `username`. **No role/mfa/session fields.**
- **`require_auth`** (deps.py:42): no-op when `auth.is_enabled` is False (the
  default). When enabled, every `/api` route requires a JWT EXCEPT
  `PUBLIC_API_PATHS` (`/api/health`, `/api/auth/{login,logout,me}`) +
  `PUBLIC_GET_PATHS` (`GET /api/branding`) + the ingest-receiver regex.
  **Deny-by-default** — a CI test (`test_route_auth_coverage`) verifies no `/api`
  route bypasses the gate.
- **`require_admin`** (deps.py:80): **the single RBAC seam.** Today DEFAULT-ALLOW
  once authenticated (`role` placeholder). The `# TODO(RBAC)` marks the exact
  one-line flip. **F2 (RBAC) lands here.**
- JWT claims today: `{sub: username, iat, exp}`. Stateless — logout just clears
  the cookie; no server-side revocation.

---

## 4. Correlation, risk, entity clustering

```
backend/app/engine/correlation.py  resolve_entity (fallback ladder) · correlate
                                    · cluster_from_events · _build_cluster
backend/app/engine/signatures.py   cluster_signature(entity_type, value) — entity-centric
backend/app/engine/risk.py         compute_risk(cluster, prefs, reputation) → RiskBreakdown
backend/app/engine/ingest.py       handle_clusters · attach_cluster · IngestService
                                    (live-tail ring buffer, push receivers)
backend/app/engine/poller.py       durable-cursor polling driver (PULL sources)
```

- **Signature is entity-centric** (`hash(entity_type, value)`) — new rules attach
  to an existing open case (non-negotiable #4). NOT rule-centric.
- **Entity fallback ladder** (immutable per strategy): AUTO → IP→HOST→USER→RULE.
  An event missing every entity falls to a RULE bucket (rule name + 5-min bucket),
  never silently dropped (the NO-SOURCE-IP fix).
- **`is_alert`** clusters (any member from an `alerts`-role IndexPattern)
  AUTO-FORWARD, bypassing `auto_forward_allowlist`. `events`-role clusters respect
  the allowlist. **This is the per-source / per-sub-source gating seam for F6.**
- `RawEvent.source_id`/`source_name` already flow through to `Cluster` and `Case`.
- `compute_risk` is pure + synchronous (reputation passed in, no tool call).

---

## 5. Connectors + ingestion (vendor-agnostic)

```
backend/app/connectors/base.py        Connector/PullConnector/PushReceiver SPI ·
                                       AuthField · ConnectorManifest · ConnectionTest ·
                                       StructuredQuery · QueryRendering · SearchResult
backend/app/connectors/registry.py    discovery (built-ins + tlsoc.connectors entry pts)
backend/app/connectors/elastic.py     exemplar PullConnector (field-mapping overlay,
                                       per-pattern role, read-only test_connection)
backend/app/connectors/receivers/     16 push receivers (webhook/syslog/queues/object)
                                       common.py · formats.py · webhook.py · syslog.py ·
                                       queues.py · objectstore.py
backend/app/ocsf/                     OCSFEvent · ecs→OCSF · generic_to_ocsf
```

- **ConnectorManifest** (a `@classmethod`, credential-free) drives wizard
  discovery: `auth_fields[]`, `config_fields[]` (each an `AuthField` with `key`,
  `label`, `type`, `required`, `secret`, `default`, `options`, `help`,
  `placeholder`, `group`). **F9 (per-connector help) extends `AuthField`.**
- `SourceInstance` (`config.py:556`): `id`, `source_type`, `display_name`,
  `enabled`, `ingest_mode`, `is_primary`, `config` (non-secret dict),
  `configured_secrets` (field NAMES only). `index_patterns()`, `entity_strategy()`.
- Per-source overrides live in `SourceInstance.config` (free-form dict): field
  mapping, TLS, index patterns, entity strategy. **F6 & F9 use this.**
- `IngestService._recent[source_id]` = `deque(maxlen=500)` live-tail buffer.

---

## 6. Agents subsystem (investigation pipeline)

```
backend/app/agents/router.py        cheap triage → TriageBucket
backend/app/agents/investigator.py  ReAct loop, ToolTier gate, persona/playbook/memory
backend/app/agents/personas.py      AgentPersona registry + deterministic select_persona
backend/app/agents/formatter.py     presentation-only verdict shaping
backend/app/agents/overview.py      single-event AI overview
backend/app/agents/proposer.py      HITL suppression proposal drafter (anti-poisoning)
backend/app/agents/prompts.py       fence() · render_memory · render_cluster · systems
backend/app/agents/graph.py         LangGraph orchestration
backend/app/agents/pipeline.py      cluster → enrich → risk → persona/playbook/memory
                                    → (triage|investigate) → CaseManager.apply → persist
```

- Pipeline calls `CaseManager(prefs).apply(case)` AFTER verdict assembly, BEFORE
  `case.save()`. **This is where threshold automation (F10) and notifications (F5)
  hook in — AFTER `decide()`, never inside it.**
- Playbook selected deterministically (`registry.select_playbook(cluster)`),
  injected as a `<<<PLAYBOOK>>>` TRUSTED block. Recommend-only.
- Memory injected as `<<<MEMORY>>>` TRUSTED block. Never overrides `decide()`.

---

## 7. Case Manager + playbook engine (the deterministic core, #3)

```
backend/app/engine/case_manager.py  decide() pure fn + CaseManager.apply()
backend/app/playbooks/manifest.py   PlaybookManifest + PlaybookMatch (ANY-OF semantics)
backend/app/playbooks/loader.py     parse_playbook (never raises) · load_playbooks
backend/app/playbooks/registry.py   select_playbook (deterministic) · atomic hot-reload
backend/playbooks/*.md              operator-authored playbooks (data, not code)
```

- `decide(verdict, confidence, risk_score, policy, *, escalation_confidence,
  critical_severity) → Decision(status, decision_by, objection_window, escalate,
  rationale)`. Pure. `apply()` asserts NEEDS_HUMAN/None never closes.
- `PlaybookMatch`: present criteria constrain (intersection), absent don't.
  `escalate_if` / `suggested_verdict_bias` are advisory TEXT — they never change
  the policy.

---

## 8. StateStore abstraction + repositories (backend-agnostic)

```
backend/app/stores/base.py          CaseRepository · AuditRepository · UsageRepository
                                    · KVStore · ConfigRepository · CursorRepository (ABCs)
backend/app/stores/cases.py         ES CaseStore (find_open_by_signature, list, scans)
backend/app/stores/config_store.py  ES ConfigStore (seed_rule_catalog idempotent)
backend/app/stores/cursor_store.py  ES CursorStore (durable poll cursor)
backend/app/stores/memory.py        MemoryStore over KVStore (EsKVStore/SqlKVStore)
backend/app/stores/proposals.py     ProposalStore over KVStore (HITL)
backend/app/stores/usage.py         ES UsageStore (cost ledger, append-only)
backend/app/audit/audit_log.py      ES AuditLogger (append-only)
backend/app/stores/sql/            engine.py · models.py (ORM) · repositories.py ·
                                    vectorstore.py (SQLite/Postgres+pgvector)
backend/app/state.py                _build_state_backend() wires per STATE_BACKEND
```

- To add a persisted collection: define ABC in `base.py`, ES impl in
  `stores/<entity>.py`, SQL impl + ORM row in `stores/sql/`, wire in
  `state._build_state_backend()`. SQL stores rich Pydantic JSON in a `doc` column
  with materialized+indexed filter/sort columns.
- **KV-singleton pattern** (Memory/Proposals): read-modify-write a single JSON
  list under a `(namespace, key)`. NO new index/table/migration. **F1 multi-user,
  F8 status, F11 threat-context can reuse this for low-volume collections; F2
  users need a real indexed repository.**

---

## 9. LLM gateway, cost ledger, RAG, enrichment

```
backend/app/llm/gateway.py    THE single choke point (#6); _record() = only ledger write
backend/app/llm/pricing.py    PRICES table + pricing_source(model) provenance
backend/app/tools/rag.py      RagService (hybrid BM25+vector; import/list/delete/stats;
                              index_resolved_cases → institutional memory)
backend/app/tools/enrich.py   enrich_ip (AbuseIPDB/VT, Redis-cached, best-effort)
backend/app/tools/base.py     Tool SPI + ToolRegistry + ToolTier
backend/app/tools/vectorstore.py  VectorStore ABC (InMemory + ES dense_vector)
backend/app/engine/metrics.py compute_metrics (pure aggregation over cases)
backend/app/agents/standup.py aggregate-then-summarise (#7)
```

- **F11 (threat context + reusable knowledge)** rides the RAG corpus: new seed
  source `threat_context`/`resolved_case`, injected as a TRUSTED block.
- **F5 (notifications)** must thread `case_id`/`surface` if it ever calls the LLM
  (it won't for SMTP), and audit sends via a new `ActionType`.

---

## 10. Frontend (webui — primary surface)

```
webui/src/soc/App.tsx          Boot: auth gate (me) → wizard | shell; ErrorBoundary
webui/src/soc/AppShell.tsx     icon rail nav (3 groups), top bar, command palette, health
webui/src/soc/router.tsx       hash router (#/{pageid}); Navigate/NavOpts
webui/src/soc/theme.tsx        dark/.dark toggle, branding accent → CSS vars, Toaster
webui/src/soc/nav.ts           PageId union · NAV_GROUPS (triage/automation/platform)
webui/src/soc/pages/           Overview · Cases · Investigate · Chat · Metrics · Scans
                               · Standup · Catalog · Approvals · Knowledge · Memory
                               · Sources · Cost · Settings · Login
webui/src/soc/components/      PageHeader · KpiTile · BarList · StatCard · RiskGauge ·
                               charts.tsx · DataTable · EmptyState · CodeBlock · Stagger
                               · SourceEditor · SourceLogsSheet · ConnectorPicker ·
                               ChatPanel · badges.tsx · palette.ts
webui/src/lib/api.ts           typed fetch client (all routes) + setUnauthorizedHandler
webui/src/lib/types.ts         TS mirrors of every backend contract (additive-compatible)
webui/src/styles/theme.css     design tokens (CSS vars) — single source of color truth
webui/tailwind.config.js       darkMode class + token references
```

- **Nav model** is a constant (`nav.ts:NAV_GROUPS`). RBAC visibility (F2) filters
  it in `AppShell` from `useAuth().role`. Server enforces regardless.
- **Theme** overrides `--primary`/`--ring` from `branding.accent_color` at runtime;
  every component uses semantic Tailwind classes (`bg-primary`), never hex.
- **`api.ts`** has `setUnauthorizedHandler` (401 → bounce to login). All contract
  types keep `[key: string]: unknown` for forward-compat.

### Known UI defect for F13 (RiskGauge / Active-Risk-Index)
`webui/src/soc/components/RiskGauge.tsx` is INTENTIONALLY needle-less: a muted
semicircular track + a severity-colored progress arc (180°→0°). The "glitch" is
diagnosed in the design map as: at small `size` (<140px) `stroke = round(size*0.07)`
becomes too thick relative to the radius, so the arc visually overlaps/clips and
reads as broken. The Overview "Active Risk Index" uses this gauge with a derived
`riskIndex = avg_risk*0.7 + criticalDensity*100*0.3`. **Fix: clamp stroke for
small gauges (`min(10, round(size*0.05))`) or enforce a min size of 140px; verify
the arc path math + center-text offset (`cy - r*0.52`).**

---

## 11. Backend route inventory (the API contract)

`backend/app/api/routes.py` (prefix `/api`), all auth-gated except the allowlist:

- Setup: `GET /setup/status`, `POST /setup/secrets`, `POST /setup/complete`
- Connectors/Sources: `GET /connectors`, `GET /connectors/{type}`,
  `POST /connectors/test`, `GET/POST /sources`, `DELETE /sources/{id}`,
  `POST /sources/{id}/secrets`, `GET /sources/{id}/logs`, `POST /ingest/{id}`
- Settings/Branding: `GET/PUT /settings`, `GET/PUT /branding` (GET public)
- Chat/Investigate/Overview: `POST /chat`, `POST /investigate`, `POST /overview`
- Cases: `GET /cases`, `GET /cases/{id}`, `POST /cases/{id}/action`,
  `.../feedback`, `.../comment`, `.../tags`, `.../assign`, `.../export`,
  `.../investigate`, `.../reinvestigate`, `.../trace`, `.../rationale`
- Knowledge/Memory/Proposals: `GET /rag/*`, `GET/POST/PUT/DELETE /memory`,
  `GET /proposals`, `POST /proposals/{id}/approve|reject` (require_admin seam)
- Personas/Playbooks/Runbooks/Metrics: `GET /personas`, `GET /playbooks`,
  `POST /playbooks/reload`, `GET /playbooks/selection/{id}`, `GET /metrics`,
  `GET /feedback/stats`
- Scans/Standup/Usage/Poll/Models: `GET /scans`, `GET /scans/notifications`,
  `GET /standup`, `GET /usage/summary`, `POST /poll`, `GET /models`
- Auth: `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`

Adding a route: define request/response Pydantic in `routes.py`, register handler,
gate writes with `require_admin` (or a new `require_role`), add to
`PUBLIC_API_PATHS` ONLY if it must be public, audit all writes.
