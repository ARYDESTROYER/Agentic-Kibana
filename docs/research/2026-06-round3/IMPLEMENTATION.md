# Round 3 — IMPLEMENTATION (what shipped, per wave)

> Companion to [`PROPOSAL.md`](PROPOSAL.md) (the approved plan). This is the
> **as-built** record: what each wave delivered, the new modules, and the endpoint
> surface. Branch **`Testing`**, **local — not pushed**.
>
> **Outcome:** 12 user requests delivered across **Waves 0–4** + one ship-regardless
> security fix. **Additive, zero new runtime dependencies, `engine/case_manager.py`
> `decide()`/`apply()` byte-identical** (guard test), and the **12 non-negotiables held
> throughout** — in particular **#3** (the deterministic close/escalate decision is the
> only producer of CLOSED; the new `BudgetGate` is a pure pre-flight that fails safe to
> NEEDS_HUMAN, never a silent close), **#6** (one LLM-gateway ledger write per real
> call — the budget gate raises *before* the call and *before* any write), **#7**
> (Standup stays aggregate-then-summarise), and **#9** (every new log/source/operator/AI
> -influenceable value is fenced before a prompt and escaped in the UI).
>
> **Green baseline:** backend **1142+ pytest** (794 → 802 → 900 → 1074 → 1109 → 1142;
> rising as the post-round harden-wave regression tests land — see `Journal.md` for the
> exact current count) · webui `tsc + vite` clean · **181+ vitest** (86 → 175 → 181) ·
> eslint 0 rules-of-hooks errors.
>
> **Commit chain:** `bffe4b8` (W0) → `59c2999` (W1) → `2295363` (W2) → `8b25ca2` (W2.5)
> → `3610147` (W3) → the live-wiring / RAG-fencing-security / docs wave (W4).

---

## The 12 requests → where they landed

| # | Request | Wave(s) | Headline |
|---|---------|---------|----------|
| 1 | Settings screen real-estate | W0 (foundation), W3 | Responsive card grid + sticky save + per-section dirty + anchor TOC |
| 2 | Expandable hamburger nav + sub-pages | W3 | One sidebar, two width states, WAI-ARIA disclosure children, Cmd/Ctrl+B |
| 3 | More branding / appearance | W0, W3 | Bounded `ThemeTokens` allow-list + AA accent presets + contrast guard |
| 4 | Per-case human+AI ticket collaboration | W1, W2, W3 | Threaded human/ai/system messages + reactions + tasks + @mentions + activity feed |
| 5 | Richer posture dashboard | W2, W3 | Server-side MTTA/MTTR/dwell + SLA/aging + deltas + MITRE coverage + Navigator layer |
| 6 | Fine-grained permissions | W1, W2, W2.5, W3 | Custom roles + inheritance + explicit DENY + opt-in row-scope hook (server-enforced) |
| 7 | +15–20 enrichment sources | W1, W2, W2.5 | `EnrichmentProvider` SPI + **+17 new providers (19 registered)** + multi-indicator (IP/domain/hash/url/email) |
| 8 | In-app notification delivery | W1, W2, W3 | Per-user fan-out inbox + bell + per-category×channel prefs + quiet-hours/digest |
| 9 | Standardized/customizable Models page | W0, W2, W2.5, W3 | Provider registry (Azure/Bedrock/Vertex/OpenAI-compatible) + registry JSON + `BudgetGate` |
| 10 | Distinctive (less generic) UI | W0, W3 | Opt-in "command" material pack + glass chrome + page archetypes + editorial charts |
| 11 | A useful Standup | W0, W2, W3 | Forward attention queue + SLA/aging + workload + handoff/ack (deterministic, #7) |
| 12 | Clearer cases + agent-work viz | W0, W2, W3 | 4 honest triage chips + typed ReAct timeline w/ a distinct deterministic DECISION step |
| — | **Security fix (ship regardless)** | W4 | Invert RAG-knowledge fencing to a TRUSTED allowlist (OWASP LLM01) |

---

## Wave 0 — hot-file foundations + webui perf (`bffe4b8`)

One coordinated pass over the hot files so later waves never re-edit the headers, plus
webui route code-splitting (no backend touch). All additive + defaulted.

- **`models.py`** — 5 advisory `Case` axes (severity_band / severity_source /
  impact_band / urgency_band / priority_level) + 3 SLA lifecycle datetimes; **11 new
  model classes** (Observable, ProviderResult, CaseMessage, CaseActivity, CaseTask,
  InAppNotification, NotificationPref, CustomRole, ActionItem, ShiftAck, TraceSpan).
- **`constants.py`** — **4 enums** (IndicatorKind / AuthorType / NotificationCategory /
  Material) + 4 new `ActionType` audit values; **8 KV-namespace triples**
  (CASE_THREAD / CASE_ACTIVITY / CASE_TASKS / INBOX / NOTIF_PREFS / CUSTOM_ROLES /
  PRICE_OVERLAY / SHIFT_HANDOFF).
- **`config.py`** — **4 `Preferences` blocks** (sla / priority_matrix / budget /
  realtime) + `BrandingConfig.material / default_theme / theme_tokens / presets /
  effective_theme()`; `EnrichmentConfig` provider toggles + `RBACConfig.custom_roles /
  resources / denies` carriers; **13 optional `Secrets` provider-key slots** (booleans
  only in `public()`).
- **webui** — `App.tsx`'s ~25 page imports → `React.lazy` + one `<Suspense
  fallback={<PageSkeleton/>}>` inside the ErrorBoundary (Login/Wizard stay eager); new
  `PageSkeleton.tsx`; `vite.config.ts` `manualChunks` (react-vendor / recharts / motion /
  icons / radix). Entry bundle **444 KB → 63.75 KB gz** (recharts isolated + lazy).
- **Guard:** a test asserts `case_manager.py` never references the advisory field names.

Tests: **794 → 802** (+8 `test_round3_wave0_foundations.py`).

---

## Wave 1 — shared substrate / build-once (`59c2999`)

The 7 build-once foundations' backend half. New files + small coordinated `routes.py` /
`state.py` / `deps.py` additions.

- **8 KV stores** mirroring `user_prefs/memory/sessions` over the shared `KVStore` (no
  new index/table/migration): `CaseThreadStore`, `CaseActivityStore`, `CaseTaskStore`,
  `InboxStore` (per-user fan-out, ~200/user ring), `NotificationPrefsStore`,
  `CustomRoleStore`, `PriceOverlayStore`, `ShiftHandoffStore`.
- **`enrichment/` SPI** — `EnrichmentProvider` ABC + manifest (indicator types / auth
  fields / free-tier note), `ProviderRegistry` (built-ins + `tlsoc.enrichers`
  entry-point, filtered by `use_*` toggle + key presence), `dispatch.enrich_indicator()`
  (type-routed, fail-open, Redis-cached), `aggregate.fuse()` (default `max()`
  byte-identical; weighted fusion gated behind `fusion_enabled`). AbuseIPDB + VirusTotal
  refactored behind it; `enrich_ip()` kept as a **byte-identical alias** so the risk
  scorer + `EnrichmentResult` contract are unchanged (#3).
- **`realtime.py`** — an in-process async `EventBus` singleton (bounded per-subscriber
  ring + Last-Event-ID replay + ~15s heartbeat; typed frames) + nginx `location
  /api/events`. Frames are published **after save, never before `decide()`**.
- **RBAC** — split RESOURCES so each newer feature is its own resource (notifications /
  branding / sessions / demo / terminology / automation / roles / models / enrichment /
  inapp) with behavior-preserving `DEFAULT_MATRIX` grants; `effective_matrix()` folds
  custom roles + cycle-guarded inheritance + **DENY-wins** (super_admin hard-allowed);
  opt-in `can_object()` row-scope hook shipped **OFF**. Parity: the 6 built-in roles +
  `can()` stay byte-identical when nothing custom is configured.
- **Integrate** — wired the 8 stores into `AppState._wire()`, exposed
  `enrichment_registry` / `event_bus`, added `GET /api/events` (cookie-auth, 204 when
  `realtime.enabled` is false), migrated the 4 notification routes to `notifications:*`,
  folded `CustomRoleStore` into `can()` via `deps._enforce`.

Tests: **802 → 900** (+98: stores 19, enrichment 19, rbac 36, sse 24);
`test_route_auth_coverage.py` green incl. the new `/api/events`.

---

## Wave 2 — backend feature logic (`2295363`)

All 7 backend feature surfaces on the Wave-1 substrate. Built as 8 parallel feature
builders, each owning disjoint domain modules **and its own `api/routes_<feature>.py`
router** (so nobody edits the 4k-line monolith), then one integrator that mounts the
routers in `main.py` and wires services in `state.py`.

- **#5 posture** — `engine/metrics.py` extended (MTTA/MTTR/dwell p50/p90/mean from
  `status_history`, quality/aging/SLA, period-over-period) + new
  `engine/mitre_coverage.py` (per-tactic coverage vs the 697-technique corpus + ATT&CK
  Navigator v4.5 layer). Router `routes_metrics.py`.
- **#11 standup** — new `engine/shift_report.py` (attention queue ranked by urgency =
  risk/severity/age/SLA + SLA aging + per-analyst workload + deltas, all deterministic,
  no LLM) folded into `StandupService`; the forward-looking JSON still goes to the cheap
  model as a compact fenced aggregate (#7/#9). Router `routes_standup.py`.
- **#7 enrichment** — **+17 new providers (19 registered classes)** behind the SPI
  (the abuse.ch entry spans urlhaus/threatfox/malwarebazaar; see the catalog below),
  multi-indicator via `enrich_indicator(value, kind)`, per-provider rate guard,
  fail-open + cached. Router `routes_enrichment.py`.
- **#9 models** — a `PROVIDER_REGISTRY` replacing the gateway if/elif (generalized
  OpenAI-compatible `base_url`); bundled `llm/model_registry.json` (context_window /
  max_output / modalities / capabilities + input/output/cache costs) + operator
  overrides via `PriceOverlayStore`; pure `engine/budget.py` `BudgetGate` (daily/monthly
  ceilings, soft-warn %, on_exceed block|warn) checked pre-flight via `estimate_cost`;
  on block → `GatewayError` so callers fail to **NEEDS_HUMAN** (#3). Router
  `routes_models.py`.
- **#8 in-app** — `InAppChannel` (does NO network I/O — resolves recipients from
  RBAC/assignee, appends to `InboxStore`) self-registers on the `NotificationChannel`
  SPI and slots into dispatch **after** `apply()`+save (#3 flow unchanged); reuses
  `templates.render()` (#9). Router `routes_inapp.py`.
- **#4 collaboration** — threaded `CaseMessage` (human/ai/system authors, parent_id,
  reactions, soft-delete, `ai_meta`), `CaseTask` checklists, @mention fan-out → inbox,
  and **every per-case ChatEngine turn persisted** so investigation reasoning is no
  longer ephemeral. The AI is a first-class author but can only RECOMMEND — a parity
  test asserts an AI message never closes a case (#3). Router `routes_cases_collab.py`.
- **#12 triage** — `engine/priority.py` (read-time severity/impact/urgency/priority
  derivation, advisory-only) + a typed ReAct timeline (spans joined from audit + the
  usage ledger) with the `case_manager` DECISION as a **visually-distinct terminal
  step**. Router `routes_triage.py`.
- **#6 roles** — custom-role CRUD + preview/simulate + assignment + `/account/
  permissions`. Router `routes_roles.py`.

Tests: **900 → 1074** (+174 across 8 `test_round3_wave2_*` suites); authZ coverage green;
**#6 verified — ledger written exactly once/call** (budget gate raises before the call &
before any write).

---

## Wave 2.5 — backend gap-closure (`8b25ca2`)

Closed the 3 real gaps the Wave-2 builders flagged when `config.py` was frozen for
parallel-safety.

- **Cloud LLM, first-class** — `Provider` Literal widened to
  `azure / bedrock / vertex / openai_compatible`; `ModelConfig.base_url / api_version /
  region`; 12 cloud/enrichment `Secrets` (Azure / AWS / Vertex creds + honeypot/abuse.ch
  keys, booleans-only in `public()`); the gateway authenticates Azure, **Bedrock via a
  stdlib SigV4 ladder (no `boto3`)**, and Vertex (OAuth Bearer); 4 cloud rows added to
  `model_registry.json`. `ProjectHoneypotProvider` registered; abuse.ch sends an
  `Auth-Key` header when set; `EnrichmentConfig.use_honeypot` added.
- **Server-side RBAC enforcement** — a pure `can_for_roles(base, custom_roles, …)`
  (role-union, deny-wins, super_admin hard-allow, parity-clean when none assigned) +
  `deps._assigned_custom_roles()` loading `User.prefs['custom_roles']`; `_enforce` now
  decides via the union, so assigned custom roles are **enforced on routes**, consistent
  with `/api/account/permissions`.
- **Test netguard** — an autouse `conftest` socket guard blocks non-loopback egress
  (opt out per test with `@pytest.mark.allow_network`), making the enrichment tests
  deterministic + offline (~20× faster on the flagged test).

Tests: **1074 → 1109** (+35: config 21, rbac 6, netguard 8). Backend feature-complete.

---

## Wave 3 — webui surfaces (`3610147`)

One design-system agent (shared primitives) → 6 parallel surface builders (disjoint
pages + co-located api) → integrator (register pages in `App.tsx` + nav reconcile +
full build).

- **Design system** — allow-listed theme tokens (radius / density / canvas / surface /
  font + material chrome vars) in `theme.css` + Tailwind; **ONE** precedence resolver
  `theme-tokens.ts` (`applyTokens` sanitises/allow-lists; `applyBranding`; 6 AA accent
  presets; the `command` material pack where `quiet` === today's look); `GlassSurface`
  (reduced-transparency solid fallback); `SettingsGrid / SettingsCard / StickySaveBar /
  SettingsTOC`; chart primitives `MitreHeatmap / BurnDownChart / AreaSpark /
  MultiSeriesTrend`; page-archetype layouts.
- **#2 shell** — `NavSidebar` (one sidebar, two width states, Cmd/Ctrl+B, WAI-ARIA
  disclosure children + collapsed hover-card fly-outs, persisted in `UserPrefs.misc` +
  localStorage pre-hydrate); `NotificationBell` (unread badge + dropdown, poll-now /
  SSE-ready).
- **#1 + #3 + #10** — Settings card-grid + sticky save + per-section dirty + anchors;
  `BrandingEditor` (tokens / presets / material + contrast preview).
- **#6 + #9** — Roles matrix editor (grants / denies / inherits + preview-diff +
  simulate + assignment with last-admin lockout guard).
- **#9** — a standalone **Models** admin page (capability badges, inline price edit,
  gateway-metered test-call, live cost estimator, budget burn-down, cloud providers).
- **#5 + #11** — Metrics Operational / Performance / Posture tabs + MITRE heatmap +
  SLA/aging + deltas; Standup attention queue + action items + acknowledge + deep-links.
- **#12 + #4** — CaseDetail **4 honest chips** (risk / severity / impact / priority) + a
  typed ReAct `TraceTimeline` with the distinct deterministic DECISION step + full
  threaded human/ai/system collaboration (reactions, tasks, @mentions→inbox, activity).
- **#8 + #7** — Inbox page + `NotificationPrefs`; `EnrichmentProvidersEditor` (catalog /
  toggles / secrets / try-a-lookup) mounted in Settings.

Tests: webui `tsc --noEmit && vite build` exit 0 (code-split preserved, entry 68.85 KB
gz); **vitest 86 → 175** (+89 across 10 new spec files); **#9 audit PASS** (no
`dangerouslySetInnerHTML` on data; CaseThread / TraceTimeline / enrichment escape
untrusted; secrets boolean-only). Backend untouched (`case_manager.py` byte-identical).

---

## Wave 4 — live wiring + security fix + docs (this wave)

- **Live SSE wiring** — publish typed frames from the poller / dispatch / pipeline into
  the `EventBus`; webui `EventSource` with a polling fallback for the bell /
  case-activity / agent-step stream (default OFF; polling is the graceful fallback).
- **Security fix (ship regardless)** — **invert RAG-knowledge fencing to a TRUSTED
  allowlist.** Operator-imported RAG documents previously rendered to the model
  **unfenced**; now only built-in/verified corpus is TRUSTED and everything else is
  fenced UNTRUSTED before any prompt. Closes an OWASP-LLM01 prompt-injection gap; no
  behavior change for legitimate content.
- **Branding contrast** — `PUT /api/branding` computes `contrast_warnings` +
  `auto_corrected` server-side (the editor already degraded gracefully).
- **Polish** — distinctive-UI page archetypes / editorial charts / display type; a WCAG
  2.2 pass; docs sync (this file + CLAUDE.md / ROADMAP.md / README.md / DEPLOY.md /
  ENVIRONMENT.md / HANDOFF.md / .env.example).

---

## Endpoint surface (Round 3 additions)

Mounted under `require_auth`; every non-GET route carries an authZ gate
(`test_route_auth_coverage.py` enforces this).

**Realtime** (`routes.py`)
- `GET /api/events` — multiplexed SSE stream (204 when `realtime.enabled` is false)

**Posture / MITRE** (`routes_metrics.py`)
- `GET /api/metrics/posture` · `GET /api/mitre/coverage` ·
  `GET /api/mitre/coverage/navigator.layer.json`

**Standup** (`routes_standup.py`)
- `GET /api/standup/report`
- `GET/POST /api/standup/action-items` · `PUT/DELETE /api/standup/action-items/{item_id}`
- `POST /api/standup/acknowledge` · `GET /api/standup/acknowledgements`

**Enrichment** (`routes_enrichment.py`)
- `GET /api/enrichment/providers` · `GET /api/enrichment/lookup` ·
  `POST /api/enrichment/providers/{name}/secrets`

**Models / budget** (`routes_models.py`)
- `GET /api/llm/models` · `GET /api/llm/providers` · `POST /api/llm/models/test`
- `PUT/DELETE /api/llm/models/{model_id}/pricing` · `POST /api/cost/estimate`
- `GET/PUT /api/budget` · `GET /api/budget/status`

**In-app notifications** (`routes_inapp.py`)
- `GET /api/notifications/inbox` · `GET /api/notifications/inbox/unread-count`
- `POST /api/notifications/inbox/{notification_id}/read` ·
  `POST /api/notifications/inbox/read-all` ·
  `POST /api/notifications/inbox/{notification_id}/dismiss`
- `GET/PUT /api/notifications/prefs`

**Case collaboration** (`routes_cases_collab.py`)
- `GET /api/cases/{case_id}/activity`
- `GET/POST /api/cases/{case_id}/thread` ·
  `PATCH/DELETE /api/cases/{case_id}/thread/{msg_id}` ·
  `POST /api/cases/{case_id}/thread/{msg_id}/reactions`
- `GET/POST /api/cases/{case_id}/tasks` · `PATCH /api/cases/{case_id}/tasks/{tid}` ·
  `POST /api/cases/{case_id}/tasks/{tid}/log`

**Triage / trace** (`routes_triage.py`)
- `GET /api/cases/{case_id}/triage` · `GET /api/cases/{case_id}/timeline`

**Roles / RBAC** (`routes_roles.py`)
- `POST/PUT /api/roles` · `DELETE /api/roles/{name}` · `POST /api/roles/preview` ·
  `GET /api/roles/simulate`
- `GET /api/account/permissions` · `PUT /api/users/{username}/roles`

**Branding** (`routes.py`, extended) — `GET/PUT /api/branding`
(`PUT` returns `contrast_warnings` + `auto_corrected` in W4).

---

## Enrichment provider catalog (17 entries / 19 registered classes, behind the SPI)

> Counting rule: **19** provider classes are registered in `BUILTIN_PROVIDERS`; the
> abuse.ch row below is **one** catalog entry that fans out to **3** classes
> (URLhaus / ThreatFox / MalwareBazaar), so the 17 rows = 19 classes. The "+17 new"
> framing elsewhere counts Round-3 additions on top of the pre-existing AbuseIPDB +
> VirusTotal (19 − 2 = 17).

| Provider | Indicators | Key | Default | Env (`TLSOC_…`) |
|---|---|---|---|---|
| AbuseIPDB | ip | yes | off | `ABUSEIPDB_API_KEY` |
| VirusTotal | ip/domain/hash/url | yes | off | `VIRUSTOTAL_API_KEY` |
| GreyNoise Community | ip | yes | off | `GREYNOISE_API_KEY` |
| Shodan InternetDB | ip | **no** | **on** | — (keyless) |
| Shodan host | ip | yes | off | `SHODAN_API_KEY` |
| Censys | ip | yes | off | `CENSYS_API_ID` + `CENSYS_API_SECRET` |
| BinaryEdge | ip | yes | off | `BINARYEDGE_API_KEY` |
| IPinfo Lite | ip | optional | **on** | `IPINFO_TOKEN` (raises the cap) |
| AlienVault OTX | ip/domain/hash/url | yes | off | `OTX_API_KEY` |
| Pulsedive | ip/domain/url | yes | off | `PULSEDIVE_API_KEY` |
| Spur | ip | yes | off | `SPUR_API_KEY` |
| IBM X-Force | ip/domain/hash | yes | off | `XFORCE_API_KEY` + `XFORCE_API_PASSWORD` |
| URLscan.io | url/domain | yes | off | `URLSCAN_API_KEY` |
| HIBP | email | yes | off | `HIBP_API_KEY` |
| Project Honeypot | ip | yes | off | `HONEYPOT_ACCESS_KEY` (+ `use_honeypot`) |
| abuse.ch (URLhaus/MalwareBazaar/ThreatFox) | domain/hash/url | optional | **on** | `ABUSECH_AUTH_KEY` (lifts caps) |
| RDAP + DoH | ip/domain | **no** | **on** | — (keyless) |

Free tiers are tiny (Shodan ~1 req/s, Censys ~1 req/2.5s, GreyNoise 50/week) — each
provider carries a per-provider TTL + rate guard. Every provider string (PTR / banner /
tags / reputation text) is **UNTRUSTED**: fenced before any prompt, escaped in the UI
(#9). Enrichment is **advisory only** and never feeds the deterministic `decide()` (#3).

---

## Cloud LLM providers (Round 3)

`anthropic` + `openai` remain the default. Added first-class **Azure OpenAI**, **AWS
Bedrock** (stdlib SigV4 — no `boto3`), **Google Vertex** (short-lived OAuth Bearer), and
any **OpenAI-compatible** `base_url` (vLLM / Ollama / OpenRouter / Together / Groq — no
new key; set `base_url` in Settings → Models). All env-keyed + default-off; full env
table in `docs/ENVIRONMENT.md` §2.6. A pre-flight `BudgetGate` (default ceilings off)
fails over budget to NEEDS_HUMAN, never a silent close (#3); the ledger still writes
exactly once per call (#6).

---

## Invariants held (verification)

- **#3** — `git diff backend/app/engine/case_manager.py` empty; W0 guard test asserts
  the advisory fields are never referenced there; AI-message + budget-gate parity tests.
- **#6** — budget gate is a pure pre-flight that raises before the call and before any
  write → exactly one ledger entry per real call.
- **#7** — Standup feeds the model a compact fenced **aggregate**, never raw logs.
- **#9** — no `dangerouslySetInnerHTML` on data; all enrichment / thread / trace /
  terminology / template values fenced (prompts) and escaped (UI); the RAG-fencing
  allowlist fix closes the last unfenced path.
- **Zero new runtime deps** (backend stdlib-first; webui composes already-installed
  radix/shadcn/recharts/framer/lucide/cmdk).
