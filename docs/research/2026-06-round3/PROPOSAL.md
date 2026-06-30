# Round 3 — "Useful, distinctive, fine-grained" overhaul — PROPOSAL

> Status: **AWAITING USER APPROVAL** (no code written yet).
> Inputs: Phase-1 map (26 Opus subsystem readers + synth) + Phase-2 research (30 Opus
> web-researchers, 30/30 verified web access, + synth). Branch: `Testing`.
> Hard invariants honored by every item below: **#3** deterministic `case_manager.decide()`
> stays byte-identical (guarded by `tests/test_wave6_decide_guard.py`); **#9** all
> log/source/operator-influenceable values stay untrusted-fenced/escaped; **#1** two-key ES;
> **#6** one LLM gateway ledger. Strong bias to **additive, zero-new-runtime-dependency**
> changes; new stores use the KVStore zero-migration pattern; new providers/channels mirror
> the existing Connector / NotificationChannel SPIs.

---

## 0. Executive summary

The codebase is mature and well-guarded. Most of your 12 asks are **not rewrites** — they
are extensions along seams the architecture already provides. The research converged on
**7 build-once foundations** that multiple requests share; building those first makes the 12
features small and non-conflicting.

Scope at a glance (research-estimated):

| # | Request | Scope | Net |
|---|---------|-------|-----|
| 1 | Settings screen real-estate | M | Detail-pane card grid + sticky save + per-section dirty |
| 2 | Expandable hamburger nav + sub-pages | M | One sidebar, two width states, disclosure children |
| 3 | More branding/appearance | M | Bounded theme-token allow-list + presets + contrast guard |
| 4 | Per-case human+AI ticket collaboration | **L** | Typed activity + threaded messages (AI = first-class author) + tasks |
| 5 | Richer posture dashboard | **L** | Server-side MTTA/MTTR/SLA/aging/deltas + MITRE coverage |
| 6 | Fine-grained permissions | **L** | Custom roles + inheritance + explicit deny + (opt) row scope |
| 7 | +15–20 enrichment sources | **L** | EnrichmentProvider SPI + ~12 providers + multi-indicator |
| 8 | In-app notification delivery | M | `inapp` channel + per-user inbox + bell + prefs |
| 9 | Standardized/customizable Models page | **L** | Provider registry + model registry JSON + budget gate + admin page |
| 10 | Distinctive (less generic) UI | M | Opt-in "command" material pack + glass chrome + page archetypes |
| 11 | A useful Standup | M | Forward attention queue + SLA/aging + handoff/ack |
| 12 | Clearer cases + agent-work viz | M | 4 honest triage chips + typed ReAct timeline w/ decision step |

Plus one **security fix shipped regardless**: invert RAG knowledge fencing to a TRUSTED
allowlist (operator-imported docs currently reach the model **unfenced** — a real
prompt-injection gap, OWASP LLM01).

---

## 1. The 7 build-once foundations (Wave 0–1)

These are shared substrate; build once, reused by many features.

1. **Case lifecycle / SLA / priority fields (models.py + config.py).** Additive, defaulted
   `Case` fields (severity_band/severity_source, impact_band, urgency_band, priority_level)
   + `SlaPolicy` + `PriorityMatrix` on `Preferences`. Pure helpers in `engine/`
   (`lifecycle_intervals`, `derive_priority`, `severity_band_from_events`,
   `impact_band_from_criticality`) consumed by metrics (5), standup (11), case UI (12).
   **Parity guard test**: `decide()` byte-identical regardless of these fields.

2. **KVStore zero-migration stores.** New per-feature stores all reuse the proven
   `user_prefs.py`/`memory.py`/`sessions.py` pattern (one JSON doc, EsKVStore/SqlKVStore
   adapters, `'default'` bucket when auth off, never-raises): `CaseThreadStore`/
   `CaseActivityStore` (4), `InboxStore`+`NotificationPrefsStore` (8), `CustomRoleStore` (6),
   `PriceOverlayStore` (9), `ShiftHandoffStore` (11). **Zero new ES index / SQL table /
   migration across all of them.**

3. **One multiplexed SSE channel (`GET /api/events`).** Server→client push foundation for
   notifications (8), live case activity/thread (4), agent step streaming (12). Starlette
   `StreamingResponse`, in-process asyncio `EventBus` + bounded per-subscriber ring +
   Last-Event-ID replay + ~15s heartbeat; typed frames. Published **after** save, never
   before `decide()`. nginx: one new `location /api/events` (buffering off). **Default
   `realtime_enabled` OFF; polling is the graceful fallback** (#11). WebSocket explicitly
   rejected (all three uses are push-only).

4. **EnrichmentProvider SPI** (`backend/app/enrichment/`) mirroring `connectors/registry.py`:
   ABC + manifest (indicator_types, auth fields, free-tier note) + `tlsoc.enrichers`
   entry-point + type-routed parallel dispatch (fail-open) + weighted aggregate. `enrich_ip()`
   stays a thin alias; aggregation stays `max()` by default (`fusion_enabled` opt-in) so the
   risk scorer call site + `EnrichmentResult` contract are byte-identical (#3).

5. **Richer RBAC resource vocabulary + custom-role resolution.** Split the thin 11-resource
   vocabulary so each newer feature is its own resource (notifications/branding/sessions/demo/
   terminology/automation/roles/models/enrichment); migrate the ~dozen `settings:manage`
   routes onto dedicated resources with behavior-preserving default grants. `effective_matrix()`
   folds custom roles + inheritance + explicit deny (deny-wins; super_admin hard-allowed).
   **Parity guard**: 6 built-in roles + `can()` byte-identical when nothing custom configured.

6. **Route code-splitting + chart lazy-load (webui).** Convert `App.tsx`'s ~25 static page
   imports to `React.lazy()` + one `<Suspense>`; split `charts.tsx` (recharts) into its own
   chunk; vite `manualChunks`. DEV-only `rollup-plugin-visualizer` (honors zero-new-RUNTIME-dep).
   Prevents every subsequent feature from inflating first paint (~432KB→split).

7. **Shared UI primitives + theme-token extension.** `SettingsGrid`/`SettingsCard` (1),
   a bounded `ThemeTokens` allow-list + `applyTokens()` (3 + 10), a `GlassSurface` primitive
   gated behind `prefers-reduced-transparency` (10). Single source of truth stays `theme.css`
   tokens + `palette.ts`.

---

## 2. Per-feature plan

### 1 — Settings screen real-estate (M)
The IA is already good; the defect is the **detail pane** (one narrow `<Card>` of stacked
forms inside `max-w-[1400px]`). Replace with responsive `SettingsGrid`/`SettingsCard`
(`lg:grid-cols-2 xl:grid-cols-3`, wide cards span 2), sticky save bar + Discard, per-section
dirty dots, send only changed keys, in-section anchor TOC. Pure presentational, low risk.

### 2 — Expandable hamburger nav (M)
One sidebar, two width states (248px labelled drawer ↔ 64px icon rail), `Cmd/Ctrl+B` toggle.
Add `children?: NavItem[]` to `nav.ts` to surface pages currently reachable only via Cmd-K /
tabs. **WAI-ARIA disclosure pattern** (aria-expanded/controls + rotating chevron), not
role=tree. Collapsed mode → Radix popover fly-out of children (destinations never hidden).
Persist `{nav_collapsed, nav_open_groups}` in `UserPrefs.misc` (no new store) + localStorage
pre-hydrate to avoid flash. `AppShell.tsx` is a hot file → single owner sequences this with 8+10.

### 3 — More branding/appearance (M)
(1) **One** light/dark resolver with explicit precedence (user-explicit > org default >
`prefers-color-scheme`) — fixes the current two-owner race. (2) Promote branding from 3 vars
to a bounded `ThemeTokens` allow-list applied via `applyTokens()` (never arbitrary CSS).
(3) Server-side derive `*-foreground` + **WCAG-AA contrast guard** (auto-correct + warnings).
(4) 4–6 named AA-vetted accent presets. Endpoints: `GET /api/branding/presets`; `PUT
/api/branding` returns `contrast_warnings`+`auto_corrected`. All inputs regex/enum-bounded (#9).

### 4 — Per-case human+AI ticket collaboration (L)
(A) Append-only **activity timeline** from the existing audit store + a `CaseActivityStore`.
(B) **Threaded messages** where the AI is a first-class author: `CaseMessage {id, parent_id,
author_type human|ai|system, body, mentions[], reactions[], created_at, edited_at,
deleted_at, ai_meta}`; persist every per-case ChatEngine turn so investigation reasoning is
no longer ephemeral. (C) lightweight `CaseTask` checklists. Upgrade `CaseComment` additively
(id/kind/mentions/tombstone) with migrate-on-read. @mentions fan out via dispatch → inbox (8).
Endpoints: `GET /cases/{id}/activity`, `GET/POST /cases/{id}/thread`, `PATCH/DELETE
.../thread/{msg}`, reactions, tasks. **AI can only RECOMMEND — parity test: an AI message
never closes a case (#3).** All bodies fenced/escaped (#9). *Recommended phasing inside the L:
tags + threaded comments + persisted AI chat first; tasks/checklists second.*

### 5 — Richer posture dashboard (L)
Extend `engine/metrics.compute_metrics` (server-side, over ALL cases, time-bounded — not the
200-case client sample). Add pure fns: `lifecycle_intervals` (MTTA/MTTR/dwell as p50+p90+mean
from `status_history`, honest DASH with labeled reason), `quality_metrics`
(alert→incident ratio, FP rate, escalation/containment/automation rate — **counted**, never
decided), `aging` (buckets, oldest-N, closure-vs-arrival), `sla_metrics` vs operator
`SlaPolicy`, `mitre_coverage` (Case.mitre vs 697-technique corpus → per-tactic % + **ATT&CK
Navigator v4.5 layer export**). Period-over-period `?period=&compare=prev` → `{value, prev,
delta_pct}`. Split `Metrics.tsx` into Operational/Performance/Posture tabs + heatmap +
burn-down. Endpoints: extend `/api/metrics`; `GET /api/mitre/coverage`, `.../navigator.layer.json`.
**Stamp the ATT&CK corpus version**; validate technique ids (#9).

### 6 — Fine-grained permissions (L)
No OpenFGA/SpiceDB/Casbin (new runtime dep). Evolve the pure `can()` along the NIST ladder:
(A) **custom roles + inheritance** (`CustomRoleStore`; role = {name, inherits[], grants,
denies}; cycle-guarded merge; `User.role` stays enum + add `User.custom_roles[]`). (B)
**explicit DENY** (deny-wins; super_admin hard-allowed → no lockout). (C) **opt-in object/row
scope** via pure `can_object(...)` with a whitelisted condition vocabulary (owner/assignee,
source/tenant, severity/time — NO eval; `object_scoping_enabled` default off). Role editor:
clone-from-base, resource×action grid, diff/preview, simulate, last-admin lockout prevention.
Endpoints: `GET/POST/PUT/DELETE /api/roles`, `/api/roles/preview`, `/api/roles/simulate`,
`GET /api/account/permissions`, `PUT /api/users/{u}/roles`. **Sequence BEFORE 4/7/8/9** so
their endpoints gate on narrow resources from day one. RBAC gates *who may call* close
endpoints — never the decision (#3).

### 7 — +15–20 enrichment sources (L)
EnrichmentProvider SPI (foundation #4). Refactor AbuseIPDB/VirusTotal as the first two
providers, then add: **GreyNoise Community, Shodan InternetDB (keyless, default-on), Shodan
host, Censys, BinaryEdge, IPinfo Lite (keyless, default-on), AlienVault OTX, Pulsedive, Spur,
IBM X-Force, Project Honeypot**; multi-indicator via `enrich_indicator(value, kind)` for
domain/hash/url/email (**abuse.ch trio URLhaus/MalwareBazaar/ThreatFox**, VT files/urls/domains,
RDAP+DoH, URLscan, HIBP email). Per-provider TTL + budget guard (free tiers are tiny: Shodan
1 req/s, Censys 1/2.5s, GreyNoise 50/wk). Keyless default-on; paid default-off (manifest
flag). Talos excluded (no API). Endpoints: `GET /api/enrichment/providers`, `GET
/api/enrichment/lookup`, `POST /api/enrichment/providers/{name}/secrets`. All provider strings
(PTR/banner/tags) fenced UNTRUSTED (#9). Advisory only — never `decide()` (#3).

### 8 — In-app notification delivery (M)
Additive `inapp` surface on the KVStore. Per-user **fan-out inbox** (one `InAppNotification`
row per recipient; lifecycle unseen→seen→read→archived powering bell dot vs numeric badge).
An `InAppChannel` self-registers on the NotificationChannel SPI (its `send()` does NO network
I/O — resolves recipients from RBAC/assignee, appends to `InboxStore`), slotting into the
existing dispatch AFTER apply()+save (#3 flow unchanged). Reuse `templates.render()` (same
untrusted-safe renderer, #9). Per-user, per-category×per-channel pref matrix + quiet-hours +
digest. Real-time over the shared SSE channel; `GET /api/notifications` poll fallback.
Endpoints: `GET /api/notifications`, `/unread-count`, `POST /{id}/read`, `/read-all`,
`/{id}/dismiss`, `GET/PUT /api/notifications/prefs`.

### 9 — Standardized/customizable Models page (L)
**Track A (provider/registry):** replace `gateway._provider()` if/elif with a
`PROVIDER_REGISTRY` mirroring the Connector SPI; generalize `OpenAIProvider` to accept
`base_url` (→ vLLM/Ollama/OpenRouter/Together/Groq in one class); add Azure / Bedrock (stdlib
SigV4 reusing the `email.py` HMAC ladder) / Vertex. Widen `Provider` to str + optional
`base_url/api_version/region` on `ModelConfig` (loose JSON, no migration). Replace the
hand-maintained `PRICES` dict with bundled `llm/model_registry.json` (context_window/max_output/
modalities/capabilities + input/output/cache costs) + operator overrides via `PriceOverlayStore`.
Ordered fallback chains + retry/backoff. **Track B (cost governance):** pure `BudgetGate`
(daily+monthly ceilings, soft-warn pct, on_exceed block|warn) checked pre-flight via
`estimate_cost`; on block → `GatewayError` so callers fail to **NEEDS_HUMAN** (never silent
close, #3). First-class **Models admin page**: capability badges, inline-editable price +
provenance badge, per-role/per-rule assignment, editable temp/max_tokens, gateway-metered
**test-call**, live cost estimator, budget burn-down. Endpoints: `GET /api/llm/models`,
`/api/llm/providers`, `POST /api/llm/models/test`, `PUT /api/llm/models/{id}/pricing`, `POST
/api/cost/estimate`, `GET/PUT /api/budget`, `GET /api/budget/status`. Ledger still writes
exactly once per call (#6).

### 10 — Distinctive (less generic) UI (M)
The "generic" feeling = one uniform page template + a whisper-quiet treatment, not the tokens.
Four CSS-only/wrapper layers, token-contract-safe: (1) **opt-in "command" material pack** on
`Preferences.branding` (`material: quiet|command`) adding `--glass-tint/--glow-strength/
--grid-opacity`; `quiet` keeps today's look byte-for-byte; optionally regenerate the dark ramp
in **OKLCH offline under the same HSL token names** (instant premium, zero contract change).
(2) **glass on CHROME only** (`GlassSurface` for sticky header/CommandPalette/sheets) with a
mandatory `prefers-reduced-transparency` solid fallback — never on data tables/KPI tiles.
(3) **page archetypes** (CommandCenter/Worklist/Investigation layouts) to break monotony.
(4) **editorial charts** (gradient area fills, thin strokes) + a display heading treatment.
Distinctiveness stays opt-in so the calm default + WCAG-AA budget are preserved.

### 11 — A useful Standup (M)
Evolve `StandupService` from a backward aggregate into a forward **shift-handoff** report,
keeping #7 (aggregate-then-summarise) intact. Pure `engine/shift_report.py`:
**attention queue** (open + NEEDS_HUMAN + escalated ranked by urgency = risk/severity/age/SLA),
SLA/aging rollup vs per-priority targets, per-analyst workload, period-over-period deltas — all
deterministic, no LLM. Fold into the SAME compact fenced JSON → cheap model (never raw logs,
#7/#9). System prompt leads with "what needs attention this shift." Acknowledge/sign-off +
carried action items (single living list w/ age badges) via `ShiftHandoffStore`. Wire
`Standup.tsx onNavigate` to deep-link the Cases list with a pre-seeded filter. Endpoints:
extend `/api/standup`; `GET/POST/PUT/DELETE /api/standup/action-items`,
`POST /api/standup/acknowledge`, `GET /api/standup/acknowledgements`.

### 12 — Clearer cases + agent-work visualization (M)
(A) **Triage clarity:** replace the 3-panels-all-from-riskScore bug with **4 honestly-distinct
chips** — RISK (0–100 + RiskGauge breakdown), SEVERITY (source-asserted MAX member-event
severity), IMPACT (asset criticality the engine already computes in `risk.py`), PRIORITY
(deterministic ITIL `derive_priority(impact, urgency, matrix)`, advisory only). Each chip gets
a HelpTip showing its inputs. (B) **Agent-work viz:** promote the flat `/trace` into a typed
**ReAct timeline** (OTel GenAI-aligned spans invoke_agent/chat/execute_tool with
step_index/kind/latency/cost/tokens/trusted, joined from audit + usage ledger), and render the
`case_manager` **DECISION as a visually-distinct terminal step** showing the exact (verdict,
confidence, risk_score, policy clause) — turning #3 into a **trust feature**. Optionally
surface OCSF classification + observables (currently dropped in `RawEvent.from_ocsf`).
Endpoints: `GET /cases/{id}/trace?format=otel`, (opt) `GET /cases/{id}/triage`. **Parity test:
`decide()` byte-identical regardless of `priority_level`.** Untrusted trace payloads only in
escaped code blocks (#9 / OWASP LLM05).

### Security fix (ship regardless)
**Invert RAG knowledge fencing to a TRUSTED allowlist.** Operator-imported RAG documents
currently render to the model **unfenced**; an attacker who gets a document imported could
inject instructions. Fix: only built-in/verified corpus is TRUSTED; everything else is fenced
UNTRUSTED. Maps to OWASP LLM01. Small, high-value, no behavior change for legit content.

---

## 3. Build sequence (waves)

- **Wave 0 — Hot-file foundations + perf.** One coordinated pass over `models.py` /
  `config.py` / `constants.py` (all additive fields/enums/models so later waves never re-edit
  the headers) + webui route code-splitting (parallel, no backend touch) + parity-guard tests
  (`decide()` + built-in roles byte-identical).
- **Wave 1 — Shared substrate (build-once).** KVStore stores, EnrichmentProvider SPI (refactor
  the 2 existing providers behind it), RBAC vocabulary split + custom-role/deny resolution, SSE
  foundation + nginx. New files + small coordinated `routes.py` additions (one integrator).
- **Wave 2 — Backend feature logic** on the substrate: metrics/posture (5), shift report (11),
  enrichment providers + budget guard + multi-indicator (7), models registry + budget gate +
  cost endpoints (9), in-app channel + prefs (8), case priority/impact derivation + triage (12),
  custom-role CRUD + preview/simulate (6). All gate on Wave-1 narrow RBAC resources.
- **Wave 3 — webui surfaces** (after backend contracts stable; `AppShell.tsx` single-owner
  first): hamburger sidebar (2) + bell (8) + glass header (10); then independent pages —
  Settings grid (1), Branding presets/material (3,10), Roles/matrix editor (6), Models admin (9),
  Metrics tabs + heatmap + burn-down (5), Standup attention queue + ack (11), CaseDetail 4-chip
  header + TraceTimeline/DecisionStep + thread/activity/tasks (12,4), Inbox + prefs (8),
  Enrichment providers editor (7).
- **Wave 4 — Live wiring + polish.** Stream agent steps + live case activity over SSE (4,12);
  SSE-driven notification badge (8); page archetypes / editorial charts / display type (10);
  WCAG 2.2 audit; optional OCSF surfacing. Final: full `pytest` green (update count), webui
  tsc+vite + Vitest specs green, docs + Journal updated, OWASP-LLM mapping doc, commit + push.

Each wave is built by a fan-out of Opus 4.8 sub-agents (non-overlapping files; shared hot
files sequenced under one owner), then a test fan-out (offline pytest + webui build + Vitest)
before the next wave. Triple-verify: parity guards, route-auth coverage, build, specs.

---

## 4. Open decisions (my recommended defaults in **bold**)

1. **Build cadence:** **autonomous all-waves with a test gate between each wave** (vs approval
   checkpoint after every wave).
2. **Case collaboration depth:** **phase the L** (tags + threaded comments + persisted AI chat
   first; tasks/checklists second) vs full ticket model in one go.
3. **RBAC depth:** **custom roles + inheritance + explicit deny + resource split** now; **defer
   row-level data scoping** (ship the opt-in hook, off) vs include row scoping now.
4. **Enrichment:** **free/keyless-first ~12 providers + multi-indicator (hash/url/domain/email)**
   now; paid providers default-off vs IP-only first.
5. Transport: **SSE, default-OFF, polling fallback** (low-regret default).
6. Models: **include the pre-flight $-budget gate** (over-budget → NEEDS_HUMAN), default
   ceilings off.
7. Reputation fusion: **opt-in (`fusion_enabled=false` default; max() byte-identical)**, flip
   after validation.
8. Priority model: **four distinct header chips** (Severity / Risk / Impact / Priority).
9. Distinctive UI: **opt-in "command" material pack**, calm "quiet" default preserved.
10. OCSF: **surface classification/observables additively now; gate the 1.4→1.8 version bump**
    behind its own follow-up.
11. Notifications: **in-app inbox canonical (always on) + per-category×channel opt-in matrix +
    quiet-hours/digest**; @mention→inbox always.
12. **Ship the RAG-fencing allowlist security fix regardless.**
