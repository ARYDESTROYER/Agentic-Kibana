# BACKEND_MAP — TLSOC Agentic Triage Suite (Round 5 / P1 understanding)

> **Scope.** A thorough, citation-backed map of the *backend* surfaces the Round-5 UI/UX
> overhaul must sit on: config/Preferences (esp. the rule knobs), the Pydantic data
> contracts, the API surface, the engine (rules / correlation / risk / tuner / automation /
> case_manager / cost / metrics / poller / baseline / campaigns), the stores (incl. the
> **zero-migration KV pattern**), the LLM gateway/pricing/batch, and the connector SPI.
> This is **READ-ONLY mapping** — no files were edited. All `file:line` citations below were
> reported by the mapping agents against the tree at **2026-07-01**.
>
> **The overhaul goals this map serves:** G1 cohesive light+dark color scheme · G2 one
> shadcn/Radix/Tailwind design standard · G3 declutter the 2673-line `Settings.tsx` /
> reduce nested submenus · G4 dashboard real-estate · G5 compact posture hero · **G6 real
> rule customizability (detection/correlation/risk/auto-close/tuning)** · **G7 user-created
> custom dashboards** · G8 loose coupling · G9 fully tested.
>
> **⛔ HARD CONSTRAINT (carried on every section below):** `engine/case_manager.py`
> `decide()` MUST stay **byte-identical** (non-negotiable #3). The overhaul reads/writes the
> *policy data* `decide()` consumes; it never touches the function. Also load-bearing:
> **#6** exactly-one cost-ledger write per LLM call, **#9** log-derived values are UNTRUSTED
> (fenced/escaped/bounded plain text), **#2** append-only audit, **#4** no-skip/no-dup
> cursor + one open case per cluster signature, **#10** secrets are env/in-memory only (UI
> sees `configured: bool`, never values).

---

## 0. TL;DR — the ten findings that matter most for the overhaul

| # | Finding | Where | Goal | Severity |
|---|---------|-------|------|----------|
| 1 | **The UI edits the DEPRECATED auto-close field.** `Settings.tsx:1094` binds to `prefs.fp_auto_close` (deprecated `FpAutoCloseConfig`), NOT the live `auto_close` `AutoClosePolicy` that `decide()` enforces. TRUE_POSITIVE opt-in + per-class thresholds have **zero UI**. | `config.py:483/511/1890/1891`; `Settings.tsx:1094` | G6 | **HIGH** |
| 2 | **No detection-rule editor exists.** `rule_catalog: list[RuleDefinition]` (18 seeded rules, rich `RuleMatch` field/op/value + per-rule correlation + model override) appears **0 times** in `webui/src`. | `config.py:438/1899/2154` | G6 | **HIGH** |
| 3 | **Per-rule correlation, risk asset-criticality, SLA/priority, suppression CRUD all lack UI.** Editable only via the monolithic `PUT /api/settings` deep-merge blob. | `config.py:1032/1055/1909/1917/1920/1924` | G6 | **HIGH** |
| 4 | **A dead schema pipeline blocks generic Settings.** `GET /api/settings/schema` + `settings_schema.py` (220 LOC) build a full section descriptor with **zero webui consumers**; `Settings.tsx` hand-codes every field. And the schema **cannot describe** the list/dict rule collections (they fall into a junk `general` bucket). | `settings_schema.py:85-219`; `routes.py:808` | G3/G6 | **HIGH** |
| 5 | **G7 (custom dashboards) is greenfield — nothing exists.** No `DashboardConfig`/widget model, no store, no route, no widget registry anywhere in the backend. The **KV pattern is the ready-made template** (see §6). | (absent) | G7 | **HIGH** |
| 6 | **Rule vocabulary is fragmented across TWO files + THREE shapes.** `RuleDefinition`/`RuleMatch`/`CorrelationRule` (config.py, live) vs `CaseAutomationRule` (config.py, post-decision) vs `DetectionRule` (models.py:964, **inert dead carrier**). No canonical shape. | `config.py:390/399/438/957`; `models.py:964` | G6 | MED |
| 7 | **`routes.py` is a 4751-line monolith** mixing prefs/auth/MFA/SSO/sessions/account/RBAC/cases/search/audit; 124 endpoints, 58 in the first 1600 lines. Per-feature routers exist (14 mounted) but the legacy core was never split. | `routes.py` (whole); `main.py:83-99` | G8 | MED |
| 8 | **Auto-close needs_human is inert but renderable.** `_entry_for` returns `None` for NEEDS_HUMAN; the config field exists but can never take effect. A generic form would show a no-op toggle. Code-enforced off (assert at `case_manager.py:143`). | `case_manager.py:51-56/143`; `config.py:530` | G6/#3 | MED |
| 9 | **Only threshold-tuning has a typed config endpoint** (`GET/PUT /tuning/config`). Its 3 Round-4 siblings (baseline/campaign/batch) are **read-only status views**; their config rides the generic settings PUT. Inconsistent treatment of the 4 Round-4 rule blocks. | `routes_tuning.py:193-202`; `routes_baseline/campaigns/batch.py` | G6 | MED |
| 10 | **The connector SPI is the loose-coupling exemplar to copy** (manifest + `AuthField` schema-driven form + entry-point registry). It is the ready-made pattern for a schema-driven **rules** editor (G6). But the same weak-typing (free-string `type`/`category`) is the gap to close. | `connectors/base.py:38-89`; `registry.py` | G6/G8 | (opportunity) |

---

## 1. Config / Preferences — the rule-knob data layer

`backend/app/config.py` defines **two strictly-separated tiers**:

- **`Secrets`** (`config.py:48`, `BaseSettings`, env/`.env` only) — ES keys, LLM keys, 20+
  enrichment keys, SSO/MFA/notification secrets, per-source `connector_secrets`. **Never
  persisted, never returned.** The UI only ever sees a `configured: bool` via
  `configured_status()` (`config.py:316`) + `notification_configured_status()` (`config.py:284`).
- **`Preferences`** (`config.py:1791`, `BaseModel`) — the **UI-editable working config**,
  persisted as **one document** at `CONFIG_DOC_ID` in `tlsoc-agent-config` (or the SQL/KV
  equivalent). ~40–45 top-level fields + ~40 nested models. Fully back-compat via
  before-validators + lazy migrations; drift-tolerant load (Pydantic ignores unknown keys,
  fills defaults). **This is the single source of truth for every rule knob the product exposes.**

### 1a. The rule / policy models (G6 targets)

| Model | Where | Wired at (Preferences) | UI editor today? |
|-------|-------|------------------------|------------------|
| `RuleDefinition` {name, enabled, match, correlation?, model_override, priority} | `config.py:438` | `rule_catalog` `config.py:1899` | **NONE** (0 refs in webui) |
| `RuleMatch` {field, op∈`equals\|prefix\|tag\|exists`, value} | `config.py:399` | (inside `RuleDefinition`) | **NONE** |
| `CorrelationRule` {mode:`CorrelationMode`, n≥1, window_seconds≥1, group_by:`EntityType`} | `config.py:390` | `default_correlation` `config.py:1908` + `correlation_rules: dict` `config.py:1909` | **only** default `n` + `window_seconds` (`Settings.tsx:927-928`); **mode / group_by / per-rule never editable** |
| `RiskWeights` {volume, velocity, reputation, diversity, asset_criticality} | `config.py:459` | `risk_weights` `config.py:1916` | bespoke hardcoded 5-slider block (`Settings.tsx:939`), not schema-driven, **unbounded floats — no `ge/le` validation** |
| `AutoClosePolicy` → `VerdictAutoClose` {enabled, min_confidence 0-1, max_risk_score 0-100, objection_window_minutes} per {false_positive, true_positive, needs_human} | `config.py:496/511` | `auto_close` `config.py:1891` | **NONE** — UI edits the deprecated `fp_auto_close` instead (see §0 #1) |
| `FpAutoCloseConfig` **(DEPRECATED)** | `config.py:483` | `fp_auto_close` `config.py:1890` | **YES** (the only auto-close UI, `Settings.tsx:1094`) |
| `SuppressionRule` {field, value, reason, confidence, rationale, source_case_ids, created_by, expires_at, enabled} + `is_live()` | `config.py:1189/1211` | `suppression_rules` `config.py:1924` | **NONE** — only a RAG-retrieval toggle `rag.use_suppression_rules` (`Settings.tsx:1308`); materialised **only** via proposal-approve (`routes.py:1252-1273`) |
| `ThresholdTuningConfig` {enabled, min_samples=25, max_n_step=1, fp_rate_target=0.30, wilson_z, ewma_alpha, cadence, shadow_eval} | `config.py:1123` | `threshold_tuning` `config.py:1995` | **YES** (`Tuning.api.ts` `PUT /tuning/config`) — but only 5 of 8 knobs surfaced |
| `BaselineConfig` {enabled, half_life_days, warmup_multiplier, modified_z_threshold, tdigest_compression, seasonality} | `config.py:1161` | `baseline` `config.py:1997` | **read-only** page (no config editor) |
| `CampaignConfig` {enabled, cadence} | `config.py:1178` | `campaign` `config.py:1998` | **read-only** page (no config editor) |
| `BatchConfig` | `config.py:1145` | `batch` `config.py:1996` | **read-only** status view |
| `CaseAutomationRule` (alias `AutomationRule` `config.py:1005`) {id, enabled, priority, conditions:dict, action:Literal[tag\|recommend\|notify\|run_playbook\|request_approval], payload:dict} | `config.py:957` | `threshold_automation` (`ThresholdAutomationConfig.rules`) `config.py:989/1945` | **YES** (`AutomationRuleEditor`, `Settings.tsx:1470`) |
| `SlaPolicy`/`SlaTarget` (per-P1..P4 response/resolve minutes, business_hours_only, timezone) | `config.py:1032/1023` | `sla` `config.py:1985` | **NONE** — surfaced read-only in Standup/Metrics |
| `PriorityMatrix` (ITIL impact×urgency grid + bands + default_priority) | `config.py:1055` | `priority_matrix` `config.py:1986` | **NONE** |
| `BudgetConfig` {daily_usd, monthly_usd, on_exceed} | `config.py:1075` | `budget` `config.py:1987` | **YES** (`PUT /budget`) |
| `CapsConfig` {max_tool_calls, max_tokens, timeout_seconds, kill_switch, max_concurrent} | `config.py:470` | `caps` `config.py:1923` | partial — editor omits `max_concurrent` (`Settings.tsx:1209-1211`) |
| `AssetNetwork` {cidr, criticality} | `config.py:1230` | `asset_networks` `config.py:1920` | **NONE** |
| `asset_criticality: dict[str,float]` (exact entity→score map) | — | `config.py:1917` | **NONE** (name appears only as a RiskWeights slider label) |
| `in_scope_rules` / `excluded_rules` (scoping lists) | — | `config.py:1852-1853` | **NONE** |
| `CrossSourceCorrelationConfig` {entity_keys, min_sources, time_window} | `config.py:1238` | `cross_source_correlation` `config.py:1913` | partial (`Settings.tsx:988`); `CorrelationRule.mode` never editable |
| `rule_model_override` (per-rule LLM routing) | — | `config.py:1905` | **NONE** |
| `BrandingConfig` (org/product name, logo/favicon data-URL, accent colors, material, theme_tokens, presets, login white-label) | `config.py:641` | `branding` `config.py:1949` | **YES** (`BrandingEditor`, admin PUT) |
| `CustomizationConfig` {terminology, default_saved_views, default_pinned_view_ids, default_theme} | `config.py:590` | `customization` `config.py:1955` | **YES** (org prefs) |

### 1b. The rule-resolver accessors (live ON Preferences — reuse, don't re-implement)

`Preferences` carries the precedence/resolution logic the engine consumes. **A G6 rule
editor must write to the layer these read, or edits silently no-op:**

- `match_rule(src)` `config.py:2042` — resolves the winning `RuleDefinition` (sorts **ascending** priority; ModSec `priority=50 < generic priority=100` so sub-rules win).
- `correlation_for(rule_value)` `config.py:2004` — keyed by raw **rule VALUE** string.
- `correlation_for_def(rd)` `config.py:2059` — precedence `rd.correlation → correlation_rules[rd.name] → default` — keyed by `RuleDefinition.**name**`. ⚠ **Two different keying schemes** (value vs name) for "per-rule correlation" — reconcile in any editor.
- `model_for` / `model_for_rule`, `entity_strategy_for(source)` `config.py:2008`, `maybe_seed_rule_catalog()` `config.py:2083`, `default_rule_catalog()` `config.py:2154` (13 `event.module` rules + 5 ModSec CRS-prefix sub-rules, `config.py:2126-2176`), `primary_source`.

### 1c. Persistence & surfacing

- **`ConfigStore.save()`** (`stores/config_store.py:38`) is a **FULL-document replace** with
  `refresh=True`. `load()` is drift-tolerant. `seed_rule_catalog()` is idempotent +
  version-guarded (`RULE_CATALOG_SEED_VERSION`, seeding **skipped when non-empty** — an
  editor must not clobber operator catalogs).
- **`GET /api/settings`** (`routes.py:799`) returns the **whole** `prefs.model_dump()` +
  `configured` + `read_only`. **`PUT /api/settings`** (`routes.py:820`, `settings:manage`)
  `_deep_update`s the posted partial into a full `model_dump`, **force-preserves the `demo`
  block** (`routes.py:830-831`), re-validates the **entire** `Preferences` (`routes.py:833`),
  restarts the poller. `GET /api/settings/{section}` (`routes.py:864`) exists but there is
  **no matching PUT** — no section-scoped write.
- **`settings_schema()`** (`settings_schema.py:168`) reflects `Preferences` into
  `{sections:[{key,title,kind,fields:[{name,type,default,required,choices,description}]}]}`;
  `_SECTION_TITLES` (`settings_schema.py:44`) humanises names. `fp_auto_close` still gets
  its own "Auto-Close (legacy)" section (`settings_schema.py:57`).

### 1d. Config-layer issues & constraints

- **Single monolithic aggregate** → any UI section save round-trips the **entire** blob;
  there is **no per-section persistence boundary at the data layer**. Splitting Settings
  *pages* does NOT decouple the underlying model. A partial/optimistic save that drops
  unknown fields would **wipe** blocks the current UI doesn't render (baseline/campaign/sla/
  priority_matrix/rule_catalog) — PUT must **merge, not replace**.
- **Back-compat shims that are load-bearing** (preserve exactly): `_migrate_fp_auto_close`
  before-validator (`config.py:1794`), `AutomationRule = CaseAutomationRule` alias
  (`config.py:1005`), `IndexPattern`/`Feed` legacy acceptance (bare string + `auto_correlate→correlate`,
  `config.py:1346/1394`), `upgrade_feed`/`effective_auto_investigate` (`config.py:1376/1397`),
  wire key `threshold_automation` unchanged.
- **Deliberate lazy imports** (avoid config↔engine/auth cycles): `CaseIdFormatConfig._check_template`
  imports `.engine.case_id.validate_template` (`config.py:568`); `Secrets.auth_user_map`
  imports `.auth.passwords.hash_password` (`config.py:309`); `RBACConfig.custom_roles` kept
  as loose dicts NOT typed `CustomRole` (`config.py:1586`) "to avoid a config↔models cycle."
- **Branding validators are SECURITY controls (#9), not cosmetic** — must survive any
  editor overhaul: `_check_logo` SVG-reject + magic-byte sniff png/jpeg/webp/gif ≤1.4MB
  (`config.py:738`), `_check_accent` `#RRGGBB` regex (`config.py:782`), `_check_theme_tokens`
  ≤200 keys/≤200 chars (`config.py:720`), and all `login_*` validators **reject any `<`** +
  bounded length + curated illustration allowlist (`config.py:809-852`, `_LOGIN_ILLUSTRATIONS`
  `config.py:705`). `GET /api/branding` is **public/pre-auth** — never add a secret-derived
  field to `BrandingConfig`.
- **Docstring drift:** the class docstring (`config.py:5-11`) still says prefs are returned
  "to the plugin" and stored in "the tlsoc-agent-config index" — the plugin is archived and
  the state backend is now selectable (ES|Postgres|SQLite).

---

## 2. Models — the Pydantic data contracts

`backend/app/models.py` holds the **persisted domain contracts** + in-flight pipeline types.
Crucially, **the user-editable rule/policy models live in `config.py`, NOT `models.py`**
(§1a); `models.py` carries only their runtime siblings.

### 2a. Key contracts

- **`Case`** (`models.py:999`) — the central persisted contract, a **~90-field GOD OBJECT**
  spanning identity / verdict / lifecycle (`status`/`disposition`/`status_history`/
  `escalation_level`) / collaboration (`tags`/`comments`/`assignee`/`feedback`) / Round-3
  advisory triage (`severity_band`/`impact_band`/`urgency_band`/`priority_level`/
  `severity_source` + `detected_at`/`acknowledged_at`/`first_response_at`) / Round-4
  provenance (`campaign_id`/`detection_source`) / cross-source (`related_case_ids`/
  `cross_source_cluster_id`/`source_breakdown`) / `automation_actions` / `knowledge_used` /
  `verdict_history` / `notifications_sent`. **`decide()`-relevant inputs are ONLY
  `verdict`/`confidence`/`risk_score`.** Any Case-consuming UI component couples to this
  whole surface.
- **`RawEvent`** (`models.py:49`) with `from_hit(hit, prefs)` (legacy ECS path) +
  `from_ocsf` (push path) + `entity_value`/`cross_source_value`. `from_hit` is **coupled to
  the full `Preferences` field set** (reads `time_field`/`rule_field`/…/`rule_catalog`/
  `match_rule`) — a `Preferences` restructure ripples here.
- **`Cluster`** (`models.py:248`) — correlation output; `window_seconds` computed property
  (`models.py:290`) feeds risk velocity.
- **`Cursor`** (`models.py:1197`) — `>=` timestamp + `boundary_ids` dedup + `should_skip` =
  the #4 no-skip/no-dup backbone (co-located; don't touch during UI work).
- **`SavedView`** (`models.py:601`) {id,name,scope,owner,shared,filters:dict,sort,columns} +
  **`ColumnState`** (`models.py:622`) + **`UserPrefs`** (`models.py:633`) {saved_views,
  tables, theme_mode, last_list_state, pinned_view_ids, misc} — the per-user customization
  contracts and **the closest existing analogue for a future custom-dashboard model (G7)**.
- **`DetectionRule`** (`models.py:964`) {id,name,enabled,source,match:dict,trigger:dict,
  priority,tags} — an explicit "migrate-on-read seam" that references the config halves as
  **loose dicts** and is documented as **NOT wired** ("correlation is NOT rewired to consume
  it this wave"). **Inert dead carrier.**
- **`Proposal`** (`models.py:433/448`) — kind is `Literal[suppression|memory]` **only** (see §4 for how this breaks `request_approval`).
- Collaboration/advisory scaffolding: `CaseMessage`/`CaseActivity` (`models.py:712/724`),
  `CaseTask` (`models.py:749`), `InAppNotification` (`models.py:762`), `Campaign`/
  `CampaignEntity` (`models.py:871/860`), `BaselineState` (`models.py:899`), `Observable`/
  `Entity`/`ProviderResult`/`ThreatContextPanel` (`models.py:674/41/690/341`).

### 2b. Type-safety & shape issues

- **Stringly-typed enum fields** (enum-in-a-comment, no `Literal`): `Case.severity_source`
  (`models.py:1072`), `impact_band`/`urgency_band`/`priority_level` (`models.py:1073-1075`),
  `detection_source` (`models.py:1091`), `RawEvent.index_role` (`models.py:72`),
  `CampaignEntity.entity_type` (`models.py:867`), `Observable.type` (`models.py:674`),
  `ProviderResult.indicator_kind` (`models.py:690`), `CaseMessage.author_type`
  (`models.py:712`), `InAppNotification.category` (`models.py:762`), `CaseTask.status`
  (`models.py:749`). **A UI form/select has no authoritative option list to bind against.**
- **Three overlapping timelines**, two untyped: `Case.status_history` (typed
  `list[StatusHistoryEntry]`, `models.py:1035`) vs `Case.history` (bare `list[dict]`,
  `models.py:1092`) vs `Case.verdict_history` (bare `list[dict]`, `models.py:1095`) — plus a
  **fourth** shape, `CaseActivity` (`models.py:724`), stored in a separate KV ns. No single
  typed activity contract.
- **`list[dict[str,Any]]` advisory blobs** with the real shape only in a docstring:
  `automation_actions` (`models.py:1117`), `knowledge_used` (`models.py:1121`),
  `notifications_sent` (`models.py:1101`), `ThreatContextPanel.*` (`models.py:341-345`) —
  UI/editors lose all schema help. Candidates for concrete sub-models.
- **Two near-identical image-data-URL validators**: `validate_avatar` (`models.py:476`,
  png/webp/jpeg magic-byte sniff, `MAX_AVATAR_LEN` 64KB, SVG-reject) and `BrandingConfig`'s
  logo validator — a reuse opportunity if the overhaul touches branding/theming.

### 2c. Model coupling notes

- `models.py` imports `config.Preferences` at module top (`models.py:18`); `config.py`
  references model class names in docstrings — a **bidirectional pair**, so "move models
  freely" (G8) is constrained here.
- The rule vocabulary is split **config.py** (`RuleDefinition`/`RuleMatch`/`CorrelationRule`/
  `CaseAutomationRule`) vs **models.py** (`DetectionRule`). `DetectionRule` references the
  config halves as loose dicts **to avoid a config↔config cycle** (`models.py:975`) — unifying
  them for G6 requires resolving that cycle deliberately, not a naive import.
- **`webui/src/lib/types.ts` (~2047 lines) is a hand-maintained mirror** of `config.py` +
  `models.py` (no codegen). Any rule/policy/dashboard model change for G6/G7 must be mirrored
  by hand — silent contract drift with no compiler bridge. The `fp_auto_close`/`auto_close`
  mismatch already shows `types.ts` declares `auto_close` yet no editor writes it.

---

## 3. The API surface

`backend/app/api/` = **one 4751-line monolith** (`routes.py`, 124 endpoints, mounted at
`APIRouter(prefix="/api")` `routes.py:67`) **+ 14 per-feature routers** (Round-3/4) mounted
uniformly under `Depends(require_auth)` (`main.py:83-99`). GET `/api/branding` is the only
public pre-auth GET (`deps.py` `PUBLIC_GET_PATHS`).

### 3a. `routes.py` regions (the god-router)

| Lines | Concern | Notable endpoints |
|-------|---------|-------------------|
| 1–1600 | health · SSE · setup wizard · connectors/sources · browse/unified logs · **settings (read/schema/section/case-id)** · chat/investigate/overview · models/personas/runbooks · RAG · memory · **proposals (HITL)** · playbooks · metrics/feedback · demo · **branding** · **customization/terminology/views/tables** · auth/session | `GET/PUT /settings`, `GET /settings/schema`, `GET /settings/{section}`, `POST /sources`, `GET/PUT /branding`, `GET/PUT /prefs/{user,org,effective}`, `GET/POST /views`, `POST /proposals/{id}/approve` |
| 1600–3200 | org/user customization + terminology + saved views + table column-state · **full auth** (login/logout/change-pw/MFA/SSO/refresh/reauth) · sessions (self+admin) · account profile/avatar · **RBAC roles + user admin** · start of Cases + global search + audit | `POST /auth/*`, `GET/POST /sessions`, `GET/POST/PUT/DELETE /users`, `GET /roles`, `GET /cases`, `GET /search`, `GET /audit` |
| 3200–4751 | **case lifecycle/collaboration/explainability** (action/bulk/feedback/comment/tags/assign/export/investigate/run-playbook/threat-context/**trace/rationale/forwarding**) · scans · standup · usage · poll · investigation helpers · notifications sub-API | `POST /cases/{id}/action`, `POST /cases/bulk`, `GET /cases/{id}/{trace,rationale,forwarding}`, `POST /poll`, `GET /usage/summary`, `/notifications/*` |

### 3b. The 14 feature routers

`routes_metrics` · `routes_tuning` · `routes_standup` · `routes_models` · `routes_enrichment`
· `routes_inapp` · `routes_cases_collab` · `routes_triage` · `routes_roles` · `routes_campaigns`
· `routes_baseline` · `routes_batch` · `routes_reset` · `routes_setup`.
Case sub-routes are **fragmented across ≥4 routers** (`routes.py` core + `routes_triage`
`/triage`,`/timeline` + `routes_cases_collab` `/thread`,`/activity`,`/tasks`,`/reactions` +
`routes_campaigns` `/cases/{id}/campaign`) — a unified `CaseDetail` data layer must fan out
to 4 backend modules.

### 3c. API-surface issues (rules/dashboards/coupling)

- **G6 — rules have NO dedicated typed API.** All detection/correlation/risk/auto-close/
  suppression/caps config is edited via the single generic `PUT /api/settings` deep-merge
  (`routes.py:820`) that validates the ENTIRE `Preferences`. No `POST /api/rules`, no per-rule
  validate, **no dry-run/preview**. `suppression_rules` can only be appended via
  proposal-approve (`routes.py:1252-1273`) — no direct suppression CRUD.
  **Contrast:** `routes_tuning.py` HAS the right shape (`GET/PUT /tuning/config` + per-rule
  `apply`/`rollback` + recommendations) — the model the other rule families lack.
- **G6 — schema poverty.** `settings_schema.py` emits only name/type/default/required/
  choices/description with **no grouping beyond top-level sections, no ordering, no
  min/max/step, no conditional visibility, no per-list-item schema** (`correlation_rules`
  dict-of-model degrades to `type:'object'`; `rule_catalog` list degrades to `type:'array'`
  with no element model). `_type_name` collapses `dict[str,CorrelationRule]→'object'`,
  `list[RuleDefinition]→'array'` (`settings_schema.py:94-97`). Any top-level non-BaseModel
  field falls into a synthetic **`general` junk bucket** (`settings_schema.py:163-165/198-199`).
  So even *wiring* the (currently dead) schema would not produce rule editors.
- **G7 — no user-created-dashboard resource anywhere.** `SavedView` (`routes.py:1523-1725`)
  covers filtered LIST views only, not composable widget dashboards. `_NAV_TARGETS`
  (`routes.py:3127`) is a **hardcoded page list** that drifts from `webui/src/soc/nav.ts` on
  any IA change (relevant to G3 + G7 — new pages won't appear in the Cmd-K palette unless
  hand-edited). `GET /search` (`routes.py:3150`) pulls a fixed 200-case window then
  substring-filters **in Python** — not a real search.
- **G3 — whole-object settings coupling.** `PUT /settings` round-trips the whole
  `Preferences`; **no PUT `/settings/{section}`** exists to pair with the GET. This is why
  `Settings.tsx` is one 2673-line file. Error path leaks a raw Pydantic exception string as
  the 422 detail (`routes.py:834-835`) — no field-level error map.
- **AuthZ inconsistency.** Many GETs have no `require_permission` and rely only on
  router-level `require_auth`: `GET /settings` (full prefs dump, **least-guarded** of the
  three settings readers, `routes.py:799`), `GET /roles` (**no auth dep at all**, leaks the
  RBAC matrix, `routes.py:2918`), plus `models`/`personas`/`runbooks`/`rag`/`memory`/
  `metrics`/`prefs/*`/`views`/`terminology`. `POST /poll` (`routes.py:4195`) is a
  state-mutating cursor-advancing POST with **no permission dep**. Feature routers also
  diverge (metrics→`metrics:view`, tuning→`automation:read`, standup→none, baseline→
  `settings:read`, campaigns→`cases:read`, batch→`models:read`) — a single "Rules/Detection"
  admin page cannot be gated by one permission.
- **Route-ordering hazard:** `GET /settings/{section}` (`routes.py:864`) is a catch-all
  declared **after** literal `/settings/schema` + `/settings/case-id/preview`; any future
  literal `/settings/*` added below line 864 is silently shadowed.
- **Duplicated inline connector-build ladders.** `source_logs` (`routes.py:479-553`),
  `unified_logs` (`_read_pull` `routes.py:602-627`), `_chat_source_connector`
  (`routes.py:922-954`) each independently import + hand-build Elastic/OpenSearch/Wazuh +
  `StructuredQuery` — three copies of one factory that belongs in state/registry.
  `es_client_for_source(src)` is the one centralized per-source TLS/client factory — the
  model to extend.
- **`read_only_settings_mode` guard duplicated inline** in 5+ handlers (`routes.py:826,
  1425,1472,1598,1627`) instead of a shared dependency.
- **Two RBAC idioms in the SAME file:** declarative `Depends(require_permission(...))` (most
  routers) vs the imperative `if request is not None: await _enforce(...)` block in the
  case-action/comment/tags/assign block (`routes.py:3379-3773`) with lazy per-handler imports.

---

## 4. The engine — rules / correlation / risk / tuner / automation / case_manager

### 4a. `case_manager.py` — the trust core (#3)

`decide(verdict, confidence, risk_score, policy, *, escalation_confidence=0.6,
critical_severity=7.0)` (`case_manager.py:59`) is a **pure, side-effect-free truth table**
returning a frozen `Decision` {status, decision_by, objection_window_expires_at, escalate,
rationale} (`case_manager.py:42`). `CaseManager.apply(case)` (`case_manager.py:131`) is the
**only** mutation point.

- **The complete + safe G6 customization surface** = the ONLY inputs `decide()` reads:
  per verdict class {FALSE_POSITIVE, TRUE_POSITIVE}: `enabled`, `min_confidence` (0.0-1.0),
  `max_risk_score` (0.0-100.0), `objection_window_minutes` (≥0); plus two globals
  `Preferences.escalation_confidence` (0.6) and `Preferences.critical_severity` (7.0).
- **Auto-close gate:** `entry.enabled AND confidence>=min_confidence AND
  risk_score<=max_risk_score` (`case_manager.py:78-79`). **Escalate** (TP only):
  `confidence>=escalation_confidence OR risk_score>=critical_severity*10.0`
  (`case_manager.py:73-76`). Escalation **never closes** — it only prioritises.
- **NEEDS_HUMAN is inert + code-enforced off:** `_entry_for` returns `None` for NEEDS_HUMAN
  (`case_manager.py:51-56`); the defence-in-depth `AssertionError` at `case_manager.py:143-144`
  guarantees NEEDS_HUMAN/None can never be CLOSED (not policy-tunable). A generic form would
  render a no-op needs_human toggle — **a UI must lock it read-only.**
- **Three scales sit adjacent with no UI guardrails:** `confidence`/`min_confidence` 0-1,
  `risk_score`/`max_risk_score` 0-100, `critical_severity` 0-10 (compared `*10.0`). A UI must
  label units explicitly or an operator misconfigures the bar.
- **Read-time re-derivation for DISPLAY only:** `routes_triage._decision_span`
  (`routes_triage.py:284`) + `_policy_clause` (`routes_triage.py:330`) re-call `decide()` to
  prove determinism — this is the **only** feature router that imports `decide()`, and it is
  side-effect-free.
- **Cleanly decoupled** (G8-friendly): imports only config models + constants enums + `Case`
  + utils; no DB/LLM/network. All persistence/mutation is in `apply()`.
- **Missing:** a **decision-preview/simulator** endpoint ("given verdict=FP, conf=0.9,
  risk=25, what would decide() do against *draft* policy?"). `decide()` is pure + cheap, so a
  thin `POST /api/triage/preview-decision` wrapping it would be high-value for a safe G6
  auto-close editor. Does not exist today.

### 4b. Detection core — `correlation.py` / `signatures.py` / `risk.py`

Pure, no-LLM, stateless-over-Preferences (good for G8 — a rules UI only writes Preferences,
no engine change needed; write path is `state.update_prefs` → `routes.py:224`).

- **`correlate(events, prefs)`** (`correlation.py:71`) — buckets by rule, resolves entity
  (`resolve_entity` `correlation.py:43` with `_AUTO_LADDER` IP→HOST→USER→RULE `correlation.py:32`
  / `_PINNED_LADDER` `correlation.py:35`), windows (`_window_detail` EVERY/THRESHOLD sliding
  window `correlation.py:142`), builds `Cluster` (`_build_cluster` `correlation.py:182`),
  emits a human-readable `TriggerReason.sentence` (`correlation.py:230/257`).
  `correlation_rules` **is honoured** by `correlate()` via `correlation_for`/`correlation_for_def`
  but is **never surfaced in the UI**.
- **`cross_source_correlate(items, prefs)`** (`correlation.py:327`) — opt-in, default OFF;
  links RELATED open cases by shared entity+time-bucket when `>= min_sources` distinct
  sources. **Never merges** (only adds `related_case_ids`). Single-source behavior
  byte-identical when off.
- **`cluster_signature(entity_type, entity_value)`** (`signatures.py:18`) — **THE #4
  idempotency key**; entity-centric, rules deliberately **excluded** so a new rule *enriches*
  an open case rather than fragmenting it (`signatures.py:6-9`). Output MUST stay identical
  for a given (type,value). Shared by correlation/event_detection/poller/case dedup.
- **`compute_risk(cluster, prefs, reputation)`** (`risk.py:53`) — weighted normalised 0-100
  over volume/velocity/reputation/diversity/asset_criticality; sum-or-1 normalization
  (`risk.py:76-86`). **Reference points are HARDCODED magic numbers** (`_VOLUME_REF=50`,
  `_VELOCITY_REF=10.0/min`, `_DIVERSITY_REF=5`, `risk.py:20-22`) shaping the score curve, not
  in Preferences. **Velocity cliff:** forced to 0 unless `cluster.count>=3` (`risk.py:62-67`)
  — an undocumented, unconfigurable anti-saturation behavior. `_asset_criticality`
  (`risk.py:30`) is a **private fn imported+reused** by `priority.py:39` and
  `threat_context.py:27` — effectively a shared API; a rename breaks both.

**G6 detection-core gaps:** per-rule correlation editor (mode/n/window/group_by, backend
fully supports, zero UI); `mode`/`group_by` even for the default rule; full `rule_catalog`
manager (18 seeded rules, `RuleMatch` field/op/value, enable/reorder/priority, inline
correlation + per-role `model_override`); asset-criticality editors (`asset_networks` CIDR +
`asset_criticality` map); global `entity_strategy` selector; risk-curve calibration (expose
`_VOLUME_REF`/`_VELOCITY_REF`/`_DIVERSITY_REF`); weight clamping (RiskWeights unbounded).

### 4c. `threshold_tuner.py` — the adaptive auto-tuner (the ONLY self-adjusting rule surface)

Deterministic, no-LLM, **default OFF**, fail-safe (never raises). Reads recently
CLOSED/RESOLVED cases, computes per-rule FP via **Wilson lower-bound + min-samples floor +
EWMA**, and for genuinely noisy rules proposes/auto-applies a **bounded +1** to VOLUME knobs
only (`CorrelationRule.n` or a feed `severity_floor`). Shadow-eval blocks any raise that would
have hidden a confirmed TP; suppression DROPs route to the HITL Proposal queue (never
auto-applied). **NEVER imports `decide()`/risk/signature** — a config-writer only (source-text
guard test at `threshold_tuner.py:31`). Auto-applies audited (`ActionType.TUNING`) + reversible
via `stores/tuning.py`.

- Entry: `run_once` (`threshold_tuner.py:538`); pure core `derive_proposals`
  (`threshold_tuner.py:380`); stats `_accumulate_rule_stats` (`threshold_tuner.py:173`);
  `wilson_lower_bound` (`threshold_tuner.py:81`); `shadow_eval_hides_true_positive`
  (`threshold_tuner.py:318`); `rollback` (`threshold_tuner.py:757`). Config writers
  `apply_correlation_n`/`apply_severity_floor` return a NEW `Preferences`.
- API: `GET /tuning/recommendations` (dry-run), `GET/PUT /tuning/config`,
  `POST /tuning/{rule_id}/apply|rollback` (`routes_tuning.py:127-301`). Runtime:
  `AppState.threshold_tuner` (partial-bound, `state.py:528`), `_tuner_scheduler_loop` (6h
  tick, cadence-gated, `state.py:810`).
- **Issues (G6/G9):** (1) a full per-rule `rule_noise[]` array is **computed + typed but
  never rendered** (`routes_tuning.py:159-170`; `RuleNoise` in `Tuning.api.ts:66`) — the
  operator never sees near-miss rules or *why* a rule did/didn't get proposed (biggest
  observability gap, already-built-but-unwired). (2) config panel hides `max_n_step` (the
  n-vs-severity_floor **mode switch**), `wilson_z`, `ewma_alpha`. (3) **no manual "run now"**
  despite `cadence='manual'` existing. (4) no last-run/next-run visibility (store tracks it,
  API doesn't return it). (5) dry-run recommendations ignore `already_tuned` while the
  scheduler passes it (`routes_tuning.py:147` vs `run_once`) — **preview/reality mismatch**.
  (6) apply re-derives from scratch rather than acting on the previewed proposal (TOCTOU).
  (7) `TuningLedgerRow` declares `actor?`/`reason?`/`active` that `to_json` never emits
  (`tuning.py:95`) — **likely a real "always Active" bug**.
- **Coupling:** `routes_tuning.py` reaches into engine privates (`tuner._accumulate_rule_stats`,
  `_handle_proposal` with 8 kwargs, `_recently_tuned_ns`) — the router re-implements
  `run_once`'s inner loop rather than calling a public apply. `routes_baseline.py:36` imports
  the **private `_TDigest`** class — a leaky abstraction.

### 4d. `threshold_automation.py` — the closest thing to user-authored rules today

**Post-decision, #3-safe advisory rules.** After `decide()`+`apply()`+save, an
operator-configured `CaseAutomationRule` list is matched; each matched rule fires ONE action
(tag/recommend/notify/run_playbook/request_approval). Structurally #3-safe: **no action ever
writes `case.status`/`disposition`** (defence-in-depth assert `threshold_automation.py:205-208`);
`request_approval` only DRAFTS a HITL `Proposal`. Default-OFF, fail-isolated, byte-identical
when disabled. Wired at `state.py:269`, called from `pipeline.py:199` via `_maybe_automate`.
It is the **ONLY** user-configurable "rule" surface in the product today.

- Key: `evaluate(case, prefs)→list[AutomationAction]` (pure, `threshold_automation.py:122`);
  `ThresholdAutomation.run` (`threshold_automation.py:176`); `_execute_one`
  (`threshold_automation.py:219`, appends to `Case.automation_actions` + audits
  `ActionType.AUTOMATION`). Editor: `AutomationRuleEditor` (`Settings.tsx:1470`).
- **Issues (G6):** (1) **advisory-only** — cannot create detection rules, change
  correlation-n, adjust risk weights, or affect auto-close; those live in disconnected config
  blocks. **No unified "rules" concept.** (2) **Broken UI options** — `VERDICT_CONDITION_OPTIONS`
  (`Settings.tsx:1435`) lists `suspicious`/`benign` which are `Disposition` values, NOT
  `Verdict` (constants.py:182-184) — a rule with `verdict=suspicious` **silently never fires**.
  (3) `min_risk` and `min_severity` both match the SAME `case.risk_score` — duplicate/confusing.
  (4) **string-equality-only matching** — no contains/regex/in-list/not/OR. (5) **single
  action per rule** (must clone to tag+notify). (6) **`request_approval` is a dead end** —
  `_create_proposal` forces `kind∈{suppression,memory}` (`threshold_automation.py:297`), and
  the approve handler materialises the payload as a `SuppressionRule` (`routes.py:1252-1287`),
  which the rule's arbitrary payload almost never satisfies → **400s**. (7) **no validation**
  on free-form `conditions`/`payload` dicts — typos silently no-op; **no match-count / last-fired
  telemetry** anywhere.
- The `AutomationRule = CaseAutomationRule` alias (`config.py:1005`) exists **specifically to
  reserve `AutomationRule` for a future unified rule shape** — the codebase already
  anticipates the G6 consolidation.

### 4e. Cost / budget / priority governance (around `decide()`, never into it)

Three pure modules — `cost_gate.py` / `budget.py` / `priority.py` — verified to **not import
`case_manager`**.

- **`cost_gate.py`:** `passes_suppression(cluster, prefs)` (free layer-2 drop,
  `cost_gate.py:19`); `CaseBudget(caps)` (runaway-spend guard: `can_call_tool`/`add_tokens`/
  `exceeded`/`kill_switch`, `cost_gate.py:37`) consumed by the investigator loop
  (`investigator.py:114`). `capped_reason` (`cost_gate.py:48`) is a single string
  **overwritten by whichever check ran last** — loose contract for the primary safety mech.
  `passes_suppression` logic is **reproduced** (not imported) in `forwarding.py:147` to dodge
  an import cycle — two places that can drift.
- **`budget.py` (`BudgetGate`):** read-only pre-flight; `.check()→{action:allow|warn|block}`
  wired into the gateway (`gateway.py:70`), block → `GatewayError` → caller fails to
  **NEEDS_HUMAN** (never a silent close, #3). **Fail-open on any ledger read error**
  (safety). **Daily/monthly semantic mismatch:** daily reads a calendar-day `today_cost`
  bucket (NOT rolling 24h despite `window_hours=24`, `budget.py:124-132`); estimate is
  **systematically conservative** (prices full `max_tokens` as output, `budget.py:66-70`).
  Constructed in **two places** with different plumbing (gateway vs `routes_models.py:350`).
- **`priority.py`:** `derive_triage(case, prefs)→{risk,severity,impact,priority}` — the four
  advisory chips, read only at `GET /api/cases/{id}/triage`. **DUPLICATE `derive_priority`:**
  `priority.py:221` **ignores `matrix.enabled`** (always returns a level) while
  `shift_report.py:332` **returns None when disabled** — the same case can show a P-level chip
  yet be unprioritized in the shift report. Band cut-points hardcoded (`_BAND_HIGH_CUT=70`,
  `_BAND_MEDIUM_CUT=40`, `priority.py:50-51`) — the ITIL grid is only **half**-customizable.

### 4f. Metrics / posture / MITRE / shift-report — the "widget data catalog" (G4/G5/G7)

`metrics.py` / `mitre_coverage.py` / `shift_report.py` are **pure, deterministic, never-raise,
no-I/O** functions over `list[Case]` (+ SLA/priority policy). **Each key of the payload is
effectively one widget's data** — the backend already emits a decomposable widget catalog,
but **nothing lets a user pick/arrange widgets (G7 is greenfield).**

- `posture_metrics(cases, sla_policy, window_hours, compare, store_total)` (`metrics.py:497`)
  → `{lifecycle(MTTA/MTTR/dwell p50/p90), quality, aging, sla, compare, truncation}`; served
  by `GET /api/metrics/posture` (`routes_metrics.py:62`). `compute_metrics` (`metrics.py:111`,
  legacy) still live at `GET /api/metrics`.
- `compute_mitre_coverage` (`mitre_coverage.py:88`) + `navigator_layer` (`mitre_coverage.py:209`,
  ATT&CK Navigator v4.5 export). **Coverage % denominator = the whole 600+-technique corpus**
  (`mitre_coverage.py:147`) → always a scary near-zero headline; a dashboard-clarity problem.
- `build_shift_report` (`shift_report.py:353`): `urgency_score` (0.5·risk + 0.25·sev +
  0.2·age_pressure + bump, `shift_report.py:103`) drives `attention_queue`
  (`shift_report.py:150`) — an **opaque black-box ranking** no operator can inspect/tune (G6).
  Shift window bands are **hardcoded UTC 3-band** (`routes_standup._current_window`
  `routes_standup.py:78`), ignoring `SlaPolicy.timezone`.
- **Honesty markers:** `metrics.py` caps at `_STORE_FETCH_LIMIT=5000` and emits a
  `truncation_marker` (`metrics.py:480`) so the UI can label a partial rollup; `mitre_coverage`
  has a near-identical copy (`mitre_coverage.py:74`) — consolidate. **DASH `'—'`** for missing,
  `null==new growth`, reason strings — every consumer must special-case (re-implemented in
  `posture.format.ts`).
- **G4/G5 waste:** the Overview posture **hero band** (`Overview.tsx:545-553`, static title
  "Security Posture Dashboard") carries **zero live metric** yet occupies prime real-estate,
  pushing dense StatCards below. Overview **duplicates** posture data Metrics owns
  (`Overview.tsx:663-720` re-fetches `fetchPosture`). Fixed non-configurable buckets/limits
  (age buckets 6-tuple `metrics.py:296`; `oldest_n=10`; `breaching[:25]`; `top_techniques[:25]`;
  Navigator heat thresholds/hex `mitre_coverage.py:195-206`) block dashboard-customization.

### 4g. Poller / ingestion / event-detection (the "trigger" spine)

- **`PollerManager`** (`poller_manager.py:57`, **IS `state.poller`**) fans out N per-source
  `Poller` children (Round-4 bug fix); serialized by `_poll_lock` + `Semaphore(caps.max_concurrent)`.
  Per-`{source.id}:{feed.id}` cursor + legacy-`"primary"`-collision guard.
- **`ingest.handle_clusters`** (`ingest.py:178`) is the **single shared choke point** for
  pull + push + event-detection re-entry (very high blast radius). Auto-forward gate
  (`ingest.py:237-242`): `background_scan_enabled AND auto_investigate_eligible AND
  _auto_correlate_allowed AND (is_alert | wildcard | rule∈auto_forward_allowlist)`. **Per-signature
  in-flight lock** (`_sig_lock` `ingest.py:259`) so concurrent sources never dup a case (#4).
- **`event_detection.py`** — cheap-first funnel (pre-aggregate → deterministic rules → anomaly
  vs baseline → batched Haiku) whose survivors re-enter the **same** correlate→handle_clusters→
  decide() pipeline as candidate clusters (#3/#4, #9-fenced via `fence`/`fence_block`,
  #7 aggregate-only via `EntityBucketSummary.to_payload`). **Pure producer** — never imports
  `case_manager`/`decide()`; re-entry via `pipeline.register_candidate`+`investigate_cluster`
  (`state.py:712-715`). Batch requests keyed by stable `custom_id` (#6).
  **Two firing implementations:** realtime `correlate` vs `event_detection._rule_fires`
  (`event_detection.py:239`) over aggregates — a UI rule editor must keep both consistent.
- **Coupling:** the EVENT-funnel hook is a bare mutable attribute set from 3 places
  (`state.py:294/1207` assign `state._route_event_feed` onto `poller._primary._event_funnel`)
  — brittle "H1 contract." Triplicated longest-pattern feed-by-index resolution
  (`ingest.py:100/141`, `elastic.py:243`) with inline `import fnmatch` in hot loops.
  Duplicated background loop (`poller.py:385` vs `poller_manager.py:307`).

### 4h. Baseline / campaigns (Round-4 pure producers)

- **`baseline.py`** — online per-(signature, hour-of-week ×168-bucket) stats: Welford + dual
  EWMA + bounded deterministic **t-digest** (p50/p95/p99) + MAD modified-z (|M|>3.5) + a
  warm-up gate. **Cleanly decoupled** from the decision core (no `case_manager`/risk/LLM
  imports). One runtime consumer: `event_detection.funnel`. **Anomaly logic triple-defined**
  (`is_anomaly()` `baseline.py:424`; inlined in `observe()` `baseline.py:474`; re-checked in
  `event_detection.py:298` — the funnel recheck is redundant). Determinism is load-bearing
  (fixed `math.fsum` order, pinned t-digest compression, `SKETCH_VERSION` gate) — any
  arithmetic/iteration-order change breaks persisted state + tests.
- **`campaigns.py`** — daily deterministic union-find over shared cross-source entities /
  MITRE techniques → `Campaign` objects; **references `case_ids` only, never re-clusters or
  closes** (#3/#4). `_campaign_id` = sha256 of sorted member cluster_signatures — stable ids
  (load-bearing for idempotency). `_DisjointSet` (`campaigns.py:159`) is generic, reusable.
- **G6 gaps:** `BaselineConfig` (6 global knobs, **no per-signature/per-source override**);
  `CampaignConfig` exposes ONLY `{enabled, cadence}` — the clustering rule (`>=2 cases + >=1
  shared entity`), entity-window fallback (`86400`), and scan bounds are **hardcoded constants**
  with no config path.

---

## 5. Stores — core + SQL + the zero-migration KV pattern

### 5a. Core stores

- **`CaseStore`** (`cases.py`): `find_open_by_signature` (`cases.py:46`, the **#4** idempotency
  lookup — `cluster_signature` + `OPEN_CASE_STATUSES`, sort updated_at desc, size 1) +
  `list`/`list_scans`/`count_new_scans`. `list` filters are a **fixed set**
  (status/source_surface/entity_value only — no disposition/risk-range/assignee/tags/MITRE/
  date/free-text) — a customizable case dashboard (G7) can't express those at the store layer.
- **`UsageStore`** (`usage.py`): the **single cost ledger** (written only by the gateway, #6);
  `summary()` (`usage.py:44`) feeds the Cost dashboard AND the BudgetGate — MUST stay **EXACT/
  unbounded** (a row-cap here is a security/cost regression). **Fixed-shape:** dimensions
  (by_surface/by_model/by_role only), **hourly-only** granularity, hardcoded top-N (10, 5) —
  every new cost widget needs a backend edit (blocks G7).
- **`ProposalStore`** (`proposals.py`) + **`TuningStore`** (`tuning.py`): loose-JSON-list-in-KV,
  never-raise. `TuningRecord` (`tuning.py:44`) is a bespoke `__slots__` class (NOT Pydantic,
  invisible to `types.ts`).

### 5b. The KV pattern (base + adapters) — the G7 answer

- **`KVStore` ABC** (`base.py:240`): single-doc `get(ns,key)`/`put(ns,key,value)` + a
  **CAS-safe** `mutate()` (`base.py:280`) via **`kv_mutate`** (`base.py:48`, per-key
  `asyncio.Lock` + `_rev` compare-and-set retry loop, 8 retries, **never raises**). `_rev`
  rides **inside the value dict** (backend-agnostic — no `seq_no`/column).
- **Adapters:** `SqlKVStore` (`repositories.py:399`, over the shared `KVRow` composite-PK
  table) + `EsKVStore` (`memory.py:51`, one doc per (ns,key) in `CONFIG_INDEX`; stable ids for
  5 legacy singletons, else composed `f'{ns}:{key}'`). **Both satisfy the same ABC** → every
  Round-2/3/4 feature store rides `self._kv` injected in `_wire()` and needs **no new
  index/table/migration**.
- **`UserPrefsStore`** (`user_prefs.py`) is the reference per-USER store: **the whole set is
  ONE KV doc** (`ns="user_prefs"`, key=`"buckets"`, value=`{"buckets":{"<uid>":<UserPrefs>}}`),
  keyed by `normalize_user_id` (`"default"` when auth off). `resolve_effective_prefs`
  (`user_prefs.py:224`) merges ORG defaults (`Preferences.customization`) under USER overrides
  — the exact cascade template for G7 org-default + per-user dashboards.

### 5c. KV-pattern issues + the G7 recipe

- **⚠ `user_prefs.py` uses the OLDER lost-update-UNSAFE RMW** (`_load_all→mutate→_save_all`,
  no per-key lock, no `_rev` CAS) — unlike `inbox.py:130` which routes through `kv_mutate`.
  Two concurrent operators saving prefs can clobber each other. **A new dashboards store MUST
  follow `inbox.py`/`tuning.py` (kv_mutate + store-owned lock), not `user_prefs.py`.**
- **Single-doc scaling ceiling:** dashboards (widget layouts + saved queries) are far larger
  per-user than prefs; a single `{'buckets':{uid:<all dashboards>}}` doc rewrites ALL users'
  dashboards on every write. **Prefer per-user sub-keys** (`ns='dashboards'`, key=`<uid>`) so
  a write touches only one user's doc — the KVStore contract + `EsKVStore` composed-id
  fallback support arbitrary keys with **no registration**.
- **12 DEAD `*_DOC_ID` constants** (`constants.py:103-176`, e.g. `TUNING_DOC_ID`) have **zero
  references** — `EsKVStore._doc_id` only registers 5 namespaces; every Round-3/4 store uses
  the composed fallback (so the tuning doc is actually id `'tuning:tuning'`). A **latent
  data-orphaning trap** if anyone "wires up" a constant later.

**The zero-migration recipe to add a per-user `dashboards` store (the G7 answer):**
1. `models.py` — add `Dashboard`/`DashboardWidget` Pydantic models (mirror `SavedView`/`ColumnState`).
2. `constants.py` — add `DASHBOARDS_NS`/`DASHBOARDS_KEY` (or per-user keys — preferred).
3. `stores/dashboards.py` — a `DashboardStore(kv: KVStore)` **copying `inbox.py`/`tuning.py`**
   (kv_mutate + store-owned `asyncio.Lock`), NOT `user_prefs.py`'s unsafe path.
4. `state.py` — one line: `self.dashboards = DashboardStore(self._kv)` in a `_build_*` method.
5. `api/routes_dashboards.py` — small router keyed by the authed user via `normalize_user_id`;
   optionally `resolve_effective_prefs`-style ORG-default cascade.
**No ES index, no SQL table, no migration** — `SqlKVStore` + `EsKVStore` back it on both
backends immediately. Reuse `SavedView`'s `scope`/`shared` concept for team/org sharing.

### 5d. SQL backend — adding a persisted entity

`stores/sql/{models,repositories,engine}.py` reproduces the ES stores' **exact** method
signatures (callers are backend-blind via the ABCs). `models.py` = 6 ORM tables storing rich
Pydantic docs as **JSON `doc` columns** while **materializing + indexing only** filtered/sorted
columns. `engine.create_all` (`engine.py:50`) **CREATEs missing tables but NEVER ALTERs** —
**no Alembic/migrations**; adding a materialized column to an existing DB has no migration path.

- **Two templates for a new entity:** (A) **queryable/large → rich table** (ORM class + a
  `Sql*Repository` + ES twin store + `es/indices.py` template + wire both in `_build_state_backend`)
  — a 3-place edit that can drift. (B) **small/single-doc → KV** (the common Round-3/4 choice)
  — **no ORM, no ES index, no migration.** **G7 dashboards should use (B).**
- **Confirmed cross-backend divergence:** `list(sort_field='risk_score')` is whitelisted
  (`repositories.py:130`) but `CaseRow` has **no `risk_score` column** — SQL silently falls
  back to `created_at` while ES sorts the real field. `SqlAuditRepository` filters actor/surface
  **in Python** over a bounded window (older rows can fall outside → invisible), unlike the ES
  real query.

### 5e. Where rules/dashboards persist (customization gaps)

- **G6:** there is **no queryable/rowed rule entity** — rules/risk/auto-close/tuning all live
  in the monolithic Preferences KV doc, so per-rule enable/version/scope/audit UIs have no
  persistence primitive; they must patch the whole blob (concurrent edits contend on one
  document, mitigated only by `kv_mutate` CAS). Per-rule audit/rollback exists ONLY for
  threshold tuning (`TuningStore`).
- **G7:** **no dashboard persistence primitive.** Nearest = `UserPrefsStore` (saved views /
  columns / theme). A custom-dashboard entity is a NEW KV store (per-user) or, if shareable/
  queryable, a NEW rich table on all three backends.

---

## 6. LLM gateway / pricing / batch (#6)

- **`LLMGateway`** (`gateway.py:45`) is **the #6 choke point** — every completion/embedding
  flows through `complete` (`gateway.py:162`) / `embed` (`gateway.py:211`), and **`_record`
  (`gateway.py:300`) is the ONLY place a `UsageDoc` is written** (exactly one per call).
  Provider resolution via `PROVIDER_REGISTRY` (anthropic/openai/azure/bedrock/vertex/mock)
  with a per-(provider,base_url,api_version,region) client cache. Budget pre-flight
  (`_budget_preflight` `gateway.py:273`) → `GatewayError` on block → NEEDS_HUMAN (never a
  silent close). Provider error → record ONE error row then raise (never drop an alert).
- **`pricing.py`:** `cost_for` (`pricing.py:289`) — **non-cache/non-batch path byte-identical
  to the legacy 2-term formula** (regression-tested; do not reorder). `resolve_price`
  (`pricing.py:273`) precedence overlay → `PRICES` → registry → heuristic → default
  (**`PRICES` wins over the registry** `pricing.py:286` — editing only `model_registry.json`
  has no effect for a model already in `PRICES`). Cache rates read 0.1× / write 1.25×[5m]/2×[1h]
  (`cache_rates` `pricing.py:131`); batch 0.5×. `pricing_source` (exact/heuristic/zero/default,
  `pricing.py:214`) drives the "verified/approximate/simulated" trust badges on the cost
  surface. `model_catalog()` (`pricing.py:171`) is the read model for the webui Models page
  (hardcodes `batch_multiplier:0.5` per row).
- **`batch.py`:** `BatchProvider` SPI (Anthropic Message Batches + OpenAI Batch;
  `BATCH_PROVIDER_REGISTRY` `batch.py:396`); UNORDERED results keyed by `custom_id`, folded
  back through `gateway._record` **exactly-once** by `stores/batch_jobs.py` (**CLAIM-before-bill
  CAS**, `batch_jobs.py:189/202`).
- **Issues:** (1) **#6 encapsulation leak** — `_record` (a "private" method) is called from
  OUTSIDE by `batch_jobs.py`; the one-write invariant is enforced by convention across a module
  boundary. **Recommend a public `gateway.record_usage(...)`.** (2) `CompletionResult`
  (`providers.py:89`) and `BatchResult` (`batch.py:48`) are near-identical mirror carriers.
  (3) **Azure/Bedrock/Vertex skip cache-token extraction + `with_retry`** (only direct
  Anthropic+OpenAI paths get cache economics + retry). (4) OpenAI cache double-bill is
  mitigated **in the provider** (subtract cached from prompt_tokens, `providers.py:255-265`)
  not in `cost_for` — a new provider that forgets the subtraction double-bills.
- **G6-adjacent customization:** price overrides ARE user-configurable via `PriceOverlayStore`
  but **only the (input,output) tuple** — cache rates + batch multiplier are NOT overlay-able.
  Budget is a single global gate (surface/role/case_id are all on the call, so per-scope budgets
  are *plumbable* but not exposed). The tier heuristic (`_TIER_HEURISTIC` `pricing.py:61`) is
  hardcoded — no runtime UI to register a new model family.

---

## 7. Connectors SPI + OCSF — the loose-coupling exemplar (the G6/G8 pattern to copy)

`connectors/{base,registry}.py` + `ocsf/model.py` define the **plugin boundary** that makes
the suite vendor-agnostic — **the cleanest loose-coupling example in the codebase** (SPI +
registry + entry-points + pydantic contracts; a new source is a `pip install` + entry-point
with **zero core edits**).

- **`AuthField`** (`base.py:38`) — the **wizard-form field descriptor** {key, label, type,
  required, secret, help, help_link, help_code, group}. **This is the schema-driven-form
  primitive to reuse for a G6 rule-customization UI.**
- **`ConnectorManifest`** (`base.py:67`) — self-description driving discovery + wizard
  {source_type, display_name, category, ingest_modes, capabilities, auth_fields, config_fields,
  setup_help}. **`ConnectorRegistry`** (`registry.py:33`) discovers built-ins + out-of-tree
  `tlsoc.connectors` entry-points (`registry.py:126`), per-connector failure isolation ("one
  bad connector must not break listing," `registry.py:109`). `StructuredQuery` (`base.py:103`)
  = the source-neutral query IR the `es_query` tool emits (LLM never emits raw DSL).
- **The G6 opportunity:** promote `AuthField` into a generic `FieldSchema` (add
  min/max/regex/step/section/conditional-visibility) + one React form renderer, reused for
  connectors AND detection-rules/correlation/risk/auto-close/tuning. **This is the ready-made
  answer to "render rule editors from a declared schema"** instead of the 2673-line hand-rolled
  `Settings.tsx`. The gap to close: the current weak typing (free-string `AuthField.type`,
  `ConnectorManifest.category`/`capabilities`/`query_language` with valid sets only in
  comments) — promote to real enums shared with a generated TS type (G2/G8).
- **OCSF is bypassed on the pull hot path:** `ElasticConnector.poll`/`search` build events via
  `RawEvent.from_hit` and never call `to_ocsf` (only ~16 push receivers route through OCSF via
  `from_ocsf`). `RawEvent.from_ocsf` (`models.py:113`) drops all non-projected OCSF fields
  (observables/dst/class semantics). The `RawEvent.from_ocsf` docstring promises an `ocsf`
  field that **does not exist** (`models.py:120`). Severity is **double-converted** (score→id→
  bucket) on the push path but kept raw on the pull path — identical alerts can get different
  severities by ingest mode, which can flip a `severity_floor` gate (a #4 correctness surface).

---

## 8. Cross-cutting constraints & risks (carry into every overhaul task)

- **#3 (byte-identical `decide()`):** the only Preferences input to `decide()` is
  `auto_close` (`AutoClosePolicy`/`VerdictAutoClose`) + the two globals `escalation_confidence`/
  `critical_severity`. **A G6 auto-close editor MUST write `auto_close`** (currently the UI
  writes the deprecated `fp_auto_close`). Preserve field names
  `enabled`/`min_confidence`/`max_risk_score`/`objection_window_minutes`. **NONE** of tuning/
  baseline/campaign/sla/priority/automation may ever be wired into `decide()` (#3 banner
  comments `config.py:1016/1114`). Keep the `AssertionError` (`case_manager.py:143`) and the
  inert-needs_human contract. A rules editor must NOT add any action that mutates
  `Case.status`/`disposition` outside `decide()` (`CaseAutomationRule` is explicitly barred,
  `config.py:971`; `_perform_case_action`/bulk are #3-safe and set status directly as the
  analyst layer, `routes.py:3402/3577`).
- **#6 (one ledger write):** keep `_record` (or a public equivalent) the sole writer; batch
  exactly-once depends on CLAIM-before-bill. Don't add a second write path.
- **#9 (untrusted data):** branding `login_*`/logo validators, `fence`/`fence_block` in
  event-detection, `_safe`/`_clip` `[:2000]` bounds across feature routers, technique-id
  validation in `mitre_coverage`, and "render as plain, escape in UI" for audit/trace/rationale/
  threat-context are **injection defenses, not cosmetic** — preserve on any editor overhaul.
- **#2 (append-only audit):** never add an update/delete path to `AuditRow`; audit-before-act
  ordering in `routes_reset.py:104-113` is load-bearing.
- **#4 (no-skip/no-dup):** `cluster_signature` output, per-feed cursor keys, the shared
  per-signature lock, and `IndexPattern` legacy acceptance must not regress.
- **#10 (secrets):** UI sees ONLY `configured_status()` booleans; new source/rules/dashboard
  editors must keep secret VALUES on `Secrets` (env/in-memory) and expose only field NAMES
  (`SourceInstance.configured_secrets` `config.py:1476`). `POST /api/settings` full-doc
  round-trip must never leak/persist a secret; `setup_secrets` empty-string CLEARS a key.
- **Persistence merge, not replace:** `ConfigStore.save()` is full-doc replace — a partial
  Settings save that drops unknown fields wipes unrendered blocks (baseline/campaign/sla/
  priority_matrix/rule_catalog). PUT must merge.
- **Contract drift:** `webui/src/lib/types.ts` (~2047 LOC) is a hand mirror — every G6/G7
  model change must be reflected there (no codegen).

---

## 9. Consolidated reuse recommendations (for the design phase)

1. **One generic `RuleEditor` predicate primitive** (field/op/value rows + priority + enable
   toggle) reusable across `rule_catalog` (`RuleMatch`), `suppression_rules`, and
   `CaseAutomationRule` conditions — all share the `field/op/value` shape (`RuleMatch.op =
   equals|prefix|tag|exists`, `config.py:412`). Source option lists from backend enums (via
   `/settings/schema`), not hand-maintained parallel arrays (kills the `suspicious`/`benign`
   drift bug).
2. **One shared `VerdictAutoClose` sub-editor** rendered twice (FP + TP) — the config is
   symmetric — replacing the single deprecated `fp_auto_close` editor. Lock `needs_human`
   read-only. Share the `_policy_clause` display shape (`routes_triage.py:330`) between the
   editor and the case "Why" tab.
3. **Add a `POST /api/triage/preview-decision`** thin wrapper over the pure `decide()` for a
   safe what-if simulator (no new engine logic).
4. **Extend `settings_schema` to emit element/value model names** for `list[Model]`/
   `dict[str,Model]` + min/max/step/order/group/widget hints, then **wire the (currently dead)
   `GET /api/settings/schema`** so a generic renderer replaces much of `Settings.tsx` (G3).
5. **Add typed config endpoints for baseline/campaign/batch** mirroring `routes_tuning`'s
   `GET/PUT /tuning/config` so all 4 Round-4 rule blocks are edited consistently (G6).
6. **Consolidate all rule knobs into ONE "Detection & Rules" home** (rule_catalog +
   correlation + risk_weights + asset_criticality/asset_networks + suppression + auto_close +
   in_scope/excluded) — currently split across `DetectionSection`/`AdvancedSection`/
   `AutomationSection` (`Settings.tsx:910/1174/1767`). Unify the RBAC grant.
7. **G7 dashboards:** follow §5c recipe — a per-user KV `DashboardStore` (kv_mutate-based) +
   a widget registry that **dispatches to the existing pure metric functions by name**
   (posture/coverage/shift keys are already the widget catalog). Reuse the `SavedView`/
   `UserPrefsStore` cascade for org-default + shared dashboards.
8. **Extract the connector manifest/`AuthField`/entry-point registry pattern** into a general
   schema-driven-config system (G6/G8) — one `FieldSchema` + one renderer, reused for
   connectors AND rules.
9. **Router decomposition (G8):** extract `routes_auth`/`routes_sessions`/`routes_account`/
   `routes_prefs` from the `routes.py` monolith; extract the case-lifecycle truth table
   (`_ACTION_STATUS`/`_guard_transition`/`_perform_case_action`) into an `engine/case_actions`
   service; extract the investigation cluster-rebuild helpers into `engine/investigation_query.py`
   (shared by 4+ routes). Add a `require_settings_writable` dependency to replace the 5+ inline
   `read_only_settings_mode` checks; unify the two RBAC idioms on `Depends(require_permission)`.
10. **De-dup:** one shared `_safe/_clip`, one `truncation_marker`, one `derive_priority`
    (honoring `matrix.enabled`), one ITIL band helper (configurable cuts), one char→token
    estimate, one BudgetGate factory, one connected-component `_DisjointSet`.

---

_Sources: consolidated from mapping-agent findings for the "Backend map" domain (be:config-prefs,
be:config-secrets, be:models, be:routes-A/B/C, be:routes-feature, be:routes-feature2, be:rules-core,
be:case-manager, be:tuner, be:automation, be:cost-priority, be:metrics-engine, be:poller-detect,
be:baseline-campaign, be:stores-prefs, be:stores-core, be:stores-sql, be:state-main, be:llm,
be:connectors). All `file:line` citations as reported by those agents against the tree at 2026-07-01._
