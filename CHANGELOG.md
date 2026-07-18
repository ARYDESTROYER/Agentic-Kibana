# Changelog

All notable changes to the **TLSOC Agentic Triage Suite** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project aims to follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
This is a **vendor-agnostic** suite — no single log source is "the" target. Elastic /
Elasticsearch **8.19.12** is the compatibility target only when *optionally* attaching
to a legacy ELK stack as a read-only consumer (the archived Kibana plugin additionally
targeted **8.12.2**; it is now frozen and no longer version-stamped going forward).
History is reconstructed from `git log`.

## [Unreleased] — 2026-07-17 — Auth-lockout hardening

Fixes a total, silent authentication lockout: a transient empty read from the
`UserStore` (its loader swallows read errors and degrades to `[]`) used to flow through
`AppState.refresh_users` → `AuthService.set_users([])`, collapsing the in-memory auth
view to the env base layer alone. On an OOBE-only deployment (no env-seeded admin) that
evicted every persisted account, so every login returned 401 despite an intact,
verifiable password hash — until the process restarted. Backend-only; `decide()` (#3)
untouched.

### Fixed

- `AppState.refresh_users` now treats an empty `users.list()` as a **failed read** and
  keeps the current auth view, unless the raising `UserStore.has_any()` probe
  authoritatively confirms zero users. A transient empty read can no longer evict
  accounts.
- `AuthService.set_users` gained an `allow_empty` guard: an empty update that would drop
  previously-known **stored** accounts is refused (warn + keep the view) unless the
  caller passes an authoritative empty-store signal — a second, independent layer of
  protection.
- `AppState.apply_secrets` now re-folds the persisted user store into the auth view
  after a credential-change `_wire()` rebuild, so an ES-credential change no longer locks
  stored/OOBE accounts out until the next user mutation or restart.
- Preference writes are serialized under a new `AppState._prefs_lock`; a new
  `mutate_prefs(mutate)` performs the read-modify-write **inside** the lock. The source
  routes (`POST/DELETE /api/sources`, `POST /api/sources/{id}/secrets`) use it, so a
  source rename reads the freshest prefs and is no longer clobbered by a same-path
  concurrent write (the observed "rename did not persist"). (Fully closing the
  cross-writer prefs lost-update still needs config-store CAS — tracked separately.)

## [Unreleased] — 2026-07-15 — Backend deep-audit hardening

A multi-agent deep audit of the backend (24 subsystem auditors over ~200 files /
63k LOC, every finding adversarially re-verified against the source) produced **47
verified findings** (0 critical, 10 high, 24 medium, 13 low). All 47 were fixed, each
as its own focused commit with a regression test, on `Testing` (local, not tagged or
pushed). Non-negotiable **#3** was verified clean — `engine/case_manager.py::decide()`
is untouched and no LLM/playbook path can drive close/escalate.

### Security

- The `#9` untrusted-fence seam no longer lets an attacker-set `source=`/`tool=`
  provenance label (e.g. a RAG document's `source`) escape the fence — prompt-injection
  (OWASP LLM01) closed; RAG import sanitises the source at write time.
- Authorization added to state-changing / LLM-billing routes that were authN-only:
  `POST /setup/secrets` + `/setup/complete` (settings:manage), `/cases/{id}/investigate`
  + `/reinvestigate` and `/api/investigate` (cases:reinvestigate), `/api/overview` +
  `/api/chat` (cases:read); case-thread edit/delete is now author-or-moderator scoped.
- OIDC/SSO: the `state` token is bound to the initiating browser (HttpOnly cookie),
  account linking requires a **verified** email and never links onto a local-credential
  account by email alone (SSO takeover / login-CSRF fixed).
- Enrichment providers no longer leak an API key (Shodan/Pulsedive `?key=`) into error
  messages / logs / the UI. JWT decode raises `TokenError` (not a 500) on non-ASCII
  segments. `POST /api/ingest/{source}` caps the request body (413) before buffering.

### Fixed

- **Concurrency:** SessionStore / UserStore / ProposalStore route every mutation through
  the CAS `kv_mutate` (per-store lock + `_rev`), and `KVStore.put_if` gains a real atomic
  compare-and-set in the SQL backend (`SELECT … FOR UPDATE`) — lost updates (incl. a
  silently-dropped session revocation) closed. `notify()` merges `notifications_sent`
  onto the fresh case; the notification dedup key is recorded only after a successful send.
- **Ingestion durability:** object-store & Kinesis receiver cursors persist via
  `CursorStore`; the non-PIT offset drain caps at `max_result_window` (no more permanent
  stall); the poller only handles clusters with a new event this tick (no duplicate
  cases); the cross-source drain sums per-source unused headroom (no starvation) and
  scans only OPEN cases; MQTT acks only after a confirmed ingest; syslog-UDP ingest
  errors are surfaced.
- **Correctness / cost:** MTTA/SLA count only human acknowledgments (not autopilot
  system escalations); stringified-epoch and uppercase-`Z` timestamps parse to the right
  instant; ModSec sub-rules match the real `rule.id`; the OpenAI batch parser subtracts
  cached tokens (no double-billing); `score_to_severity_id` is scale-aware; campaigns
  treat MITRE as an advisory overlay (no over-clustering); the tuner guards
  `severity_floor` per window and records the ledger/audit only after a confirmed write;
  the investigator and per-event overview receive full evidence (`fence_block`, no
  600-char truncation).
- **Resource bounds / observability:** the SSE history topics, in-memory cache fallback,
  rate-limit bucket map, per-signature lock registry, and demo mock-provider call ring
  are all bounded; SSE no longer duplicates frames on reconnect or leaves zombie
  connections after eviction; `SqlUsageRepository.summary` window-bounds in SQL (off the
  budget-gate hot path); the SQL audit scan pages so JSON-only filters don't under-return;
  `ES count()` surfaces live faults instead of masking them as `0`.

### Fixed — Noise-Reduction funnel (2026-07-16, backend-only)

- The durable `NoiseCounterStore` (and the anomaly `BaselineStore`) are now cleared on a
  **source delete** (`DELETE /api/sources/{id}`) and on a **cases / factory reset**
  (`engine/reset.py`), so `GET /api/metrics/noise-reduction` no longer over-reports
  inbound volume from a removed source or a purged period. Both are advisory counters —
  never read by `decide()` (#3) and no `cluster_signature` recompute (#4); the clears are
  fail-open and can never fail the delete/reset.
- The funnel's terminal **Escalated** node now carries every case the agent did not
  auto-clear: `build_noise_reduction` folds the previously-invisible `needs_human` bucket
  and the `true_positive` residual into the `escalated` stage (total + per-severity bands,
  `== cases − auto_cleared`), so the visible outcomes account for every windowed case. The
  standalone `needs_human` stage and the reduction headline are unchanged, and the funnel
  diagram, node set, and API shape are byte-identical (no new node, no query params).

### Release status

- Local gates green (2026-07-14/15): **1942 backend `pytest`** passed (0 failures; +55
  regression tests over the 1887 baseline), **1349 web `vitest` / 240 files**, `npm run
  build` clean, `npm run lint` 0 errors. Working tree clean; **no co-author trailer** on
  any of the 48 commits; **not pushed**.

## [3.0.0-alpha.1] — 2026-07-11 — Bleeding Edge hardening candidate

This prerelease foundation is implemented but **not yet tagged or published**.
It establishes one canonical SemVer identity, truthful runtime/readiness checks,
source-safe ingest/investigation boundaries, a full connector image, CI release
gates, and a GitHub Pages documentation site. Remaining publication blockers are
kept explicit in `docs/releases/known-limitations.md`.

### Added

- Root `VERSION` synchronized across Python, FastAPI/OpenAPI, npm, Compose image
  tags, OCI labels, and public documentation, enforced by `scripts/check_version.py`.
- Liveness, persistence-write readiness, and build-info endpoints.
- MkDocs Material public docs, strict GitHub Pages builds, release-channel policy,
  connector support matrix, architecture, and known-limitations register.
- Default `full` backend image with all advertised connector clients, plus an
  explicit smaller `core` target; non-root runtime and wheel-content smoke tests.
- A bounded four-source live demo (Splunk HEC, QRadar LEEF/offenses, Wazuh JSON,
  RFC 5424/3164), guaranteed and on-demand correlated incidents via
  `POST /api/demo/incident`, per-source health/live-tail telemetry, and a forced
  `$0` mock provider inside the isolated demo stack.

### Fixed

- Push event IDs are deterministic and source-scoped; per-source field mappings now
  apply consistently to webhook, common, and object-store paths.
- Failed persistence is no longer acknowledged as successful: HTTP returns 503,
  Kafka commits only after processing, and S3 notification work is retained.
- Push threshold correlation spans successive callbacks; receiver tasks restart with
  bounded backoff after a retryable processing failure.
- Pull pagination uses PIT + `search_after`, stable tie-breaking, an overlap ledger,
  and source-index-qualified identities; rollover `_id` collisions remain distinct.
- Source-scoped case signatures no longer merge independent systems and migrate an
  open legacy signature in place. Re-investigation is pinned to the stored case and
  originating query source; push-only sources cannot fall back to global Elastic.
- Cap-deferred candidates use the durable case store as a quiet-tick drain queue.
- State readiness now proves write permission instead of reporting connectivity only.
- The daily budget defaults to a hard preflight block at the configured ceiling;
  warning-only behavior is an explicit operator opt-in.

### Release status

- Local candidate gates passed on 2026-07-11: **1887 backend tests**, **1349 web
  tests / 240 files**, lint with 0 errors, all five design gates, generated API
  contract drift, production build, wheel/package smoke tests, canonical version,
  agnostic Compose configuration, and strict MkDocs build. No public release should
  be cut until the license and remaining blockers in the public limitation register
  are resolved or deliberately reclassified.

## [Unreleased] — 2026-07-09 — Round 10: Autopilot & Comprehensive Ingestion + motion.dev

A **behavior-changing** round — **the suite now reads and reasons over everything, and
self-tunes, BY DEFAULT.** Built research (vendor + industry-standards) → code (5
batches) → adversarial verify → fix → re-verify; the verify pass found **5 major + 6
minor** findings, all fixed and re-verified before sign-off. Non-negotiables hold
throughout: `case_manager.decide()` stays the sole close/escalate authority and is
**byte-identical**; `engine/risk.py` and `engine/signatures.py` are **untouched** — the
new comprehensive-ingestion risk gate only *reads* `compute_risk()` to route a
candidate to investigation, it never changes scoring or the decision itself (#3). No
`docs/research/` folder this round (efficiency-first) — see `Journal.md`'s Round-10
entry. Developed directly on `Testing` and subsequently committed.

### Changed — comprehensive ingestion is now the default
- `background_scan_enabled` defaults to **TRUE**: every event from every source is now
  correlated, risk-scored (0–100), and made visible — nothing is silently dropped
  from view.
- EVENTS-role clusters auto-forward to the strong-LLM investigation through a new
  **deterministic risk gate**: `risk_score >= auto_investigate_risk_floor` (default
  **70**). Below-floor clusters stay **$0 candidates** — visible, never dropped (#4).
- ALERTS-role feeds **bypass the gate entirely** and correlate in `mode=EVERY`, so
  every alert becomes exactly one case (same-signature bursts coalesce onto the one
  open case).
- A per-source, per-tick cap — `caps.max_auto_investigations_per_tick` (default
  **25**) — bounds concurrent LLM spend; cap-deferred candidates **drain** to
  investigation on a later tick once headroom frees, never lost.
- Investigations run **sequentially**; the push ingestion path is symmetric with pull;
  the daily budget (below) is the **global** spend bound across all sources.

### Added — autopilot smart defaults
- **Default-ON, $0 / #3-safe:** threshold tuning (`shadow_eval` forced on),
  campaigns, cross-source correlation, SLA policy, priority matrix, realtime SSE, the
  threshold-automation engine (seeded with an empty rule set), and baseline (the
  producer + a new silent-source detector).
- **Still opt-in:** batch LLM processing, warning-only budget mode,
  `run_playbook`/`notify` default automation rules, and baseline-drives-investigation.
- New **`Preferences.autopilot_profile`** dial — `conservative` / `balanced` (default)
  / `aggressive` — scales `(risk_floor, daily_usd, cap)` together: conservative
  **90 / $5 / 10**, balanced **70 / $10 / 25**, aggressive **40 / $50 / 100**.

### Added — default budget backstop
- `BudgetConfig` now defaults **enabled**, `daily_usd=$10`, `soft_warn_pct=0.80`,
  `on_exceed="block"`. An over-budget day routes candidates to **NEEDS_HUMAN** — it
  **never** auto-closes (#3) — so "read everything by default" cannot become "spend
  everything."

### Changed — migration: auto-adopt + one-time banner
- A stored pre-overhaul config **auto-adopts** the new ON defaults behind a new
  `autopilot_config_version` marker and sets `show_autopilot_banner=True`; any
  explicit opt-out an operator made **before** upgrading is preserved verbatim. The
  `AutomationNudge` card is **inverted** — from "turn automation on" to an "autopilot
  is ON — here's what it's doing / turn it off" reassurance card. Migrated tenants
  get the tuner's `shadow_eval` force-enabled the same as fresh ones.

### Added — coverage observability
- Per-source **last-poll snapshot** — `last_poll_at` / `last_poll_ok` /
  `last_poll_error` / `events_per_min` / `silent` — additive fields on
  `GET /api/sources/health`; a source whose feeds **all** raise now correctly reports
  `ok=False` (multi-feed failure detection).
- `AuditDoc.source_id` (+ the ES `AUDIT_MAPPING` keyword field) enables
  `GET /api/audit?source_id=`; a new per-source noise dimension.
- New **`GET /api/sources/coverage`** rollup — `{sources_total, sources_enabled,
  sources_silent, events_per_min, alerts_triaged_24h, worst_last_event_seconds}`.
- webui: a Sources coverage banner + server-truth per-row status, an Overview
  coverage tile, and an honest "awaiting / candidate" stage in the Noise-Reduction
  funnel (below-floor candidates are no longer invisible).

### Added — motion.dev (lazy)
- **ONE new runtime dependency: `motion` 12.42.2** (`framer-motion` was removed in
  Round 5). Loaded behind `LazyMotion` + `m` + `domAnimation` + `MotionConfig
  reducedMotion="user"`, landing in a **LAZY ~83.85 kB chunk** — the entry chunk
  stays **281.44 kB** and never modulepreloads it.
- Animates route/page transitions, the CaseDetail tab-enter, the Cases bulk-bar exit
  + row reflow, the NavSidebar rail, and dashboard KPI count-ups (`AnimatedNumber`
  dynamic-imported into `KpiTile` so it too stays lazy). Reduced-motion is honored
  throughout (count-ups snap instead of animating).

### Standards cited (industry-grounded defaults)
- Risk floor **70** ≈ Elastic entity-risk "High" band start (cross-vendor High
  midpoint ~70). Tuner: `min_samples=30`, Wilson **0.95** lower-bound, modified-z
  **3.5**, bounded **±1** nudge, `target_fp_rate=0.10`. Baseline warm-up **14d**
  (Sentinel UEBA precedent) / modified-z **3.5**. Anomaly-alert threshold **75**
  (Elastic ML precedent). `daily_usd=$10` ≈ a coffee budget, roughly **10×** below
  typical AI-SOC entry pricing.

### Fixed — adversarial verification pass
- The verify pass over the 5 code batches found **5 major + 6 minor** findings; all
  11 were fixed and the fix was re-verified before sign-off.

### Dependencies
- **Added** `motion` **12.42.2** (runtime, LAZY-loaded — see above). **Zero** other
  new deps, backend or webui.

### Verification (2026-07-09)
- Backend **1796 pytest** green (was 1708); webui `tsc + vite build` clean, **entry
  chunk 281.44 kB** (motion lazy-chunk 83.85 kB, never modulepreloaded); **1332
  Vitest** specs / 239 files green (was 1268 / 229); eslint **0 errors** (3 benign
  warnings); `engine/case_manager.py` `decide()` **byte-identical**; `engine/risk.py` /
  `engine/signatures.py` **untouched**; **zero new deps except the deliberate lazy
  `motion`**. Developed and committed on `Testing`.

---

## [Unreleased] — 2026-07-06 — Round 9c: dashboard rebuilt from scratch, real MTTD + first-response MTTR, cleaner Cases

A third follow-up round on user feedback, referencing Prisma Cloud "Cloud Security
Operations Dashboard" and Cortex XSIAM screenshots for visual language. A BE-metrics-
contract agent, a dashboard agent, and a Cases agent worked disjoint files, followed by
a review → adversarial-verify validation workflow and a fix pass (commits `20118a7` →
`ceba59d` → `c4d1bb6` → `2cc94c5`). Shipped: real **Mean Time To Detect**
(`Case.first_seen_millis`, stamped at case-creation from the originating cluster, feeds
`lifecycle_intervals.mttd_minutes`, skipping backdated negatives) and **Mean Time To
Respond as the first HUMAN response** — the acknowledge/ACK clock (assigning,
investigating, escalating, or putting a case on hold all count), deliberately **not**
the dwell-to-resolution clock, which the validation pass caught crediting an AI
auto-close as a "human response"; a burndown chart (opened-vs-resolved per day) and a
per-day timing trend (MTTD/respond/resolve, null-gapped rather than fabricating zeros);
the **Overview rebuilt Prisma-style** (a 5-tile KPI micro-strip → a hero row of Active
Risk Index + a resolved-cases donut + an open-cases donut, each with a real
previous-window trend delta → the full-width Noise-Suppression ribbon, now flowing
`ingested → clustered → cases → auto_cleared → escalated → closed` with a new terminal
**"closed by human"** stage → a burndown/timing/top-open-cases row, with secondary
detail folded into a shallow "Deeper analytics"); and a cleaner **Cases** list (a
6-tile incident-summary strip, a calm 2-tier toolbar, a monogram Assignee column). All
of it is advisory/read-time — `decide()` never reads the new timing fields (#3). The
validation pass fixed 5 findings: the Respond-clock honesty bug above; a reopened-case
guard so a stale terminal `status_history` entry on a since-reopened case can't corrupt
burndown/MTTR/resolve-trend; the Noise ribbon's overlapping terminal outcomes
(auto-cleared/escalated/closed can co-occur, so shares summed past 100%) now normalized
so the ribbon tiles the cases node exactly; and two WCAG-AA contrast fixes (the
Overview SLA chip + autonomy tiles, and the Cases "Needs human" tile's tone). Additive;
`decide()` **byte-identical**; **zero new runtime deps**. Green: **1708 pytest / 1268
Vitest (229 files) / build clean (entry 279.32 kB, gzip 82.55 kB) / lint 0 errors (3
warnings)** / all 5 design gates pass. Developed on `claude/ui-ux-improvements-7nq5be`
(off `Testing` `1ab98f2`), merged into `Testing` via **PR #27** (`559ce88`, current
HEAD). See `Journal.md:1474-1482` — Rounds 9/9b/9c have no `docs/research/` folder
(done efficiency-first, without the research-brief fan-out).

## [Unreleased] — 2026-07-05 — Round 9b: dashboard reimagine, hover-to-expand sidebar, CaseDetail Timeline/Investigation split

A second follow-up round on user feedback to Round 9, run efficiency-first (3 focused
disjoint-file agents, no research fan-out). Shipped (commits `71153f2` → `283aa59` →
`b0d8747`): a **hover-to-expand sidebar** — the collapsed rail hover/focus-expands into
a floating drawer overlay without reflowing the page (the rail keeps its 64px
footprint); the Noise-Reduction widget **reverted from Round 9's flat stage-bars back
to a flow ribbon** (per user preference — prettier, with per-stage hover detail:
count/%/meaning/severity mini-breakdown) and the "LLM Spend" tagline removed; the
Overview reorganized into a dense multi-zone grid (KPIs → response timing [MTTA/MTTR/
Dwell from posture p50, MTTD honestly shown "n/a" — not yet fabricated] → noise →
attention-queue + severity + outcome-donut → top lists) with only a shallow "Deeper
analytics" fold; and **CaseDetail** redesigned — Timeline is now "what happened" only
(a new `TimelinePanel`), a separate Investigation tab holds the AI assessment + pinned
`DecisionCard` + full ReAct trace, the case Sheet widened to
`max-w-[min(98vw,1400px)]`, an "Open in new tab" button (wired `router.optsFromHash()`
to parse `caseId` so a fresh tab boots straight into the case), and the Overview redone
as a Decision-Brief hero → SOURCE SAYS/AGENT FOUND/CODE DECIDED provenance row →
primary-entity/attack-story/relationship row → evidence-checklist + reproduce →
Related/Provenance collapsibles. No backend change this round. Additive; `decide()`
**byte-identical**; **zero new deps**. Green: **webui 1264 Vitest (228 files) / build
clean (entry 279.3 kB) / lint 0 errors**; backend pytest unaffected (unchanged from
Round 9's 1696). Developed on `claude/ui-ux-improvements-7nq5be`, merged into `Testing`
via **PR #26** (`749bce6`). See `Journal.md:1467-1472`.

## [Unreleased] — 2026-07-05 — Round 9: 11-ask UI/UX overhaul + local LiteLLM model provider

An 11-ask UI/UX overhaul on a new branch `claude/ui-ux-improvements-7nq5be` (created
off `Testing` HEAD `1ab98f2`), built via a 12-agent research + codebase-mapping fan-out
(QRadar/Splunk ES/Sentinel/Elastic/Chronicle/XSIAM dashboard patterns + Prophet/
Dropzone + LiteLLM/vLLM/Ollama/OpenWebUI/Jan + login/wizard/dataviz UX) → design briefs
→ parallel implementation agents on disjoint files → 3 full test passes → a 4-agent
adversarial validation → a fix pass (commits `709e758` → `d13b6f0` → `1adc5ce` →
`26c4266`). Shipped: removed the redundant in-page tab strips that duplicated the left
nav (Overview `Dashboard|Standup`, Workspace `Chat|Investigate`, Intelligence
`Knowledge|Memory|Playbooks` — each host now renders its active sub-view via the
existing `tab` route option, no registry change); **Overview** — LLM Spend off the
hero (replaced by 5 alert/case KPIs; spend demoted to a "Deeper analytics" tripwire), a
bigger notched Active Risk Index card, and tightened rhythm to fill the wide screen;
**Noise-Reduction redesigned** — the Round-8 Sankey ribbon (wrong shape for a linear
reduction) replaced with clean horizontal aligned stage bars plus a part-to-whole
disposition row (kept `deriveFunnel()`/testids/`onStageClick`); **Sources** rebuilt
from a card list into a QRadar-style "Log Source Management" `DataTable` (search/
filter/"+ New Log Source"/columns-gear/bulk-select/inline Enabled switch/Status dot/
Last Event via a new `api.sourcesHealth()` over the existing `GET /api/sources/
health`); **CaseDetail** — the Investigation tab renamed **Timeline** (a what-happened
narrative plus a collapsible full ReAct trace) and Overview split into "Reported by
source" vs. "Our assessment" provenance sections with a disagreement delta and the
pinned deterministic `DecisionCard` as trust anchor; **Login**/**Wizard** polish
(top-aligned login card, SSO folded into the paint gate, a faithful non-clipping
branding preview, a pre-paint theme stamp; the Wizard dropped marketing cards and a
double hero for a light numbered stepper); and a new **local/self-hosted LiteLLM
(OpenAI-compatible) model provider** — reuses the existing `openai_compatible` gateway
path with a zero-migration custom-models KV store, `POST/DELETE /api/llm/models/
custom`, a non-metered `POST /api/llm/providers/test` reachability probe, $0 pricing,
and an optional `litellm_api_key` secret (env `LITELLM_API_KEY`, or omitted for a
no-auth local endpoint) — all surfaced through a new "Add local model" UI dialog
(base_url + model id + optional key + "Fetch models"). The validation pass also fixed
a **pre-existing
bug**: the shared `POST /api/sources` was rebuilt from a payload that lacked
`configured_secrets`/`created_at`, so every enable/disable toggle, bulk action, or
make-primary call silently wiped a source's secret-name list and reset its creation
date — now both fields carry forward, with a regression test. Additive; `decide()`
**byte-identical**; ledger one-write-per-call (#6) preserved; attacker-influenceable
values fenced/plain (#9); **zero new runtime deps**. Green: **1696 pytest / 1252
Vitest (227 files) / build clean (entry 278.7 kB) / lint 0 errors (3 warnings)**;
design gates + `tsc` clean. Merged into `Testing` via **PR #25** (`a69233b`). See
`Journal.md:1457-1466`.

## [Unreleased] — 2026-07-05 — Round 8: UI cleanup + glitch fixes (from user feedback)

A follow-up polish round on `feature/round7-ui-overhaul` (commits `58745fa`, `f56f812`)
driven by user screenshots. Process: opus plan fleet → **sonnet-only** research fleet →
Wave A (10 opus agents, disjoint files) → Wave B (Overview integration) → 10-agent
adversarial QA (**0 findings**). Shipped: the **Active Risk Index** back in its own card
top-right with the glitchy notch dropped; the **Cases** sticky-header glitch fixed
(double-nested-overflow root cause → non-sticky header + uniform rows); the **Noise
Reduction** funnel redesigned as a **horizontal QRadar-style Sankey ribbon** (reuses
`deriveFunnel()` + the `/api/metrics/noise-reduction` contract unchanged); the **Security
Command Center** header de-carded to a plain big title (Sources-style) with an inverted-
pyramid "Deeper analytics" collapse; **CaseDetail** Overview/Threat tabs deduped and the
**Chat** tab rebuilt on the shared `ChatPanel` (−~150 lines); **Collaboration** tidied;
app-wide **PageHeader** title bump + a 12-page spacing sweep; and **reinvestigate** fixed to
rebuild from a case's stored evidence when the log window has aged out. Additive; `decide()`
**byte-identical**; ZERO new deps. Green: **pytest ✓ / Vitest 1238 / lint 0 errors / build ✓**.
See `docs/research/2026-07-round8/IMPLEMENTATION.md`.

## [Unreleased] — 2026-07-05 — Round 7: Security Command Center overhaul + Noise-Reduction funnel

A UI/UX + product round (12 user changes + 1 feature) on `feature/round7-ui-overhaul`
(commits `850600f` → `1b9ac90` → `e40f0bc` → `7355a9a`). Built by a ~130-agent pipeline
(document → plan → verify → UX research → validate → implement in 3 waves → adversarial QA →
fixes). Headlines: Overview reborn as the **Security Command Center** (Active Risk Index with
a `(?)` explainer, honest **MTTA/MTTR/Dwell** tiles, live-delta KPIs, Top-Contributors); a
durable-counter **"Noise Reduction"** alerts→cases funnel (`GET /api/metrics/noise-reduction`);
**Cases** severity-column bug fixed (one source-asserted Severity + a `source|ai|code`
**provenance** tag); **CaseDetail** retold as a clean story (8 tabs → 5: facts → AI assessment
→ pinned deterministic `DecisionCard`); feedback folded into the close dialog; an **Auto-closed
by AI** badge; and a real motion system (count-up/reveal). Additive; `decide()` **byte-identical**;
zero new runtime deps. The final adversarial QA caught + fixed 8 real bugs (incl. two
funnel-correctness bugs the green tests had masked). See `docs/research/2026-07-round7/`.

## [Unreleased] — 2026-07-02 — Round 6: fleet glitch-hunt + integration polish (464 adversarially-verified findings fixed)

A sixth round driven by a ~500-agent Opus fleet: every webui source file audited
(155 units incl. 12 thematic deep-dives + 4 API-contract audits), every finding
adversarially verified (466 claimed -> 464 confirmed -> 423 fixed, 47 refuted at
verify/fix time), fixes applied in 30 conflict-free exclusively-owned batches +
a handoff/closer wave. Flagship: the custom-dashboard view-mode stacking bug
(pure `packWidgets` + curated per-role default layouts), PageContainer as the ONE
width authority across all pages, CaseDetail PATCH 405s, the rules version ledger
made real (rollback live), anomaly-rule saves persisted, SecretField unification
(+ per-source connector secrets no longer dropped), honest KPI deltas, WCAG-AA
contrast in both themes, and the new beginner `AutomationNudge` (one-click
recommended automation; #3-safe). Additive wire changes only; `decide()`
byte-identical. Green: **1613 pytest / 1051 Vitest (199 files) / lint 0 errors /
entry 281.6 kB / zero new deps**. See `docs/research/2026-07-round6/IMPLEMENTATION.md`.

## [Unreleased] — 2026-07-02 — Round 5: UI/UX overhaul (cohesive color system + ONE shadcn/Radix design standard), Settings declutter, denser wide dashboard + compact hero, rules customization, custom dashboards, loose coupling, a11y + adversarial audit

A fifth multi-wave round — **"UI/UX overhaul + rules customization + custom dashboards +
loose coupling"** — delivering **9 goals (G1–G9)** plus a **16-dimension adversarial audit**
across **12 commits** (`5ab7c05`…`05552c7`). The round is overwhelmingly a **webui**
overhaul with a **surgical, path-byte-identical** backend surface for rules, dashboards, and a
zero-bill decision-preview. Non-negotiables hold throughout — **`case_manager.decide()` is
BYTE-IDENTICAL** vs the pre-Round-5 baseline `27f0983` (CI diff guard; G6's Test/Preview uses a
NEW read-only wrapper over the pure `decide()` and NEVER re-implements it, NEVER bills the LLM);
**#6** stays one ledger write per real LLM call (no preview/what-if/dashboard/widget path calls
the model — `POST /api/triage/preview-decision` asserts zero `UsageDoc` writes); **#2** (append-
only audit on every rule create/edit/enable/disable/rollback + auto-close change), **#9**
(untrusted → plain text / SVG `<text>` / code block on every new rule/widget/dashboard/view
name + value), and **#10** (secrets = booleans via the new `SecretField`) held on every new
surface; **`PUT /api/settings` stays a deep-MERGE** (round-trip test proves no sibling block is
wiped by any new section) and **all API paths are byte-identical** across the router
decomposition. The webui shed a runtime dep on net (**removed `framer-motion`**, added
**`react-grid-layout`** loaded LAZILY only in dashboard edit-mode); the backend adds **zero new
runtime deps**. The backend offline suite grew **1461 → 1601 tests green**; the webui `tsc +
vite build` is GREEN (entry chunk **537 kB → 264 kB** with `React.lazy` code-splitting restored)
with the Vitest harness expanded **273 → 625 specs** (eslint clean — 0 errors, 4 warnings; the
`jsx-a11y` findings driven **48 → 0**). New here? See [`docs/HANDOFF.md`](docs/HANDOFF.md) and
`docs/research/2026-07-round5/` (`PROPOSAL.md` + `DESIGN_STANDARD.md` [the canonical spec] +
the `understand/` maps + `RESEARCH_*.md` + `IMPLEMENTATION.md` + `AUDIT_FINDINGS.md`). Developed
on the `Testing` branch.

### Added — G1: cohesive color & type system (`0e99c76`)
- A single **Radix slate + blue** foundation with **3 orthogonal semantic axes** — severity /
  status / verdict — each split into `token` / `-foreground` / `-text` triples with **MEASURED
  WCAG-AA contrast in both light and dark themes**; **Okabe-Ito** colour-blind-safe chart ramps
  + a viridis sequential scale; self-hosted **Inter** (variable) + **JetBrains Mono** typefaces.
- The token authority is `label → token`: a domain label (a severity/status/verdict) resolves
  to its token, and components consume the token — never a raw hex.

### Added — G2: ONE consistent design standard (`9854c36`, `3e447da`)
- **shadcn/Radix/Tailwind** enforced end-to-end: shared low-level primitives + **ONE card
  grammar** + the `label → token` authority, adopted across the pages by a **codemod** so every
  surface speaks the same visual language. ~15 new shared components/primitives landed:
  `Field` · `SegmentedControl` · `ConfirmDialog` · `NumberField` · `LabeledSlider` ·
  `SecretField` · `TagInput` · `IconButton` · `PageContainer` · `TimeRangePicker` ·
  `DashboardGroup` · `collapsible` · `typography`, plus the split-out CaseDetail parts.
- **CaseDetail god-file split** — `4210 → 1529` LOC (extracted into focused subcomponents; no
  behaviour or contract change; the unified Close-with-disposition still posts the existing
  close → `decide()`, #3).

### Changed — G3: Settings decluttered (`7c86706`)
- The **2673-line Settings god-file** became a **data-driven registry + `pages/settings/*`
  section files** — `575` LOC of shell over per-section modules; **6 → 5** nav groups with
  **Security promoted to a top-level group**; **≤2 nesting levels**; **33 redirect tests**
  preserving every deep link (`#/settings?s=<id>`, the standalone `#/users`/`#/security`, the
  `detection-correlation` / `advanced-suppression` / `tuning-policy` anchors). `PUT /api/settings`
  deep-MERGE intact (each section sends only its changed keys).

### Changed — G4/G5: denser wide dashboard + compact hero (`f50e0b2`)
- **G4** — the dashboard uses more real-estate: a `PageContainer` wide/fluid mode killed the
  `max-w-[1400px]` cap and moved to a **three-zone layout**.
- **G5** — the **compact hero**: the ~176px `HeroPanel` merged into a **~52px `PageHeader`**.
- **KpiTile** delta rendering corrected to key off the delta's sign (bug).

### Added — G6: rules customization (`b661bc8`)
- A **Detection & Rules** home spanning **3 rule tiers** — detection-match / threshold ·
  anomaly / baseline · case-automation — over a **polymorphic editor** with a **flat condition
  builder**. A **Test / Preview vs. recent data** panel that **NEVER calls `decide()`** and
  **NEVER bills the LLM** (backed by the new read-only `POST /api/triage/preview-decision`
  wrapper over the pure `decide()`); a **version ledger + rollback** (`stores/rule_versions.py`);
  threshold `NumberField` / `LabeledSlider`; asset / SLA / priority / suppression editors.
- Backend `api/routes_rules.py` + `stores/rule_versions.py`; new webui `soc/rules/*`.

### Added — G7: custom dashboards (`830e836`)
- A **widget registry reusing the existing tiles/charts**, a **per-user drag/resize grid**
  (`react-grid-layout`, loaded **LAZILY** only in edit-mode), a **zero-migration `DashboardStore`**
  (`stores/dashboards.py`, KV-doc, no new index/table), **per-role defaults + clone-to-customize**.
- `UserPrefs.dashboards` + `CustomizationConfig.default_dashboards`; backend
  `api/routes_dashboards.py`; new webui `soc/dashboard/*` + `pages/Dashboards.tsx`.

### Changed — G8: loose coupling (`d3801f9`)
- A single **`FEATURES[]` registry** (`soc/registry.ts`) now derives **nav + routes + command
  palette** from one source; `useNavigate()` replaces the `onNavigate` prop-drill; **`React.lazy`
  code-splitting restored** (entry bundle **537 → 264 kB**). `routes.py` **decomposed into
  domain routers** — **all API paths byte-identical**. A generic `EntryPointRegistry`, `Protocol`
  narrowing, and **`openapi-typescript` type generation** for the client types. Typed config
  endpoints added (baseline / campaign / batch). New `soc/hooks/*`.

### Added / Fixed — G9: accessibility + adversarial audit (`a9e2b49`, `8b91fc0`, `05552c7`)
- **Accessibility** — `SEMANTIC_ICON` non-color signalling (never colour alone), **WCAG-2.2**
  criteria, **`jest-axe`** wired into the harness, **20 `jsx-a11y` rules at error** (findings
  **48 → 0**), `Field` labels associated throughout, flaky tests stabilized.
- **16-dimension adversarial audit** (`AUDIT_FINDINGS.md`) → **23 findings, 9 must-fix — all
  resolved with regression tests:** **C1** (custom dashboards couldn't persist), **H2** (rules
  verdict case-sensitivity bug), **H3** (a dashboards path billed the LLM), **H4** (19 unnamed
  comboboxes → accessible-name), plus **M1–M4**.
- **Polish (P1–P18)** — a page-consistency sweep across the surfaces.

### Fixed — long-standing bugs surfaced by the understanding maps + the audit
- **Auto-close dead-field** — the flagship auto-close toggle in Settings wrote a field
  `decide()` never read (it did nothing); it now writes `prefs.auto_close`, the exact field
  `decide()` already reads — so the toggle finally works, with `decide()` itself byte-identical.
- **KpiTile** delta-by-sign; **wizard** cosmetic demo toggle; **clipboard-over-http**;
  **misc-prefs clobber**; **automation** impossible-verdict; **roles** permission mismatch;
  **no-confirm destructive close** (now `ConfirmDialog`-gated); **campaigns** read-permission
  gate; the dead **`initAdmin`** stub; the **`request_approval`** dead-end; the **tuning** row
  always showing "Active"; a **SQL sort** no-op; and a **`derive_priority`** disagreement.

### Dependencies
- **Removed** `framer-motion` (zero importers). **Added** `react-grid-layout ^2.2.3` (runtime,
  loaded LAZILY in dashboard edit-mode only). Dev-only additions: `@fontsource-variable/inter`,
  `@fontsource/jetbrains-mono`, `@tailwindcss/container-queries`, `openapi-typescript`,
  `jest-axe`/`@axe-core`, `eslint-plugin-jsx-a11y`. **Backend: zero new runtime deps.**

### Verification (2026-07-02)
- Backend **1601 pytest** green (was 1461); webui `tsc + vite build` clean, **entry chunk
  264 kB** (was 537); **625 Vitest** specs green (was 273); eslint **0 errors** (4 warnings);
  `route_auth_coverage` green; the design-gate green; **`engine/case_manager.py` `decide()`
  BYTE-IDENTICAL** vs `27f0983` (#3 held throughout); **#6 / #9 / #2 / #10 upheld**; `PUT
  /api/settings` deep-MERGE intact; **all API paths byte-identical**. Developed on `Testing`
  (LOCAL only, NOT pushed).

---

## [Unreleased] — 2026-07-01 — Round 4: multi-source poller fix, adaptive threshold auto-tuning, two-tier alert/event ingestion + campaign correlation + entity baseline, batch/flex + corrected model catalog, unified logs, tiered reset + fresh OOBE, login white-label

A fourth multi-wave round — **"fix the logic, fine-tune the product"** — delivering **3
confirmed bug fixes + 12 user requests** across 7 waves (W0–W6). Every wave was **additive**
and **default-OFF** with **zero new runtime dependencies** (the poller manager, threshold
tuner, campaign/baseline engines, event-detection funnel, batch providers, reset engine, and
all new KV stores are Python standard library; the webui composes the already-vendored
radix/shadcn stack). New stores are KV-doc (no new index/table/migration); new model fields
default so old persisted docs load unchanged. The non-negotiables hold throughout — in
particular **`case_manager.decide()` / `apply()` is byte-identical** (guard test): every new
capability that produces a case (the batched EVENT-detection funnel, the multi-source poller,
campaign correlation) re-enters the **same** correlate → decide pipeline and NEVER calls
`decide()` itself or reassigns a `cluster_signature` (#3/#4); the threshold tuner is a
config-writer that never imports `decide()` / risk weights / signatures (#3); **#6** stays one
LLM-gateway ledger write per real call (batch results are billed exactly-once via an atomic
claim-before-bill); **#7** (aggregate-then-summarise) and **#9** (untrusted fencing) held on
every new source/AI-influenceable value. The backend offline suite grew **1234 → 1461 tests
green** (W0 1235 · W1 1253 · W2 1263 · W3 1371 · W4 1437 · W6 1461); the webui `tsc + vite
build` is GREEN with the Vitest harness expanded **205 → 273 specs** (eslint clean, 0
`react-hooks/rules-of-hooks` errors). New here? See [`docs/HANDOFF.md`](docs/HANDOFF.md) and
`docs/research/2026-07-round4/`. Developed on the `Testing` branch (commits `3aeab6c`…`1df27ac`).

### Fixed — the 3 confirmed bugs
- **Single-source poller** — the poller only ever polled the primary source. NEW
  `engine/poller_manager.py` (`PollerManager` *is* `state.poller`) fans out over **every**
  enabled PULL source, each with its own connector (`es_client_for_source`, mgmt key forced
  `None`, #1), its own `{source.id}:{feed.id}` durable cursor (plus a legacy-`"primary"`-cursor-
  collision guard so two un-fed sources never stomp the shared cursor), its own entity strategy,
  and owned-client cleanup on rebuild/stop. The 0/1-source path is byte-identical. (#4)
- **`claude-opus-4-8` mispriced** — corrected **$15/$75 → $5/$25** across `llm/pricing.py` +
  `llm/model_registry.json` (incl. cache tiers + a 200K → 1M context bump), and broadened the
  Anthropic family; prompt-cache pricing is now applied (cache read 0.1× / write 1.25× 5m /
  2× 1h) and batch 0.5×; wired the previously-dead `providers.with_retry()` around the raw
  Anthropic/OpenAI HTTP calls.
- **`acknowledge`** — now transitions a case to `CaseStatus.INVESTIGATING` (a non-terminal
  status, not a close) and stamps `acknowledged_at`; previously it set the status to `None`.

### Added — Wave 1: hot-file contracts (`41ee54b`)
- Additive `UsageDoc` cache/batch fields; new `Campaign` / `CampaignEntity` / `BaselineState`
  (Welford + EWMA + t-digest) / `BatchJob` / `DetectionRule` models; `ActionType.{TUNING,RESET}`
  + 4 enums (`CampaignStatus` / `BatchJobState` / `DetectionSource` / `ResetScope`) + 4 KV
  namespaces (campaigns / baseline / batch_jobs / tuning). `Preferences.{threshold_tuning,batch,
  baseline,campaign}` + `caps.max_concurrent` + `BrandingConfig.login_*` (bounded plain-text,
  a validator rejecting any `<`, #9), all defaulted. `AutomationRule` → **`CaseAutomationRule`**
  with a module alias (wire key `threshold_automation` round-trips verbatim). `Case` gains
  advisory `campaign_id` / `detection_source` kept OUT of `case_manager.py`.

### Added — Wave 2: PollerManager (`f7509a3`)
- The multi-source poller bug fix above, with a per-manager fan-out under a
  `caps.max_concurrent` semaphore and a per-tick in-flight guard keyed on `cluster.signature`;
  `state.poller` becomes a `PollerManager` owning N per-source `Poller` children while still
  exposing `start` / `stop` / `poll_once` / `_source`.

### Added — Wave 3: engine capabilities (`b07f172`)
- **Adaptive threshold auto-tuning** — `engine/threshold_tuner.py` + `stores/tuning.py`: a
  nightly deterministic observer (per-rule FP via Wilson lower-bound + min-samples + EWMA) that
  bounded-bumps a correlation rule's `n` / a feed's `severity_floor` with an `ActionType.TUNING`
  audit + one-step rollback + a shadow-eval that blocks any change which would have hidden a
  confirmed TP; suppression DROPs route to a HITL Proposal. It is a config-writer only and
  **never** imports `case_manager` / `decide` / risk weights / signatures. **Default OFF.**
- **Daily campaign correlation** — `engine/campaigns.py` + `stores/campaigns.py`: a
  deterministic shared-entity graph of cases (≥2 cases + ≥1 shared entity → an idempotent
  `Campaign`) that only *references* `case_ids` — never re-clusters or closes (#3/#4).
- **Entity baseline** — `engine/baseline.py` + `stores/baseline.py`: online EWMA mean + EWMV
  variance per `cluster_signature` over 168 hour-of-week buckets (α from a 14-day half-life),
  a bounded t-digest (p50/p95/p99), robust modified-z |M|>3.5, warm-up 3× period; a pure
  deterministic producer that never reads `decide()` / risk weights.
- **Two-tier alert/event ingestion** — `engine/event_detection.py`: a cheap-first EVENT-feed
  funnel (pre-aggregate → deterministic rules → anomaly [baseline] → batched Haiku detection,
  #7 aggregate-only, #9 fenced) whose survivors **re-enter the same correlate pipeline** and
  reach the same `cluster_signature` (#4) + the unchanged `decide()` (#3) + `engine/forwarding.py`
  (`explain_forwarding`, a read-only forwarding explainer).
- **Batch/flex + cache economics** — `pricing.cost_for` applies cache/batch rates (non-cache
  path byte-identical); `providers.py` extracts Anthropic/OpenAI cache tokens + an OpenAI
  `service_tier='flex'` opt-in; NEW `llm/batch.py` `BatchProvider` SPI (Anthropic
  `/v1/messages/batches` + OpenAI `/v1/batches`, results UNORDERED → keyed by `custom_id`) +
  `stores/batch_jobs.py` (resume-safe, exactly-one UsageDoc/result at 0.5× batch, #6).

### Added — Wave 4: API surface + runtime wiring (`11ea46e`)
- **6 new routers** mounted under `require_auth`: `routes_tuning` (recommendations dry-run +
  config + apply/rollback, `ActionType.TUNING` audited, shadow-blocked → HITL Proposal),
  `routes_campaigns`, `routes_baseline`, `routes_batch` (read-only, secret-free), `routes_reset`,
  and the public-allowlisted `routes_setup`.
- **Tiered reset** — `engine/reset.py` + `POST /api/admin/reset {scope,confirm}` (admin +
  `require_fresh_auth`, type-to-confirm): a cases tier clears cases/campaigns/baseline/inbox/
  collab/batch-jobs/live-tail but **keeps the cost ledger + audit**; sources tier adds
  sources/cursors; factory tier adds users/sessions/prefs/roles/proposals/memory/branding and
  flips `setup_complete=false` → OOBE. **Env secrets are byte-identical across every tier**
  (airtight test); audited before acting (#2).
- **Fresh OOBE** — `routes_setup.py`: `GET /api/setup/status` + `POST /api/setup/account`
  (public, self-locking first-super_admin, forced strong password ≥12 / ≠ username / not-common,
  MFA prompted-optional).
- **Unified logs** — `GET /api/logs` scatter-gathers browse-capable sources
  (`asyncio.gather` + per-source `wait_for`, mandatory source provenance, secrets never
  returned, read-only #1) + `GET /api/cases/{id}/forwarding` + `GET /api/sources/health`.
- **Gated schedulers** — nightly tuner / daily campaign / batch-jobs poller spawn-but-sleep
  when disabled (byte-identical default-off boot); EVENT-feed routing to the funnel engages
  only when batch + baseline are both enabled (default-off = the existing realtime path,
  byte-identical); demo / kill-switch gate it off.

### Added — Wave 5: webui surfaces + consolidation (`3c68cf5`)
- A `UnifiedLogsSheet` (10s live-tail + partial-failure strip, #9 plain-text); a **Tuning**
  page (recommendations + apply/rollback + config, honest "only changes what's investigated,
  never closes" framing, DROP → Approvals) + **Campaigns** page + `CampaignChip`; **Baseline**
  warm-up gauges (n/target + p50/p95/p99) + a **Batch jobs** viewer; a cleaner **CaseDetail**
  (single primary CTA + a unified Close-with-disposition dialog that posts the existing
  close → `decide()`, #3); an **analytics declutter** (Cost as the single home); a **login
  white-label** (`BrandHero` renders `BrandingConfig.login_*` bounded plain-text + curated
  layouts, no raw HTML/SVG, #9) + an OOBE account-setup step; **Models** catalog cache/batch
  pricing columns; a **DangerZone** reset panel (3 tiered type-to-confirm cards, super_admin,
  env-secrets-preserved copy). (`vitest 214 → 273`; lint 0 rules-of-hooks; backend untouched.)

### Fixed / Security — Wave 6: adversarial audit + harden (`1df27ac`)
- A **16-dimension adversarial audit** found **16 confirmed / 4 refuted** findings (2 HIGH, 6
  MEDIUM, 8 LOW), all fixed + regression-tested (+24 tests):
  - **HIGH (poller concurrency, #4)** — a per-`cluster_signature` `asyncio.Lock` on the ONE
    pipeline now serialises `find_open_by_signature` → save across the fan-out, so concurrent
    sources/ticks create **exactly one** case; the fragile in-flight monkeypatch was deleted for
    a per-manager `_poll_lock` serialising whole ticks (loop vs manual `/api/poll`).
  - **MEDIUM** — batched EVENT-detection now **really** creates cases (survivors persist as
    `BatchJob.candidates` and re-enter via `register_candidate` + `investigate_cluster` → same
    `cluster_signature` #4, unchanged `decide()` #3); the tuner shadow-eval now pages
    CLOSED + RESOLVED so it isn't blind to RESOLVED TPs, and is cadence-gated (bumps once/window);
    the OpenAI prompt-cache is no longer double-billed; the legacy public `/api/setup/init-admin`
    (which bypassed the strong-pw policy) was **removed** — the sole first-admin writer is now the
    policy-enforced `/api/setup/account`.
  - **LOW** — batch `process_results` dedup is now an atomic CAS claim-before-bill (#6
    exactly-once under concurrency); setup self-lock fails safe + is race-safe; the t-digest
    centroid count is bounded (~O(compression)).

### Notes
- **Terminology cleanup (UI/docs only; wire keys + aliases kept)** — event / detection / alert /
  case / campaign; "correlate" → Auto-investigate / clustering / campaign-correlation; "rule" →
  detection-rule / case-automation (`AutomationRule` → `CaseAutomationRule` alias; the stored
  `threshold_automation` wire key is unchanged and round-trips verbatim).
- **Two-tier ingestion, in one line:** ALERT feeds = realtime per-alert (+ daily campaign
  correlation); EVENT feeds = batched agent-driven detection creating candidate cases that
  re-enter the same deterministic pipeline. Both new subsystems are **default OFF**.
- **Deferred / known:** admin-page consolidation-redirects (#4 — the pages work + deep-link
  standalone) and a dead `api.setup.initAdmin` webui stub (never called; live OOBE uses
  `/api/setup/account`).

---

## [Unreleased] — 2026-06-30 — Round 3: shared KV substrate, EnrichmentProvider SPI, custom-role/deny RBAC, SSE EventBus, posture/MITRE-coverage metrics, shift report, in-app notifications, Models page + BudgetGate, case collaboration, triage chips + trace

A third multi-wave round delivering **12 user requests** ("useful, distinctive, fine-grained")
across Waves 0–4 plus one ship-regardless security fix. Every wave was **additive** with
**zero new runtime dependencies** (the SSE bus, the SigV4 Bedrock ladder, the enrichment
SPI, the budget gate, and all the new KV stores are Python standard library; the webui
composes the already-vendored radix/shadcn/framer/recharts/cmdk). New stores are KV-doc
(no new index/table/migration); new model fields default so old persisted docs load
unchanged. The non-negotiables hold throughout — in particular **`case_manager.decide()` /
`apply()` is byte-identical** (guard test): the new `BudgetGate` is a pure **pre-flight**
that fails safe to NEEDS_HUMAN and is **never** an auto-close path; **#6** (one LLM-gateway
ledger write per real call — the budget gate raises *before* the call and *before* any
write); **#7** (Standup stays aggregate-then-summarise); and **#9** (every new
log/source/operator/AI-influenceable value is fenced before a prompt and escaped in the
UI). The backend offline suite grew **794 → 1142 tests green**; the webui `tsc + vite
build` is GREEN with the dev-only Vitest harness expanded to **181 specs** (eslint clean,
0 `react-hooks/rules-of-hooks` errors). New here? See [`docs/HANDOFF.md`](docs/HANDOFF.md)
and `docs/research/2026-06-round3/IMPLEMENTATION.md`. Developed on the `Testing` branch
(commits `bffe4b8`…`3610147` + the live-wiring / security / docs wave).

### Added — Wave 0: hot-file foundations (`bffe4b8`)
- Additive `Case` advisory axes (severity / impact / priority chips) + SLA datetimes; 11
  new model classes + 4 enums + 8 KV namespaces + 4 `Preferences` blocks + 13 optional
  `Secrets` provider slots, all defaulted (old docs load unchanged). Webui route
  **code-split** (`React.lazy` + manual chunks) so the bundle stays small.

### Added — Wave 1: shared substrate (`59c2999`)
- **8 KV-doc stores** (`case_thread` / `case_activity` / `case_tasks` / `inbox` /
  `notif_prefs` / `custom_roles` / `price_overlay` / `shift_handoff`) over the existing KV
  layer — no new index/table.
- **`EnrichmentProvider` SPI** (`enrichment/`: base ABC + registry + dispatch + aggregate)
  with a `tlsoc.enrichers` entry-point group; the default `max()` fusion is byte-identical
  to the legacy path, weighted fusion is opt-in.
- **Multiplexed SSE `EventBus`** (`realtime.py`, `GET /api/events`, **default OFF** with a
  graceful polling fallback) — pure transport, frames published AFTER save, never feeds
  `decide()`.
- **RBAC resource split** + custom-role / inheritance / explicit-**DENY** `effective_matrix()`.

### Added — Wave 2: backend features (`2295363`)
- **Posture metrics + MITRE coverage** — server-side MTTA/MTTR/dwell (p50/p90), SLA/aging,
  quality mix, period-over-period deltas, MITRE coverage vs the bundled 697-technique
  corpus + an ATT&CK Navigator layer export (`routes_metrics.py`).
- **Shift report** — `engine/shift_report.py` (a forward attention queue ranked by an
  urgency = risk/severity/age/SLA score + SLA aging + per-analyst workload + deltas, all
  deterministic, no LLM) folded into `StandupService`; the forward-looking JSON still goes
  to the cheap model as a compact fenced aggregate (#7/#9). `routes_standup.py`.
- **Enrichment providers** — **17 new providers** behind the SPI (**19 registered**
  classes; abuse.ch is one config entry spanning the urlhaus/threatfox/malwarebazaar
  classes) with multi-indicator routing (IP/domain/hash/url/email), per-provider rate
  guard, fail-open + cached (`routes_enrichment.py`).
- **Models registry + `BudgetGate`** — a `PROVIDER_REGISTRY` replacing the gateway
  if/elif + a bundled `llm/model_registry.json` + operator **price overlays**; a pure
  pre-flight `BudgetGate` (`engine/budget.py`) that raises **before** any billable
  completion (never an auto-close) (`routes_models.py`).
- **In-app channel** — an `InAppChannel` fanning out to the per-user `InboxStore` (no
  network) (`routes_inapp.py`); **case collaboration** (threaded human/ai/system messages
  + reactions + tasks + @mentions → inbox + an activity feed) (`routes_cases_collab.py`);
  **triage/priority** chips + a typed ReAct trace timeline (`routes_triage.py`);
  **custom-role CRUD** + preview/simulate/assignment (`routes_roles.py`).

### Added — Wave 2.5: backend gap-closure (`8b25ca2`)
- **Cloud LLM, first-class** — `Provider` widened to `azure` / `bedrock` / `vertex` /
  `openai_compatible`; the gateway authenticates Azure, **Bedrock via a stdlib SigV4 ladder
  (no `boto3`)**, and Vertex (OAuth Bearer); 12 cloud/enrichment `Secrets` (booleans-only
  in `public()`); `ProjectHoneypotProvider` registered.
- **Server-side custom-role enforcement** — a pure `can_for_roles(base, custom_roles, …)`
  (role-union, deny-wins, super_admin hard-allow) drives `_enforce`, so assigned custom
  roles are honored on routes (consistent with `/api/account/permissions`).
- **Test netguard** — an autouse `conftest` socket guard blocks non-loopback egress (opt
  out per test with `@pytest.mark.allow_network`), keeping the enrichment tests
  deterministic + offline.

### Added — Wave 3: webui surfaces (`3610147`)
- Hamburger **`NavSidebar`** (two width states, Cmd/Ctrl+B) + a **`NotificationBell`**;
  a Settings **card-grid** + `BrandingEditor`; a **Roles** matrix editor; a standalone
  **Models** page; **Metrics** tabs + a MITRE heatmap; a **Standup** attention queue;
  CaseDetail's **4 triage chips** + `TraceTimeline` + threaded collaboration; an **Inbox**;
  and an `EnrichmentProvidersEditor`. (webui `tsc --noEmit && vite build` exit 0,
  code-split preserved; #9 audit PASS — no `dangerouslySetInnerHTML` on data, untrusted
  values escaped, secrets boolean-only.)

### Fixed / Security — Wave 4: live wiring + RAG-fencing TRUSTED allowlist
- **RAG-knowledge fencing inverted to a TRUSTED allow-list** — operator-imported RAG
  documents previously rendered to the model **unfenced**; now only the built-in/verified
  corpus is TRUSTED and everything else is fenced UNTRUSTED before any prompt, closing an
  **OWASP-LLM01** prompt-injection gap (no behavior change for legitimate content).
- **Live SSE wiring** (poller / dispatch / pipeline → `EventBus`; webui `EventSource`
  with a polling fallback, still default-OFF); **`PUT /api/branding`** server-side
  contrast-warning computation; a WCAG 2.2 polish pass; and a docs sync.

### Notes
- The **~25 Round-3 cloud-LLM + enrichment secrets** are now wired through both deploy
  compose files (`deploy/docker-compose.{agnostic,tlsoc}.yml`) as commented-optional
  `TLSOC_*` → unprefixed passthroughs, so the documented durable `.env` path works
  end-to-end (`docs/ENVIRONMENT.md` §2.6–2.7, `.env.example`).
- All new providers are **default-off** and **advisory only** — enrichment never feeds the
  deterministic close/escalate decision (#3).

---

## [Unreleased] — 2026-06-30 — Round 2: account/sessions, Settings IA, Demo Mode, per-feed sources, email + customization

A second multi-wave round focused on operator experience: a redesigned login + account
self-service, real sessions with an access policy, a Settings-centric information
architecture, a reversible/isolated Demo Mode, per-feed source configuration, Resend +
SES email channels with customizable templates, pervasive per-user customization, and a
command palette + global search + bulk actions + audit viewer. Every wave was
**additive** with **zero new runtime dependencies** (sessions/JWT, the template renderer,
the SES SMTP-credential derivation, and the per-user prefs store are all Python standard
library; the webui composes the existing vendored shadcn + Tailwind). The backend offline
suite grew **649 → 794 tests green**; the webui `tsc + vite build` is GREEN with the
dev-only Vitest harness expanded to **86 tests** (19 files), and eslint is clean
(0 `react-hooks/rules-of-hooks` errors, 2 exhaustive-deps warnings). The
non-negotiables hold throughout — in particular **`case_manager.decide()` is
byte-identical** (CI-verified): Demo Mode runs FP through the real `decide()` against
a *sandboxed* policy copy (live policy untouched) and keeps NEEDS_HUMAN open; bulk
actions run the analyst human-action path, never an auto-close; templates/terminology
only ever RECOMMEND/relabel and all untrusted text stays fenced (#9). New here? See
[`docs/HANDOFF.md`](docs/HANDOFF.md). Developed on the `Testing` branch
(commits `6adf195`…`763ded9`).

### Added — Wave 1: critical bug fixes
- Webui/presentational fixes (RiskGauge, MFA QR + copy, a duplicate close `X`, chat
  framing, store-degraded UX). The store-degraded notice is derived client-side from
  `/api/health.store_type` (in-memory-store detection); the health endpoint returns
  `{status, version, es_connected, store_type, setup_complete}` (no `persistent` field).
  No data-model changes.

### Added — Wave 2: login redesign + account self-service
- **Two-column login** (brand hero + form) restyling the existing 4-mode `Login.tsx`
  with no change to any submit handler or the mode state machine; per-provider SSO brand
  icons, a segmented MFA OTP, and a client-only password-strength meter (no new dep).
- **Self-service profile** — additive defaulted `User` fields (`display_name` / `alias` /
  `avatar` / `alt_email` / `timezone` / `locale` / `prefs`; old KV docs load unchanged,
  no migration) projected through `User.public()` (secrets stay excluded). Routes:
  `GET/PUT /api/account/me` (env-managed single-admin is read-only → 400) and
  `PUT /api/me/avatar`. The avatar validator allows only small `data:image/(png|webp|jpeg)`
  (rejects SVG/oversize/malformed), magic-byte sniffed and capped.

### Added — Wave 3: sessions & access policy
- **SessionStore** (`stores/sessions.py`, over the existing KV layer; EsKVStore /
  SqlKVStore adapters; persisted so it survives `_wire()` rebuilds and an ephemeral JWT
  secret). Access tokens now carry a `sid` (128-bit) + `tv` (token_version) claim, minted
  at all session-create sites (login / mfa-verify / sso-callback).
- **Enforcement in `require_auth`** (async — not in the sync hot-path `verify()`): reject
  missing / revoked / `tv`-mismatch / past-absolute / past-idle, lazily bumping
  `last_active`; failures return `401 {code: session_invalid|session_expired|reauth_required}`.
  `require_fresh_auth(window)` is a step-up gate. The no-auth no-op path is preserved.
- **Refresh rotation + reuse detection** — a replay of the previous refresh hash is treated
  as theft (revoke + bump `tv` + audit + notify). Routes: `POST /api/auth/refresh`,
  `POST /api/auth/reauth`; own-session `GET /api/sessions`,
  `POST /api/sessions/{sid}/revoke`, `POST /api/sessions/revoke-others`; admin
  `GET /api/admin/sessions`, `POST /api/admin/sessions/{sid}/revoke`. A UI-editable token
  policy (access TTL / idle / absolute / refresh TTL / sudo window + notify toggles) on
  Preferences. Every create/revoke is audited (#2).

### Added / Changed — Wave 4: Settings-centric IA consolidation
- **Two-scope Settings** (Personal Account / Organization) in one left rail with grouped
  headers; Users / Security / SSO and the W2 profile / W3 sessions pages move into Settings
  sub-sections, with RBAC hiding sections the role can't see (allow-all when auth/rbac off).
  No new endpoints — Settings round-trips via the existing `/api/settings`, `/api/branding`,
  `/api/roles` + the W2/W3 routes.
- **Page consolidation** — near-duplicate top-level pages folded into tabbed surfaces and
  the rail grouped into a handful of areas (Overview / Triage / Intelligence / Analytics /
  Admin), honouring the ONE-chat-engine rule. Settings hook ordering kept above the early
  returns (guards against React #310).

### Added — Wave 5: Demo Mode + Experimental Settings
- **Reversible, isolated, $0 Demo Mode** — a first-class tenant `demo.mode`
  (`off` / `seeded` / `live`) on Preferences. A `DemoPullConnector` + `demo_generator`
  (a fixed fictional org, a diurnal-Poisson benign baseline, and seeded MITRE ATT&CK
  storylines) feed synthetic OCSF events through the REAL pipeline, but generated
  workload writes land in a SEPARATE in-memory store with a deterministic mock LLM
  (`pricing_source='zero'`, a plausible synthetic `$`). The real poll path is gated
  so the durable cursor (#4) is
  untouched; cases are run-tagged + `demo`-tagged (seeded IDs are also namespaced). FP
  runs through the real `decide()` against a *sandboxed* AutoClosePolicy copy;
  NEEDS_HUMAN stays open. Routes:
  `POST /api/demo/{enable,incident,reset,disable}`, `GET /api/demo/status`
  (`demo:manage` for mutations). A demo banner + `(simulated)` labels + a write-guard
  keep demo and prod distinct; lifecycle mutations intentionally remain in the real audit.

### Added — Wave 6: per-feed source configuration
- **`IndexPattern` → richer per-feed `Feed`** (same wire key `config['index_patterns']`,
  back-compat: legacy `{pattern, role, auto_correlate}` and bare-string entries still
  validate). Adds an **`ignore`** `IndexRole`; splits the overloaded `auto_correlate` into
  `correlate` + `auto_investigate` with a behaviour-preserving migration; and adds per-feed
  `query` (connector-native, operator-TRUSTED), field-mapping override, `message_field`,
  `severity_floor`, and an optional schedule. `engine/poller.py` keys a **durable cursor
  per `{source.id}:{feed.id}`** so a fast alerts feed and a slow events feed never skip
  (#4); a severity floor demotes auto-forwarding but registers a candidate and **never
  drops events** (#4); `IGNORE` feeds skip ingest and are excluded from the derived
  `data_view_pattern`. `/api/sources` round-trips the config verbatim (no new endpoint).

### Added / Changed — Wave 7: email (Resend + SES + templates) + pervasive customization
- **Resend channel** (`notifications/resend.py`, type `resend`) — an HTTPS-API channel over
  the `_HttpChannel` base (Bearer key, optional idempotency key, client-side rate limit,
  retry only on 429/5xx). **Amazon SES** ships as an email SMTP preset
  (`email-smtp.{region}.amazonaws.com`) that can derive the SMTP password from a raw IAM
  key pair via a stdlib HMAC chain — no new dep, SMTP as the simple default.
- **Customizable email templates** (`notifications/templates.py`) — a ~80-LOC stdlib
  mustache-subset renderer (`{{var}}` auto-escaped via `html.escape`, `{{{var}}}` raw only
  for trusted header HTML, sections, dotted lookup, no eval/getattr) with `header_safe()`
  (CRLF/header-injection guard) and `text_safe()`. 5 preloaded, operator-overridable
  templates (`case.new` / `case.escalation` / `case.resolved` / `digest.daily` / `test`);
  server-side render via `POST /api/notifications/preview`. Deterministic threading headers
  (`Message-Id` / `In-Reply-To` / `References` / `X-TLSOC-*`).
- **Per-user customization** — a `UserPrefsStore` (`stores/user_prefs.py`, over the KV
  layer, keyed by user, `'default'` when auth off; no new index) plus org-level Preferences
  hold **saved views**, per-table column state, **terminology** overrides, and a personal
  light/dark/system theme, resolved through a merged cascade. Routes:
  `GET /api/prefs/effective`, `GET/PUT /api/prefs/{user,org}` (org PUT admin),
  `GET/POST/PUT/DELETE /api/views` (+ `POST /api/views/{id}/clone`),
  `PUT /api/prefs/user/tables/{table_id}`, `GET/PUT /api/terminology` (PUT admin).
- **Command palette, global search, bulk actions, audit viewer** — a Cmd/Ctrl-K palette;
  a cross-entity **global search** (`GET /api/search`); **bulk case actions**
  (`POST /api/cases/bulk`, max 500 ids) that run each id through the EXACT single-case human
  action path (`_perform_case_action`) — RBAC enforced up front, each case audited
  individually, partial-failure tolerant, NEVER `case_manager.decide()`; and an **audit
  viewer** (`GET /api/audit`) over the append-only trail.

### Fixed — Audit & remediation (commits `aae7a76` + `763ded9`)
- **16-agent adversarial audit** (commit `aae7a76`) — a fleet review of the full Round 2
  surface (RBAC gates, the poller cursor, sessions, Demo Mode, email templates, the gauge)
  plus a docs refresh and `docs/research/2026-06-round2/ROUND2_AUDIT.md`. It surfaced real
  bugs → **8 confirmed fixes auto-applied**, mostly missing/incorrect RBAC gates (no-ops in
  the default-OFF profile), a poller cursor edge case, and a RiskGauge rendering bug.
- **HIGH/MEDIUM remediation** (commit `763ded9`, **+22 regression tests**) — the confirmed
  review items: **#4 feed cursor starvation** (a fast feed could starve a slow one — each
  `{source.id}:{feed.id}` advances independently); **demo-chat isolation** (chat in Demo
  Mode stays on the sandboxed in-memory store); **env single-admin token-version lockout**
  (the env-managed admin no longer self-locks on a `tv` bump); **`set_status` → `RESOLVED`
  RBAC** (resolving via `set_status` now requires the same permission as `resolve`); and
  **email hardening** — `text_safe()` on plain-text bodies, `{{{ }}}` raw-output restricted
  to trusted header HTML, and branding-SVG rejection. A **strengthened authZ-coverage CI
  test** now **fails if any non-GET `/api` route lacks an authZ gate**.
- Deferred / low-severity items are tracked in
  `docs/research/2026-06-round2/ROUND2_AUDIT.md` (session-KV optimistic concurrency,
  multi-generation refresh-reuse, an ES-only CONFIG_INDEX nested-type collision, a cosmetic
  deep-link breadcrumb); the best-of-best Tier 2/3 backlog (API keys, dashboard builder,
  scheduled reports, watchlists, SLA timers, a hunting/query builder) is in
  `docs/research/2026-06-round2/ROUND2_BEST_OF_BEST.md`.

### Notes
- Auth remains **DEFAULT OFF**; sessions/account/customization gates no-op when auth is off
  (`'default'` user prefs, allow-all RBAC), preserving the zero-auth back-compat behaviour
  and the offline suite. Enabling it (`TLSOC_AUTH_ENABLED=true`) seeds an
  `Admin` / `Admin@123` super-admin (forced password change on first login).
- **Run the demo locally:** `./scripts/run-demo.sh` (backend on :8088, webui on :5173).

---

## [Unreleased] — 2026-06-29 — Agentic SOC overhaul (Waves 1–7)

A seven-wave SOC overhaul: multi-user identity + RBAC, MFA + SSO, a two-axis case
taxonomy + custom case IDs, pluggable notifications, multi-source / cross-source
correlation, playbook automation + threat context, and a consolidated Settings +
UI pass. Every wave was **additive** with **zero new runtime dependencies**
(MFA/TOTP, SSO, and SMTP email all use the Python standard library). The backend
offline suite grew **395 → 649 tests green**; the webui `tsc + vite build` is GREEN
with a dev-only Vitest harness (27 tests). The non-negotiables hold throughout —
in particular **`case_manager.decide()` is byte-identical** (CI-verified): the new
status/disposition taxonomy, notifications, and threshold automation all sit on an
additive layer and run only *after* the deterministic decision. Developed on the
`Testing` branch (commits since `91f8616`).

### Added — Wave 1: identity (multi-user + RBAC)
- **Persisted multi-user store** backed by the existing KV layer (no new index or
  SQL table); a first-run **OOBE** creates the first admin, and when auth is enabled
  on an empty store the suite seeds an `Admin` / `Admin@123` **super_admin** with a
  `must_change_password` flag (forced replacement on first login).
- **Six-role RBAC** (`super_admin` / `soc_manager` / `analyst_tier2` /
  `analyst_tier1` / `responder` / `auditor`) with a permission matrix
  (`app/rbac/policy.py`), `require_permission` / `require_role` FastAPI deps on every
  state-changing route, and React `<Can>` guards filtering nav + actions. Routes:
  `POST /api/setup/init-admin`, `POST /api/auth/change-password`,
  `GET /api/roles`, `GET|POST /api/users`, `PUT|DELETE /api/users/{username}`.

### Added — Wave 2: MFA + SSO
- **MFA (TOTP)** — stdlib RFC-6238 (verified against the official RFC test vectors),
  a browser **inline-SVG QR** enrolment (no QR dependency), single-use recovery
  codes, and a two-phase login (password → `requires_mfa` → verify). Routes:
  `POST /api/auth/mfa/{setup,confirm,verify,disable}`.
- **SSO (OIDC)** — Google / Microsoft / generic providers via **server-side code
  exchange + `userinfo`** (no `id_token`-signature-verify dependency), with
  group→role auto-provisioning. Routes: `GET /api/auth/sso/{providers,authorize,
  callback}`, `POST /api/auth/sso/providers/{id}/secret`.

### Added — Wave 3: case taxonomy + custom case IDs
- **Two-axis taxonomy** — `CaseStatus` extended additively
  (`new` / `investigating` / `escalated` / `on_hold` / `resolved`; `open` /
  `needs_human` / `closed` retained, `needs_human` kept as a deprecated alias) plus
  a new `Disposition` enum (`true_positive` / `false_positive` / `benign` /
  `suspicious` / `duplicate` / `undetermined`). New lifecycle actions
  (`hold` / `resume` / `resolve` / `set_status` / `set_disposition` / `deescalate`)
  on `POST /api/cases/{id}/action` with a transition guard (illegal moves → 400) and
  a status history. **`decide()` is byte-identical** — the taxonomy is layered in
  `apply()` and analyst actions only.
- **Customizable case-ID nomenclature** — `engine/case_id.py` renders a template
  (e.g. `CASE-{year}-{seq:06d}`) backed by an atomic KV sequence, with a live preview
  via `POST /api/settings/case-id/preview`. `Case.case_number` is additive; the
  immutable `case_id` is unchanged.

### Added — Wave 4: notifications
- **Pluggable `NotificationChannel`** abstraction (`app/notifications/`) with
  **email** over stdlib SMTP (**13 provider presets** — gmail / o365 / yahoo / zoho /
  icloud / sendgrid / mailgun / postmark / brevo / sparkpost / … + custom), plus
  **Slack / Microsoft Teams / webhook / PagerDuty / Telegram** channels. Per-condition
  triggers (create / verdict-change / escalate / close) with dedup, per-recipient
  rate-limiting, and digest batching; sends are **fire-and-forget after `apply()` +
  save** (never inside `decide()`) and audited. Channel secrets live in the secret
  tier. Routes: `GET /api/notifications/providers`, `POST /api/notifications/test`,
  `POST /api/notifications/channels/{id}/secret`, `POST /api/cases/{id}/notify`.

### Added — Wave 5: multi-source + cross-source correlation
- **Auto-Correlate toggle** per **source** *and* per **sub-source** (the
  `events` / `alerts` index pattern); disabling it routes that source's clusters to
  candidates instead of auto-forwarding.
- **Opt-in cross-source correlation** (`CrossSourceCorrelationConfig`,
  default OFF) links **RELATED** cases that share an entity (IP / host / user /
  file hash / domain) within a window — surfaced as related cases, **not** a forced
  merge (the 1:1 cluster→case signature/audit invariant is preserved).
- **Per-source field-mapping overrides** + per-connector **contextual setup help**
  (`AuthField.help_link` / `help_code`, rendered as `HelpTip`s) + an
  analyze-a-sample affordance.

### Added — Wave 6: automation + threat context
- **Run-a-playbook** action (`POST /api/cases/{id}/run-playbook`) re-investigates a
  case through the shared pipeline with the chosen playbook **forced as context**
  (recommend-only, #3-safe).
- **Threshold automation** (`engine/threshold_automation.py`, default OFF) matches
  cases *after* the decision and may **tag / recommend / notify / run a playbook /
  request approval** (→ a HITL `Proposal`) — but it **never sets status directly**;
  `NEEDS_HUMAN` never auto-closes.
- **Threat-context panel** (`GET /api/cases/{id}/threat-context`) assembles IOC
  reputation, a **bundled MITRE ATT&CK corpus (697 techniques)**, and related cases,
  **fail-open** per section. A resolved-case → RAG knowledge loop auto-chunks a
  closed case into the corpus so future investigations retrieve prior decisions;
  `POST /api/threat-context/import` ingests threat-intel docs (fenced UNTRUSTED).

### Added / Changed — Wave 7: consolidated Settings + UI
- **Consolidated Settings** — a single surface across **13 sections / 4 nav groups**
  (Data Sources, Models & LLM, Correlation & Cases, Automation, Notifications,
  Security, Knowledge & Threat Context, Enrichment, Appearance, Advanced, plus the
  admin areas). Everything rides `GET/PUT /api/settings` (deep-merge + validate);
  `GET /api/settings/schema` and `GET /api/settings/{section}` support form
  generation.
- **UI cleanup** — RiskGauge redesign (fixes the Active-Risk-Index gauge glitch),
  skeleton/shimmer loading + staggered reveals, 8px-grid alignment, and a WCAG-AA
  contrast pass. The UI stack is Vite + React + **Tailwind + shadcn** (the legacy
  `@elastic/eui` surface was removed).

### Notes
- **Auth is DEFAULT OFF** (`Secrets.auth_enabled`) for back-compat and the offline
  tests. Enable it with `TLSOC_AUTH_ENABLED=true` to get the login screen, the OOBE,
  and the `Admin` / `Admin@123` seed (which must be changed on first login).

---

## [Unreleased] — 2026-06-24 — HITL proposal approvals, white-screen fix + error boundary, cost/branding

Backend offline suite **395 tests green** (was 380); webui `npm run build` GREEN +
a new dev-only Vitest harness; no new runtime npm deps. Additive; the 12 non-negotiables
intact — **`case_manager.decide()` is byte-identical (verified in tests)**; suppression
is a pre-LLM cost-gate filter only; human approval is the ONLY write path. Developed on
the `Testing` branch.

### Fixed
- **"Notes & feedback" tab white-screened the whole app** — four `<EuiAvatar color={tint(...)}>`
  passed an `rgba()` string, which EUI 95's EuiAvatar rejects (throws unless a valid hex /
  'plain' / 'subdued'); with no error boundary the throw unmounted the entire tree.
  Removed the `tint()` wrapper on the 4 avatars (EuiBadge tint() usages are fine and kept).
- **Added a top-level React ErrorBoundary** (flyout tab body + app root, resets on
  tab/case/page change) so any future render throw degrades to a callout instead of a
  white screen. (Audit confirmed the other suspected EuiIcon/EuiAvatar "crashes" were
  false alarms — EuiIcon accepts CSS colors, EuiAvatar accepts hex.)

### Added
- **Agent-drafted suppression/asset PROPOSALS with human approval (HITL)** — on FP-confirm/
  close, a code-guarded proposer drafts a *pending* `Proposal` (suppression `field==value`
  only from values literally present in the case's events; hard denylist of over-broad
  selectors; fail-safe so it can never break the close). `GET /api/proposals`, `POST
  /api/proposals/{id}/approve|reject` (approve appends a live `SuppressionRule` via the
  settings write path or a `MemoryEntry`; admin-gated via a `require_admin` seam). Webui
  **Approvals** queue. `SuppressionRule` gained `enabled`/`expires_at`/provenance, honored
  by the cost gate.
- **Deeper Cost & usage breakdown** — sortable detailed ledger (cost/%/tokens/calls/avg
  cost-per-call/cost-per-1K-tokens) across Model/Role/Surface/Top-drivers, composition
  donut with "Other" roll-up, spend-over-time stats, efficiency tiles.
- **Expanded white-label branding** — favicon, secondary accent, login subtitle, footer
  text, support URL, default-dark-mode (validated, additive).

### Deferred (unchanged from prior round; designed in docs/research/CUSTOMIZATION_AND_RBAC.md)
- Full RBAC enforcement (the `require_admin` seam is default-allow today with a clear TODO).
- True cross-source aggregation.

---

## [Unreleased-prev] — 2026-06-23 — Deep source customizability, no-IP fix, UI standardization + chat rebuild

Backend offline suite **380 tests green** (was 364); webui `npm run build` GREEN,
no new npm deps. Additive; the spine and the 12 non-negotiables intact (#3 the
close/escalate decision stays deterministic; #1 read-only scoped access; #4 case
idempotency). Developed on the `Testing` branch.

### Fixed
- **No-source-IP alerts were silently dropped** — correlation grouped by a single
  entity and discarded events whose entity field was null, so a source without
  `source.ip` produced **no cases**. Now entity-agnostic: `entity_strategy`
  (per-source or global, default `auto`) falls back **IP→host→user→rule** so a case
  always forms; the entity type used is recorded on the case. Back-compat preserved.
- **Chat layout glitch + wasted space** — the result table detached/clipped and the
  panel left large empty bands (brittle `calc(100vh-160px)` + an unconstrained
  table). Rebuilt as a robust full-height flex layout; result tables now scroll
  within the bubble and **all-empty columns are hidden** (no more wall of `—`).
- Standup render hardening carried forward; invalid icons removed.

### Added
- **Per-source multiple index patterns with roles** — `config.index_patterns:
  [{pattern, role}]`; `alerts`-role patterns auto-investigate every match (SIEM
  alerts), `events`-role correlate then triage. N patterns; back-compat with the
  single `data_view_pattern`. Editable in the source wizard/manager.
- **`source_id`/`source_name` on every case** + a **filter-by-source** facet and
  comprehensive **sort options** on Cases & Automated-scans; a **source selector** in
  Chat (default "All sources"); `POST /chat` gained `source_id` scoping.
- **Per-source field mapping + `message_field` + entity-strategy selector**, and a
  **CA-certificate file picker + drag-and-drop** (PEM) alongside paste.
- **Knowledge & Memory upgrades** — sortable/filterable/density-toggle documents
  table, multi-file batch import with progress, ranked retrieval with relevance
  scores; Memory KPIs, search/category/author/active filters, sort, group-by-category.
- **Read-only Test-connection clarity** — the success callout explains the
  `read_only` mode (cluster-monitor not required).
- **UI standardization** — a design-token layer (`SPACE`/`RADIUS`/`WEIGHT`/
  `MAX_CONTENT_WIDTH`), denser/cleaner primitives, refined Shell nav + global CSS
  (hover elevation, focus rings, scrollbars, GPU-friendly transitions), and a
  redesigned **Notes & feedback** tab + denser in-case **Ask** chat.
- **Research + design docs** — `docs/research/UX_AND_DESIGN.md` and
  `docs/research/CUSTOMIZATION_AND_RBAC.md` (competitor study + an RBAC/user-management
  design and a cross-source-aggregation design, both scoped as the next round).

### Deferred (designed, documented in docs/research/CUSTOMIZATION_AND_RBAC.md)
- **RBAC + user management** (roles admin/analyst/viewer, route-layer capability gate,
  Users admin UI) — a dedicated security-focused follow-up.
- **True cross-source aggregation** (poll/query all configured sources) — today only
  the primary pull source is actively polled; chat source-select is single-source.

---

## [Unreleased-prev] — 2026-06-23 — UI polish, filtering, in-case chat, reinvestigate + icon fix

Backend offline suite **364 tests green** (was 349); webui `npm run build` GREEN,
no new npm deps. Additive; the spine and the 12 non-negotiables are intact
(#3 the close/escalate decision stays deterministic; #6 every LLM call through the
one gateway — the chat/reinvestigate model override is a per-call prefs copy).
Developed on the `Testing` branch.

### Fixed
- **Blank EUI icons app-wide** — icons rendered as empty gray squares because EUI
  lazy-`import()`s each glyph and those chunks don't resolve in the nginx bundle.
  Now statically pre-registered via `appendIconComponentCache` (`webui/src/lib/icons.ts`,
  128+ icons, imported first in `main.tsx`). Also fixed an invalid Cost-page icon
  (`appsApp`→`visPie`) and stale icon names elsewhere.
- **Standup never works on a degraded store** — `GET /api/standup` now always
  returns HTTP 200 with a graceful `{degraded, error}` payload instead of 500ing;
  the page renders disabled/degraded/empty states cleanly.

### Added
- **Reinvestigate a case** — `POST /api/cases/{id}/reinvestigate` re-runs the AI
  investigation (pipeline `force=True`), with an optional per-call **model** override;
  surfaced as a model-customizable button in the case flyout.
- **Ask about this case** — an in-flyout chat tab (reusable `<ChatPanel caseId/>`)
  scoped to the open case; `POST /api/chat` gained an optional `model` override.
- **Structured lifecycle actions** — `POST /api/cases/{id}/action` accepts optional
  `resolution`/`assignee`/`priority`/`tags`; the flyout actions now have icons,
  in-product explanations (tooltips), and per-action optional fields.
- **Full filtering** on Cases + Automated-scans (verdict/status/risk-range/rule/
  persona/playbook/assignee/tags/time + search; self-healing facets).
- **Redesigned Chat** — modern message bubbles, polished empty state + composer,
  per-conversation model picker; extracted a reusable `ChatPanel`.
- Shell/nav + global CSS polish (active-nav accent, health pill, hover elevation,
  focus rings, refined scrollbars; `prefers-reduced-motion` respected).

---

## 2026-06-23 — Browse a source's logs + read-only Test-connection & per-source TLS fixes

Backend offline suite **349 tests green** (was 340); webui `npm run build` GREEN,
no new npm deps. Additive; the spine and the 12 non-negotiables are intact.
Developed on the `Testing` branch.

### Added
- **Browse a source's logs** — `GET /api/sources/{id}/logs?limit=&query=&from=&to=`
  (auth-protected). **Pull** sources (Elasticsearch / OpenSearch / Wazuh) run a
  bounded (hard-cap **200**), read-only, field-mapping-aware scoped search honoring
  the source's own `data_view_pattern` / field mapping / TLS; **push** sources return
  the last N events from a new in-memory **live-tail ring buffer** (cap 500/source)
  in `IngestService` (or `501` if the connector does not support browse). Each row is
  `{ ts, source_ip, user, host, rule, severity, message, _raw }` — `_raw` is the full
  log document; **secrets are never returned**. `404` for an unknown source, `502`
  for a read failure.
- **`capabilities: ["browse"]`** on the pull connector manifests, auto-applied to
  every push receiver (`registry._with_browse`), so the UI shows the Logs tab only
  where it is supported.
- **webui — `SourceLogsFlyout`** — a per-source Logs panel (opened by a "Logs"
  button on each source card, gated on the connector's `browse` capability): an
  `EuiBasicTable` (timestamp · source.ip · module/rule · severity · message) with
  expandable rows showing the raw `_source` in an `EuiCodeBlock`, a search box, an
  `EuiSuperDatePicker` time range (default last 15m), and a **10s live-tail
  auto-refresh** toggle. All log content renders as plain text / code blocks
  (UNTRUSTED-safe, non-negotiable #9). `api.sourceLogs` + types added; no new deps.

### Changed / Fixed
- **Test connection now works for read-only API keys.** `ElasticConnector.test_connection()`
  no longer gates on `ping()` (a correctly-scoped read-only key cannot do `HEAD /`).
  It runs the cheap scoped read-only search **first**; HTTP 200 (any/zero hits) →
  `ok:true, mode:"read_only"` with a green *"Read-only access verified — N events
  readable in <pattern>. Cluster-monitor privilege not granted (expected for a
  read-only key)."* `ping()` is now only an extra `cluster_monitor` signal
  (`mode:"full"` when present), never the pass/fail gate; `ok:false` only when the
  scoped read fails (auth `401`/`403` on the index, or network/TLS). `ConnectionTest`
  gained `mode` + `cluster_monitor`; the webui Test-connection result renders the
  read-only / full success callout.
- **Per-source TLS is now honored.** Pull connectors previously used the global ES
  client + field-mapping config only, so a source's `es_verify_certs:false` /
  `es_ca_cert` / `es_url` / `es_api_key` never applied (observed
  `CERTIFICATE_VERIFY_FAILED` despite `es_verify_certs:false`). Now
  `AppState.es_client_for_source()` builds a **per-source ES client** from the
  source's merged config + secrets (dropping any global mgmt key); the primary log
  source and the browse endpoint use it, and owned clients are closed on
  rebuild/shutdown. Sources with no overrides keep using the shared global client
  (no behaviour change).

## [Unreleased] — 2026-06-22 — Case explainability, RAG management & visibility, agent memory + dashboards/collaboration

Backend offline suite **340 tests green** (was 310); webui `npm run build` GREEN
(2330 modules), no new npm deps. Additive; the spine and the 12 non-negotiables are
intact. Developed on the `Testing` branch.

### Added
- **RAG ingest + management + visibility ("see the RAG")** — `engine/chunking.py`
  (`chunk_text`, a dependency-free paragraph-pack + overlap chunker); the
  `VectorStore` ABC gained `list_documents()` / `list_chunks()` / `delete_document()`
  / `stats()` (implemented in the InMemory, ES `dense_vector`, and SQL stores) — a
  "document" is the chunks sharing `metadata["document_id"]`, seeds grouped as
  `seed:<source>`. `RagService` gained `import_document(title, text, *, source, tags)`,
  `list_documents()`, `get_document(id)`, `delete_document(id, *, force)`,
  `rag_stats()`; the built-in seed sources (`runbook` / `mitre` / `suppression` /
  `resolved_case`) are **guarded against deletion unless `force=true`**. New routes:
  `GET /api/rag/stats`, `GET /api/rag/documents`, `GET /api/rag/documents/{id}`,
  `POST /api/rag/import`, `DELETE /api/rag/documents/{id}?force=`, and
  `GET /api/rag/search?q=&top_k=` (run a live retrieval to SEE what RAG returns).
  Tests: `test_rag_management.py` (11).
- **Agent memory (Claude.ai-style durable operator facts)** — `stores/memory.py`
  `MemoryStore`, backed by the existing **KVStore** (no new index or migration: ES
  via a new `EsKVStore` adapter on the config doc, SQL via `SqlKVStore`); a
  `MemoryEntry` model (`id`, `text`, `category`, `tags`, `source` (`human`|`agent`),
  `author`, `created_at`, `updated_at`, `active`). Memory is auto-injected into BOTH
  automated investigations and chat as a DISTINCT **`<<<MEMORY>>>` TRUSTED block**
  (separate from the fenced UNTRUSTED evidence), with the precedence
  policy > base > playbook > MEMORY > untrusted; `prompts.render_memory()` + `fence()`
  neutralise forged `<<<MEMORY>>>` markers. **Memory NEVER overrides the deterministic
  CaseManager** — it only informs the LLM. Editing is EXPLICIT: REST
  (`GET/POST/PUT/DELETE /api/memory`, `source=human`) or conversationally in chat
  ("remember:" / "forget", `source=agent`, user-directed text only, audited). The
  chat JSON contract gained `memory_action` (executed deterministically + audited)
  and `memory_suggestion` (returned for UI confirm, never auto-saved). Tests:
  `test_memory.py` (14).
- **Case explainability** — the investigator now emits a **CONTEXT audit record**
  (new `ActionType.CONTEXT`) summarising the persona / playbook / memory / knowledge
  (RAG snippets) / enrichment it was given, and the VERDICT record carries a reasoning
  excerpt. New `GET /api/cases/{id}/rationale` assembles a pure, defensive "why"
  object: verdict / confidence / status / decision_by, persona, playbook (+ reason),
  `memory_used[]`, `knowledge[]` (RAG/runbook source + snippet), enrichment,
  `tools[]` (the commands / ES queries the agent ran), reasoning, the **DETERMINISTIC
  `decision_rationale`** (the close/escalate rationale), `mitre[]`, and `evidence[]`.
  Tests: `test_explainability.py` (5).
- **webui — Knowledge & Memory pages + the case "Why" tab** —
  - **Knowledge page** (`components/Knowledge/KnowledgePage.tsx`): RAG corpus stats
    header; import (paste textarea + `.txt`/`.md`/`.json`/`.csv` file upload read
    client-side); a documents table + chunk drill-in flyout; guarded force-delete;
    and a "Try a retrieval" search showing exactly what RAG returns. New **Platform**
    nav entry.
  - **Memory page** (`components/Memory/MemoryPage.tsx`): add / inline-edit / delete /
    active-toggle durable facts; human-vs-agent source badges; an explainer that you
    can also say "remember:" / "forget" in Chat. New **Platform** nav entry.
  - **Case "Why" tab** (`CaseDetailFlyout.tsx`): consumes `/cases/{id}/rationale` —
    the deterministic decision (prominent), agent reasoning, knowledge used (RAG /
    runbook snippets with provenance), the exact commands / queries the agent ran,
    operator memory applied, enrichment, playbook, and MITRE; plus trace-tab polish.
  - **Chat memory UI** (`ChatPage.tsx`): a calm memory-action confirmation echo + a
    dismissible "remember this?" suggestion that calls `POST /api/memory`, with a
    per-message double-save guard.

### Changed
- **Dashboards** — the Metrics page gained a "Knowledge base & memory" section (RAG
  docs/chunks, embedding model + dim, memory facts/active, corpus-by-source,
  memory-by-author); the Overview gained compact RAG/memory nav tiles. Loading is
  non-fatal.
- **Cases list collaboration** (`CasesPage.tsx`) — a sortable assignee column, tags +
  comment-count badges, and collaboration / assignee filters.
- All attacker-influenceable text (RAG chunks, memory text, tool queries, tags, chat
  suggestions) renders as plain text / `EuiCodeBlock` — never
  `dangerouslySetInnerHTML` (non-negotiable #9 upheld). A review pass fixed one
  invalid EUI icon.

## [Unreleased] — 2026-06-22 — Wave 3: metrics, feedback loop, collaboration, white-label UI + CI

Backend offline suite **310 tests green**; webui builds clean. Additive; spine
untouched. Developed on the `Testing` branch.

### Added
- **Analytics / metrics dashboard** — `engine/metrics.compute_metrics` (verdict &
  status mix, persona/playbook usage, avg risk, coarse MTTR, per-day trend) +
  `GET /api/metrics` (merges the cost ledger), surfaced as a new **Metrics** page.
- **AI-decision feedback / grading loop** — `Case.feedback` (append-only),
  `POST /api/cases/{id}/feedback`, `GET /api/feedback/stats` (agreement rate, grade
  averages, outcome mix, time saved). UI: a grading widget in the case flyout +
  a feedback-quality panel on the Metrics page. Measures triage quality / builds
  an eval corpus.
- **Case collaboration** — `Case.tags/comments/assignee`; `POST /api/cases/{id}/
  {comment,tags,assign}`; flyout UI (comments thread, tag editor, assignee) + tag
  chips/filter on the Cases list.
- **Org branding / white-label** — `BrandingConfig` (org/product name, logo upload
  as a validated base64 data URL, primary+secondary accent, theme) on Preferences;
  public `GET /api/branding` + protected `PUT`. UI: a runtime-themeable design
  system (accent via CSS vars), a Branding settings panel with live preview, and a
  branded shell + login screen.
- **Case export** — `GET /api/cases/{id}/export?format=json|md` + a flyout export
  menu (no-dep Blob download).
- **Case hover preview** — a rich, debounced, keyboard-accessible hover card on the
  Cases list / Scans board / Overview rows (verdict, risk gauge, entity, persona,
  playbook, evidence, MITRE, age).
- **CI/CD** — `.github/workflows/ci.yml` gates every PR on the offline backend
  suite (incl. the auth route-coverage test) + the webui build, with an aggregate
  `CI passed` check to require in branch protection (see CONTRIBUTING.md).

### Changed
- Web UI visual overhaul: skeleton loaders, `PageHeader`, KPI deltas, flat nested
  cards, inline-markdown chat, hero numbers, copy/print, capped badge rows, page
  fade-ins, `prefers-reduced-motion` support. Fixed the dead Scans card click and
  the Cases stat-tile/total mismatch.

## [Unreleased] — 2026-06-21 — Wave 2: Markdown playbooks + optional auth

Backend offline suite **300 tests green**; webui builds clean. Additive; the spine
(typed OCSF, StateStore, one LLM gateway, durable cursor) is untouched.

### Added
- **Markdown playbook engine** (`backend/app/playbooks/` + `backend/playbooks/*.md`):
  operator-authored phased procedures with strict-validated YAML front-matter
  (`PlaybookManifest`), a deterministic, explainable `PlaybookRegistry.select`
  (rule_ids / entity_types / min_event_count are hard criteria; mitre/tags are
  advisory — clusters carry no MITRE pre-investigation), atomic hot-reload, and the
  matched playbook injected as a DISTINCT `<<<PLAYBOOK>>>` TRUSTED block separate
  from the fenced UNTRUSTED evidence (+ a precedence line). It can only RECOMMEND.
  3 seed playbooks (brute-force login, suspicious outbound, reported phishing).
  Endpoints: `GET /api/playbooks`, `POST /api/playbooks/reload`,
  `GET /api/playbooks/selection/{case_id}`. `Case.playbook_id` + audit record the
  selection/fallback. A playbook's `rag_queries` augment retrieval (bounded by top_k).
- **Optional auth (default OFF — the no-auth "old version" remains the default and
  fully available)**: stdlib-only `app/auth/` (PBKDF2 password hashing + HS256 JWT)
  + `app/middleware/` (security headers / CSRF / Redis-free rate limit); a
  router-level `require_auth` gate that is a strict no-op when disabled, with a tiny
  `PUBLIC_API_PATHS` allowlist; `/api/auth/{login,me,logout}`; and a CI
  route-coverage test that fails if any `/api` route bypasses auth.
- webui: an optional login gate (no-op when auth is off) + a read-only
  **Playbooks & Agents** catalog surface.

### Changed
- **Case Manager → operator-configurable `AutoClosePolicy`** (`engine/case_manager.decide`
  is now a pure fn over `(verdict, confidence, risk_score, policy)`): per-verdict-class
  enable / min-confidence / max-risk / objection-window. FALSE_POSITIVE auto-closes
  above a bar by default; **TRUE_POSITIVE auto-close is an explicit opt-in (off by
  default)**; **NEEDS_HUMAN never auto-closes (code-enforced)**. The deprecated
  `fp_auto_close` is migrated into `auto_close.false_positive` for stored configs.
  (This generalises the old "a TP is never auto-closed" invariant into a tunable,
  code-enforced policy — see CLAUDE.md non-negotiable #3.)
- Runbooks are now the RAG **knowledge** corpus only; per-cluster procedure
  injection is owned by the new playbook system.

## [Unreleased] — 2026-06-21 — Vigil-inspired overhaul (Wave 1) + plugin archived

A deep end-to-end study of the open-source **Vigil** AI-SOC (10 Opus research
agents; see `docs/VIGIL_STUDY.md`) drove an additive overhaul that keeps our
spine (typed OCSF, `StateStore`, the single LLM gateway, deterministic case
manager) fully intact. Backend offline suite: **244 tests green**; webui builds
clean (`tsc` + Vite).

### Added
- **Multi-agent roster** (`backend/app/agents/personas.py`): a declarative
  `AgentPersona` registry (identity / web-app / network-recon / malware /
  threat-intel + generalist) over the ONE investigator. The cluster is routed to a
  specialist deterministically; the persona specialises the system prompt and is
  recorded on the case + audit. `GET /api/personas`. Surfaced as a badge on the
  case-detail flyout.
- **Plain-text runbooks** (`backend/app/runbooks/*.md` + `engine/runbooks.py`):
  Markdown playbooks with frontmatter, selected per cluster and injected as TRUSTED
  guidance into the investigator, and indexed into the RAG corpus. `GET /api/runbooks`.
- **Hybrid RAG retrieval** (`tools/rag.py`): drawer-floor-first vector search +
  dependency-free BM25 re-ranking — recovers exact IOC/rule tokens that embed as
  noise. Toggle `rag.hybrid` (default on).
- **Tool safety tiers** (`constants.ToolTier` + `tools/base.py`): safe / managed /
  requires_approval / forbidden capability firewall; the investigator gates
  non-safe tools (proposes them for human approval, never auto-executes).
- **Cost provenance** (`llm/pricing.py`): `pricing_source` (exact / heuristic /
  zero / default) + a tier-prefix price heuristic, threaded onto every `UsageDoc`.

### Changed
- **Hardened untrusted-data fencing** (`agents/prompts.py` `fence()`): neutralises
  forged close-markers and carries `source=`/`tool=` provenance (non-negotiable #9).
- **Archived the legacy Kibana plugin** → `archive/kibana-plugin/` (history
  preserved). The standalone webui is now the sole supported surface.

## [2.0.0] — 2026-06-21 — Vendor-agnostic, self-hosted agentic SOC

The project transitions from an ELK/Kibana-coupled triage suite into an
**open-source, self-hosted, vendor-agnostic agentic SOC**. It now ingests from any
SIEM/EDR/XDR, normalises everything to OCSF, and ships its own standalone web UI —
the Kibana plugin becomes legacy/optional. Backend offline suite: **221 tests
green**; standalone web UI builds clean (`tsc` + Vite).

### Added

- **OCSF canonical schema** (`backend/app/ocsf/`). Every record, whatever its
  origin, is normalised to OCSF (with an ECS→OCSF mapping) before the engine
  reasons over it.
- **Connector SPI + registry** (`backend/app/connectors/`). A `PullConnector` /
  `PushReceiver` SPI, a process-wide registry, and a `tlsoc.connectors`
  entry-point group so out-of-tree connectors install via `pip` and appear in the
  wizard with zero core change.
- **PULL connectors — Elasticsearch, OpenSearch, Wazuh.** Poll an ES-API-compatible
  search API on a durable cursor (Wazuh reads the OpenSearch-based Wazuh indexer);
  per-source field mapping is set in the wizard.
- **16 PUSH / queue / object-store receivers + push runtime.** webhook, Splunk-HEC,
  syslog, Kafka, AWS SQS, AWS Kinesis, Azure Event Hub, GCP Pub/Sub, RabbitMQ,
  NATS, MQTT, Redis Streams, S3, GCS, Azure Blob, file. Formats parsed:
  JSON / NDJSON / CEF / LEEF / GELF / syslog / kv; optional client libs imported
  lazily (no new hard dependency). HTTP push lands via `POST /api/ingest/{source_id}`;
  syslog/queue/object-store receivers run as background receivers; all flow into the
  same `correlate → risk → cost-gate → LLM → case` pipeline the poller feeds.
- **Per-source secrets.** `POST /api/sources/{id}/secrets` stores secret field
  values in the in-memory secret tier (never persisted); only the field NAMES are
  recorded on the source.
- **Multi-source wizard backend.** `GET /api/connectors` (+ `/{source_type}`) lists
  every connector and its auth/config field schema; `GET|POST|DELETE /api/sources`
  and `POST /api/connectors/test` add, update, remove, mark-primary, and test
  sources.
- **SQL StateStore** (`backend/app/stores/sql/`). `STATE_BACKEND` selects where the
  app's OWN state (cases/audit/usage/config/cursor/RAG) lives: `elasticsearch`
  (default), `postgres` (asyncpg + pgvector), or `sqlite`. With postgres/sqlite, no
  Elasticsearch is required at all.
- **Standalone web UI + first-run wizard** (`webui/`, Vite + React +
  `@elastic/eui`). The new primary front door: a self-hosted SPA talking to the
  backend directly over `/api`, with a multi-step setup wizard (connector picker +
  dynamic per-connector form + connection test, LLM providers + per-role models,
  enrichment/detection defaults), a sources manager, and full Preferences editing.
- **Deploy artifacts.** `deploy/docker-compose.agnostic.yml` — a self-contained
  stack (Postgres+pgvector + Redis + backend + web UI; open http://localhost:8080,
  add the SIEM in the wizard) — plus a web UI container image (`webui/Dockerfile`).

### Changed

- **Kibana plugin is now legacy/optional.** The standalone `webui/` replaces it as
  the primary UI; the plugin and the legacy `deploy/docker-compose.tlsoc.yml`
  (merge-into-ELK) path remain for existing ELK deployments.

## [Unreleased]

Work-order cycle (live status in [`ROADMAP.md`](ROADMAP.md); session notes in
[`Journal.md`](Journal.md)). 8.19.12 zip rebuilt + verified; backend
`pytest -q` = 124 passed; plugin `tsc` clean. (Offline-verified only — there is no
live-stack validation this cycle.)

### Case detail flyout + unified cards + Settings nav (done)
- **Click-to-open now opens a right-side flyout** (`case_detail_flyout.tsx`) over any
  surface — no more scrolling to a detail panel at the bottom. The flyout has a header
  (entity + verdict/status/risk/confidence), tabs (Overview · Agent trace · History ·
  Ask) and a sticky footer with the contextual lifecycle actions + Re-investigate.
- **One unified case card** (`case_card.tsx`) and **one grid** (`case_grid.tsx`) now back
  Investigate, Automated Scans, and the Board: a severity-banded accent, a prominent
  (restrained) risk number, verdict/status chips, hover + selected states.
- **Grid controls:** a KPI strip, a sort control (risk/date), a filter popover
  (status · risk band · verdict) with removable active-filter chips, and an auto-filling
  responsive grid that fills the width. Shared case logic lives in `lib/cases.ts`.
- **Settings** now uses a **left section navigation** (all sub-sections listed on the
  left, the selected section on the right) instead of an accordion stack — every field
  preserved.
- **Full-width layout** (`restrictWidth={false}`) across the app to use the previously
  wasted horizontal space; a `casesVersion` signal keeps the grids in sync after a
  lifecycle change in the flyout. Removed the superseded inline `case_detail.tsx`.

### UI redesign — shared design system + every surface (done)
- **New shared design system.** `public/lib/format.ts` (date/money/number/percent
  formatters + `humanizeToken`) and `public/components/ui.tsx` (the single
  `COLORS` palette + `tint()`; `verdict/status/risk` colour helpers; reusable
  `SectionHeader`, `StatTile`, `EmptyState`, and `RiskBadge`/`VerdictBadge`/
  `StatusBadge`/`ConfidenceBadge`); plus layout utilities in `public/index.scss`
  (`tlsocIconChip`, `tlsocStatTile`, `tlsocCard`, `tlsocBoard__*`). No new deps.
- **Case Board** now usable: a **visible drag handle** AND a per-card actions menu
  (Open / Close / Escalate / Reopen) — both routed through the same confirm flow —
  fix the "can't move the cards" problem; columns sit in a horizontal scroll lane
  with coloured headers; cards carry a verdict/status accent + shared badges.
- **Investigate ("Security Investigation")** rebuilt to a supplied reference design:
  an IP/user/host search bar (`EuiFieldSearch`), an **Active Cases** 3-column card
  grid (ENTITY/RISK/RULES/CREATED with a prominent colour-coded risk number and a
  status pill), Refresh + a functional **Filters** popover, and a tall "Select a case
  to begin Agentic Triage" prompt that swaps to the case detail + follow-up chat on
  selection. A subtle global footer was added to the app shell. Uses the previously
  wasted horizontal/vertical space.
- **Automated Scans** rebuilt from a plain table into a KPI strip + a responsive
  card grid (entity icon, shared verdict/status/risk/confidence badges, formatted
  timestamps, Open / Reproduce / Why-this-fired) with a proper empty state.
- **Cost & Tokens** rebuilt into KPI tiles + weighted breakdown cards (proportional
  bars), a tidy dependency-free cost-over-time list, and a resilient top-cost-driver
  table.
- **Settings** visually refreshed (section header, accented section icons,
  `EuiHealth` credential status) with **every field and handler unchanged**.
- **App shell** — page-header description, per-tab icons + clearer nomenclature
  (Chat / Investigate / Case Board / Automated Scans / Standup / Cost & Tokens /
  Settings), wider layout. **Standup / Investigate / Case detail / Verdict card**
  adopt the shared badges + headers for a consistent console.
- Behaviour, data contracts, and the backend↔plugin API are unchanged — this is a
  presentation-only pass over the existing surfaces.

### Cycle 2 — bug fixes (done)
- **BUG-1 — chat does a real 2-turn analysis.** Turn 1 only chooses the query
  (before any rows exist); after the `es_query` runs, the engine re-prompts over a
  **compact, fenced-UNTRUSTED aggregate** of the results (top facets + time span +
  a few sample rows, never the raw dump) so chat shows analysis, not just a
  "fetching logs" preamble + table. Degrades to the turn-1 answer + row-count
  summary on any model error; both turns are metered (`agents/chat.py`,
  `prompts.CHAT_SYSTEM`).
- **BUG-2 — investigate no longer 400s on a fixed `now-24h` window.** New
  `Preferences.investigate_lookback` + per-request `InvestigateRequest.lookback` +
  an auto-widen ladder (configured → `now-7d` → `now-30d` → `now-365d`); the
  frontend renders a **neutral empty-state** ("No events found …") instead of a
  red error.
- **BUG-3 — the Standup tab no longer blanks.** `aggregate.cases` is now an object
  (`{ opened, by_status, by_verdict }`); the FE renders the opened tile +
  by-verdict / by-status tables, wrapped in an **error boundary**.
- **BUG-4 — header chat button contrast.** The global chat button is a native
  `EuiHeaderSectionItemButton` (correct light/dark contrast).
- **BUG-5 — correlation over a sliding look-back window.** Correlation now runs
  over the widest configured rule window (plus a margin, never less than a poll
  interval), not just the incremental poll batch, so a real-time burst spread
  across more than one poll interval still reaches its threshold
  (`engine/poller.py`).
- **IMPROVEMENT — manual-investigation provenance.** Manual investigations get a
  synthesized `TriggerReason` ("Why this fired"), a preserved `origin_surface`, and
  a normalized `reproduce_query`.

### Cycle 3 — features (done)
- **C3-1 — config-driven rule catalog.** `Preferences.rule_catalog` of
  `RuleDefinition { name, enabled, match{field,op,value}, correlation,
  model_override, priority }`; seeds the 13 real `event.module` rules + 5
  ModSec sub-rules (`modsec_xss`/`sqli`/`lfi`/`rce`/`scanner` by `rule.id` prefix,
  lower priority) into `tlsoc-agent-config` on first run. **Version-guarded** —
  never clobbers operator edits. Editable in Settings; this is how XSS-specific
  triggering is enabled.
- **C3-2 — Board tab.** A drag-and-drop Kanban of cases
  (Open · Needs human (escalated) · Closed); a drag maps to `close` / `reopen` /
  `escalate`.
- **C3-3 — agent trace.** `GET /api/cases/{id}/trace` + an "Agent trace" timeline
  on the case detail (router / investigator / tool-calls / verdict / formatter /
  case-manager, projected from `tlsoc-agent-audit`). `prefs.trace.include_prompts`
  gates whether prompt excerpts are returned.
- **C3-4 — re-investigate a stored case.** `POST /api/cases/{id}/investigate` + an
  Investigate button on stored cases; re-runs the agent in place (`force=True`),
  preserving provenance.
- **C3-5 — resolved-case RAG baseline.** Closing / confirm-FP indexes the case
  (entity + rules + verdict + risk + analyst note + trigger reason) into the
  resolved-case RAG store; the close modal has a note textarea; future
  investigations see a "Prior analyst decisions (baseline)" block. Gated by
  `rag.enabled` + `rag.use_resolved_cases`; fail-safe.
- **C3-6 — expanded model catalog + per-rule models.** Added OpenAI
  `gpt-4.1` / `gpt-4.1-mini` / `gpt-4-turbo` / `gpt-4` / `o4-mini` / `gpt-5` /
  `gpt-5-mini` to `pricing.py` (operator-verifiable approximate prices) + per-model
  param quirks (`gpt-5`/o-series omit `temperature`, use `max_completion_tokens`) +
  per-rule model overrides (`Preferences.rule_model_override`; `model_for_rule`
  precedence: `RuleDefinition.model_override` → `rule_model_override` → per-role)
  with a Settings table.
- **C3-7 — merged case history timeline.** The case history is now a merged,
  de-duplicated `EuiCommentList` timeline.

### Added (prior cycle — done)
- **Feature 1 — Global header chat button + context-aware flyout.** `plugin.ts`
  registers `core.chrome.navControls.registerRight`; `global_chat_control` +
  `global_chat_flyout` reuse the Chat engine; `lib/screen_context.ts` snapshots
  app/data-view/time-range/query/selection at send time; backend `ChatContext` /
  `ChatRequest.context`, fenced as UNTRUSTED and used only as es_query defaults.
- **Feature 2 — Per-log "AI overview".** Discover doc-viewer tab ("TLSOC AI
  Overview", guarded `unifiedDocViewer` registration) + in-app per-row overview
  button; backend `POST /api/overview` single-event agent on the cheap
  `overview_model`, metered through the gateway, reusing IP enrichment.
- **Feature 3 — "Why was this triggered".** `TriggerReason` (deterministic matched
  window + human sentence) carried onto every case and rendered in scans + case
  detail; case index-template priority raised to 600.
- **Feature 4 — Comprehensive settings + per-task model selection.** `settings.tsx`
  renders EVERY `Preferences` field; per-role model pickers from `GET /api/models`.
- **RAG (P1).** `use_resolved_cases` retrievable memory; ES `dense_vector` kNN
  store behind the `VectorStore` ABC; mixed-embedding-space guard (clear+reseed,
  no truncation); min-cosine threshold; richer query; chat grounded in RAG.

### Deferred
- **Feature 5 — wizard rewrite.** The original 4-step wizard is functional; the
  enhancement (dataViews create, auto-suggest, per-role models) is best validated
  against a live 8.19 Kibana. Tracked in ROADMAP.

### Changed (done this cycle)
- **P0 — Case detail + lifecycle in the UI.** Selected case lifted into app
  state; case-detail rehydrates via `GET /api/cases/{id}`; table rows open the
  stored case (no re-investigate); `VerdictCard` lifecycle controls →
  `POST /api/cases/{id}/action`.
- **P1 — Case/verdict stability + provenance.** Don't re-run the LLM pipeline on
  an already-investigated open case every attach; preserve original surface;
  keep verdict history.
- **P2 — Risk/verdict correctness.** CIDR asset tagging; velocity edge case;
  enforce `caps.timeout_seconds` in the investigator loop; normalize
  `reproduce_query` syntax.

## [1.0.0] — 2026-06-16

Phase-1 POC of the agentic SOC triage suite — a read-only consumer alongside the
TrustLab / IIT Bombay ELK pipeline.

### Added
- **Backend (FastAPI + LangGraph) — the full agentic spine.** Durable-cursor
  polling → deterministic correlation → deterministic risk scoring → cost gate →
  cheap router → strong investigator (ReAct) → formatter → deterministic Case
  Manager (close/escalate; a TRUE_POSITIVE is never auto-closed). Tools:
  `es_query` (read-only logs), `enrich` (Redis-cached AbuseIPDB/VirusTotal),
  `rag_retrieve`. One LLM gateway with a usage/cost ledger for every call.
- **Two-scoped-key Elasticsearch model.** Physically separate read-only
  (`all-logs-*`) and management (`tlsoc-agent-*`) clients; never `kibana_system`
  or the superuser at runtime (`es/client.py`).
- **The suite's own indices:** `tlsoc-agent-{cases,audit,usage}-*` plus the
  single-doc `tlsoc-agent-config` and `tlsoc-agent-cursor`.
- **Append-only audit trail** and **prompt-injection fencing seam** (all
  log-derived values wrapped as UNTRUSTED data).
- **Kibana plugin (React + EUI)** — five surfaces (Chat, Investigate/Alerts,
  Automated Scans, Daily Standup, Cost) plus Settings/Wizard; a thin viewer that
  talks to the backend only through the Kibana server-side proxy `/api/tlsoc/*`.
- **Plugin artifact for Kibana 8.12.2** (`plugin/dist/tlsocAgenticTriage-8.12.2.zip`)
  and bundled saved-object dashboards (Audit + Cost & Tokens).
- **Deploy assets** — `deploy/docker-compose.tlsoc.yml`, index-template mappings,
  dashboards; `.env.example`.
- **Offline test suite** (fake ES + mock LLM) — 49 backend tests green.

### Security
- Applied a security/correctness review pass over the backend (commit
  `942bc49`): scoped-key separation, fail-to-human on every error path, and the
  prompt-injection fencing seam.

## [Plugin build 8.19.12] — 2026-06-16

- **Built the plugin for Kibana 8.19.12** from the single source tree
  (`plugin/dist/tlsocAgenticTriage-8.19.12.zip`), keeping the 8.12.2 artifact.
  Portability via `@kbn/*` import aliases + `--kibana-version` stamping; legacy
  `kibana.json` manifest; Node 22.22.0, no bazel. No backend or contract change
  between versions (`COMPATIBILITY.md`).

## [Docs] — 2026-06-16

- **Exhaustive build/deploy/usage/troubleshooting guides** (commit `585647b`):
  `plugin/BUILD.md`, `DEPLOY.md`, `docs/USAGE.md`, `docs/TROUBLESHOOTING.md`,
  `COMPATIBILITY.md`.
- **Coordination & context docs** (commit `a9db0af`): `CLAUDE.md` (master
  context), `Journal.md` (work diary), `ROADMAP.md` (live work tracking),
  `docs/ENVIRONMENT.md` (the two environments).

[Unreleased]: https://claude.ai/code/session_01JxMk6xXxXEgQ1JKUnD7EF6
