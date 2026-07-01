# Round 4 — "fix the logic, fine-tune the product" — PROPOSAL

> Status: **AWAITING USER APPROVAL** (no code written yet). Branch: `Testing`.
> Inputs: Phase-1 understanding (15 Opus readers + synth, honest coherence audit) +
> Phase-2 research (18 Opus web-researchers, **18/18 web-verified**, + synth) +
> authoritative Anthropic model/pricing/batch data (claude-api skill).
> Invariants held by every item: **#3** `case_manager.decide()` byte-identical & never
> influenced by new code; **#4** `cluster_signature` idempotency byte-identical; **#6** one
> `UsageDoc` per LLM call (incl. batch); **#9** untrusted text fenced/escaped; **#1** two-key
> ES. Additive, **zero new runtime deps**, KVStore zero-migration stores.

---

## 0. The honest verdict (you were right that something's off)

The deterministic spine (decide(), correlation, idempotency, risk model, Demo Mode, the LLM
gateway) is genuinely well-built. But the audit found **real structural bugs**, not just
polish gaps:

1. **🐞 Single-source poller (the big one).** `state.py` wires the poller to ONE "primary"
   source, so **only that source is ever polled/correlated/triaged** — any other sources you
   add sit inert. This is the literal cause of "what is a primary source?" (#2) and why
   multi-telemetry is hard (#3).
2. **🐞 Stale Opus 4.8 price** = `$15/$75` in `pricing.py` (correct: `$5/$25`) — a ~3×
   over-charge on every cost figure. Cache-write/read rates in `model_registry.json` are
   stored but **never applied**.
3. **🐞 "Acknowledge" no-ops.** The case action maps to `None` — clicking it does nothing.
4. **Terminology collisions.** "correlate" means 3 different things; "rule" means 3 different
   things — the root of the confusion in #2/#9.
5. **No batch/flex; dead retry code.** Pipeline is strictly one-cluster-at-a-time;
   `with_retry()` is fully written but never called.
6. **30 page files, heavy duplication** — 5 admin pages exist as BOTH standalone routes AND
   Settings sections; cost is split 4 ways; posture timing appears on 3 pages.

---

## 1. What you asked me to explain (sources · correlation · risk · rules · adaptive tuning)

### Primary source
Today one source is "primary," and a hidden side effect is that **only that source is polled**
(the bug). We split the overloaded flag into two honest ideas, exactly like Splunk/Elastic/
Sentinel: **(1) Collection is per-source and always parallel** — a new `PollerManager` fans out
every tick across every enabled source, each on its own durable cursor, so a slow feed never
blocks a fast one and one failing source never stops the others. **(2) "Primary" shrinks to a
read-time convenience** ("default search surface") — it only picks which source backs ad-hoc
browsing + the chat/es_query tool, like Splunk's default index. Collection no longer depends on it.

### Automated correlation
Correlation turns many noisy events into one reviewable case by grouping events that share an
**entity** (IP → host → user → rule) within a window, opening **one case per entity** (re-seeing
the same entity attaches to the OPEN case — that's idempotency). **Grouping never drops
anything.** The confusion: three toggles all say "correlate" but actually control a *separate*
decision — whether a cluster is auto-**forwarded** to the (paid) AI investigation. We rename
those to **"Auto-investigate"** and add an `explain_forwarding()` helper so each cluster can tell
you, in plain English, exactly which gate decided whether it got investigated.

### The 5 risk factors (the `(?)` help, authored verbatim from `risk.py`)
A 0–100 score blended from five deterministic factors (the AI interprets it, never sets it):
- **Volume** — how many events (levels off ~50 so huge clusters don't dominate).
- **Velocity** — events/min (full near 10/min); reads **0** below 3 events or sub-second windows
  so a millisecond burst can't fake a 100.
- **Reputation** — worst threat-intel reputation among the cluster's IPs; **IP-only**, 0 if no IP.
- **Diversity** — distinct rule-types fired (maxes at 5).
- **Asset criticality** — how important the targeted asset is (CIDR/exact map; 0 if uncatalogued).
- Default weights: Reputation 30 / Volume 25 / Velocity 20 / Diversity 15 / Asset 10 (retunable).
- The honest line in the tooltip: **the risk score only ranks what's investigated first — it
  never closes or escalates a case on its own.**

### Alert-triggering rules (Sigma-style two halves)
A rule has a **classify** half ("this IS a brute-force attempt", simple field matches) and a
**fire** half ("open a case when N occur in a window grouped by entity", or every/never). Keeping
them separate is what lets you tune noise (raise N, tighten the window, add an exception) without
changing what counts as a detection. A *third* object runs AFTER the deterministic decision and
can only tag/recommend/notify — never set status; we rename it so it stops sharing the word "rule".

### Adaptive threshold auto-tuning (the headline #2 capability — built safe)
Built the way every major SIEM does: a **separate deterministic OBSERVER** on a schedule (not in
the live path, never an AI deciding). On a cadence (e.g. nightly) it reads recently-**closed**
cases over a trailing window and computes, per rule, a **false-positive rate** (closed cases
marked FP/benign) + a smoothed volume trend. When a rule is genuinely noisy **and** has enough
samples to be statistically meaningful (min-sample floor + **Wilson lower-bound** so a 3-of-3
fluke can't trip it), it proposes a **small, bounded** change — raise N by ≤1 step, or raise the
feed's severity-floor (which gates auto-investigation but, by design, never drops the alert).
**Two hard rails:** (1) **blast-radius tiering** — low-impact changes are auditable + one-click
rollback; any actual suppression DROP **always** goes through the existing human-approval queue;
(2) **shadow-eval** — replays the proposed threshold over the past window and forces human review
if it would have hidden even one confirmed real threat. It **defaults OFF**, and the
non-negotiable line: tuning **only changes which events get investigated** — it never reads or
influences `decide()`, never changes risk weights, and (because case identity is entity-based,
not threshold-based) changing N never re-shuffles your open cases (#3/#4).

---

## 2. Cross-cutting foundations (build-once)

1. **`PollerManager` multi-source fan-out** (`engine/poller_manager.py`) — fixes the bug;
   per-source connector via `es_client_for_source()`, per-feed cursor isolation, single-poll
   fallback when `prefs.sources` empty. Underpins #3, #4, #12.
2. **Unified logs endpoint** `GET /api/logs` — read-only scatter-gather across browse-capable
   sources (`asyncio.gather(return_exceptions=True)` + per-source `wait_for`, predicate pushdown,
   `heapq.merge` on `(-ts, source_id, id)`, `search_after` cursor). Row provenance mandatory.
3. **Detection-Rule unification + `explain_forwarding()`** — compose (not replace) `CorrelationRule`
   (fire) + `RuleMatch` (classify) into one additive `DetectionRule` (migrate-on-read); rename
   `AutomationRule → CaseAutomationRule` (alias kept); the 3 "correlate" toggles → "Auto-investigate"
   in UI/docs only (wire keys + aliases unchanged).
4. **Threshold-tuner observer** (`engine/threshold_tuner.py` + `stores/tuning.py`) — see §1; mirrors
   the `threshold_automation.py` #3 boundary; never imports `decide()`.
5. **Batch/flex gateway + price fix + caching** (`llm/*`, `models.py`) — fix Opus 4.8 price, apply
   the stored cache rates in `cost_for` + add cache tokens to `UsageDoc`; `BatchProvider` SPI
   (Anthropic `/v1/messages/batches` 50%-off, OpenAI `/v1/batches` + `service_tier:"flex"`) with a
   KVStore `BatchJobStore`; `custom_id` = hashed `cluster_signature` (idempotent, #4); one
   `UsageDoc` per result (#6); `decide()` per result, byte-identical (#3). Wire the dead `with_retry`.
6. **Page/IA consolidation** — Settings is canonical home; 5 double-existing pages → thin redirects;
   collapse the 1/1/1 Notifications nav group; delete dead `NavGroupId` members; flatten Analytics
   to one tab strip with Cost as the single cost home; per-section "Restore defaults".

---

## 3. Per-request plan (all 11 + the 3 bugs)

| # | Request | Scope | Core |
|---|---------|-------|------|
| 1 | Fix UI glitches | S | Hover-card `collisionPadding` (clip), SettingsCard `break-words`+`flex-1` (vertical text), merge swapped Collaboration/Feedback tabs — fix at the primitive layer + Vitest specs |
| 2 | Sources + correlation + **adaptive auto-tuning** | L | PollerManager + rename toggles + `explain_forwarding()` + the threshold-tuner observer (see §1) |
| 3 | Unified multi-telemetry logs | M | `GET /api/logs` scatter-gather + `UnifiedLogsSheet` (source=all + Source column + live-tail) |
| 4 | Consolidate pages/logic | L | The poller bug fix + terminology unification + 30-page → redirects/nav cleanup |
| 5 | Fine-tune how it works | M | Prompt caching (biggest $, restructure prefix #9-safe) + bounded-concurrency Semaphore + batch partition |
| 6 | Better + customizable login | M | Additive `BrandingConfig` login_* (headline/body/chips/layout enum split\|centered\|full/curated illustration) — bounded plain-text, no raw HTML/SVG; live BrandingEditor preview |
| 7 | Reset button | S | Per-section "Restore defaults" (guarded confirm) via existing `PUT /settings` — never clears sources/secrets/setup/demo |
| 8 | `(?)` risk-factor help | S | `riskHelp.ts` authored verbatim from `risk.py` (incl. honest caveats) on the RiskGauge/breakdown |
| 9 | Cleaner case view | M | Footer → single primary CTA + overflow; **fix acknowledge→INVESTIGATING**; merge Close+Confirm-FP into one Close-with-disposition dialog |
| 10 | Declutter analytics | M | One tab strip (Operational\|Performance\|Posture\|Cost), Cost as the single cost home, de-dup posture timing |
| 11 | More models + pricing + **flex/batch** | L | Fix Opus 4.8 price; broaden the catalog (Anthropic full family + OpenAI/others) with batch + cache columns; BatchProvider + job store |

New endpoints: `GET /api/logs`; `GET /api/tuning/recommendations`, `POST /api/tuning/{rule}/apply|rollback`,
`GET/PUT /api/tuning/config`, `GET /api/cases/{id}/forwarding`; (opt) `GET /api/batch/jobs`,
`GET /api/sources/health`.

---

## 4. Build sequencing (waves)

- **Wave 0** — Pricing fix + cache rates applied + wire `with_retry` + the UI-glitch sweep + the
  `(?)` risk help (no hot-file contention).
- **Wave 1** — Contracts: `models.py`/`config.py`/`constants.py` once, sequenced (UsageDoc cache/
  batch fields, `threshold_tuning`/`batch`/`caps.max_concurrent` + login_* prefs, `Proposal.kind+='tuning'`,
  `ActionType.TUNING`, `is_primary→is_default_read_surface` alias, `AutomationRule→CaseAutomationRule`
  alias, additive `DetectionRule` + migration).
- **Wave 2** — `state.py`: factor source-construction helper; build `PollerManager` (the bug fix) +
  per-signature in-flight guard.
- **Wave 3** — Engine: `threshold_tuner.py` + `stores/tuning.py`; `explain_forwarding()`; bounded
  concurrency + realtime/batch partition; `BatchProvider` + `stores/batch_jobs.py` + batch poller;
  per-rule noise metric; prompt-prefix restructure.
- **Wave 4** — `routes.py` once, sequenced: acknowledge fix + unified Close dialog; `GET /api/logs`;
  `/api/tuning/*`; rule-noise metric; source health.
- **Wave 5** — webui IA + surfaces: consolidation redirects + nav cleanup; analytics declutter + Cost
  home; per-section reset; `UnifiedLogsSheet`; CaseDetail footer; Login white-label; tuning/health UI.
- **Wave 6** — Test fan-out (incl. #3-boundary tuner tests, price-fix tests, batch idempotency,
  unified-logs partial-failure), docs, Journal.

Each wave: Opus builder fan-out → integrator for hot files → Opus verifier; `pytest`+`webui` green
gate between waves. Commits drop the Claude co-author trailer per your instruction.

---

## 5. Decisions (recommended defaults in **bold**; the 4 that change the build are asked in chat)

1. **Auto-tuning**: defaults **OFF**; once enabled, low-blast-radius tuning — *your call:
   auto-apply (truly automatic, with audit+rollback+shadow-eval) vs propose-only*. Suppression
   DROPs always HITL. Target FP-rate raise >0.30 / relax via hysteresis; min_samples 20–30;
   max_step +1 N/cycle; nightly cadence.
2. **Batch/flex**: defaults **OFF** (byte-identical); only latency-tolerant work batched
   (low/med-severity enrichment, backfill, digests, re-investigation sweeps); high-severity always
   realtime. *Your call on default + severity floor.*
3. **Reset**: per-section "Restore defaults" **only** (recommended); *optionally* a guarded
   "Restore ALL". Never clears sources/secrets/setup/demo.
4. **Models/providers**: fix Opus 4.8 price + broaden catalog. *Your call: how broad + add OpenAI
   flex/batch + Bedrock now?*
5. Prompt-cache TTL: **5-min** for the poller path, **1-h** for long analyst chat (adopted).
6. Login ceiling: bounded plain-text + curated code-defined layouts/illustrations, **no raw
   HTML/SVG** (adopted; no per-tenant domain isolation yet).
7. Cross-source correlation stays **per-source**; cross-source links remain the opt-in RELATED pass
   (merging would break idempotency) (adopted).
8. Concurrency default **~3** concurrent investigations, operator-tunable (adopted).

---

## 6. REFINED PLAN (post understand-fleet + research-fleet) — supersedes §0–§5 where noted

> Built from: a 60-reader codebase-understanding fleet (maps persisted at
> `understand/01…06-*.md` — the rate limit trimmed live coverage, but the highest-value
> readers landed and pinned every bug to a line) + a re-run web-research fleet
> (`RESEARCH-SYNTHESIS.md` + `research/area-c.md`) + the authoritative **claude-api**
> reference (pricing / caching / Batches all verified). This section is the source of truth
> for the build.

### 6.1 Corrections to the original proposal (authoritative — from the code)
- **Risk weights are `25/20/30/15/10` — Reputation is HEAVIEST (0.30), not Volume.** §1's
  "30/25/20/15/10" was wrong (code `config.py:463`). The `(?)` help must match the code, and
  the string is **duplicated** at `engine/priority.py:262` + `soc/…/CaseTriageHeader.tsx:203`
  (edit both). Neither currently states the honest "ranks, never closes" caveat on the *risk*
  chip — add it.
- **Bug #1 (poller) is `state.py:203` + `:218`** (+ hardcoded `entity_strategy_for(primary_source())`
  at `poller.py:232`). New **#4 hazard the map found:** two un-fed sources both fall to the legacy
  `"primary"` cursor doc and stomp each other — the PollerManager must key non-primary un-fed
  sources distinctly (e.g. `"{source.id}:primary"`) while keeping the true primary on `"primary"`
  (no migration). It must also build every per-source connector via `es_client_for_source()`
  (forces `es_mgmt_api_key=None`, #1) with `connector_id=src.id` (or per-source auto_correlate/
  ignore/severity_floor gates silently break), track+close **all** owned clients, and gate every
  child on `polling_enabled/setup_complete/not kill_switch/not demo_active`.
- **Bug #3 (Acknowledge) is ONE line at `api/routes.py:3136`** (`_ACTION_STATUS["acknowledge"]=None`
  → `CaseStatus.INVESTIGATING`). Do **not** add it to `_CLOSE_ACTIONS`/`_TERMINAL`. Optional #10
  polish: also stamp `acknowledged_at` for MTTA.
- **The `decide()` guard forbids the literal substring `"automation"` in `case_manager.py`.** The
  tuner + campaign + baseline code must live in **new** modules and never touch that file.
- **Per-rule FP-rate does NOT exist yet** (`metrics.py` FP-rate is verdict-level over all cases).
  The tuner needs a **new** per-rule metric keyed on `Case.rule_ids`, reusing `metrics.py`'s safe
  helpers (`percentile`/window-filter) but never imported into a decision path; page the closed-case
  read (don't reuse the naive 200-cap).
- **`CapsConfig` has no `max_concurrent`** — add one (additive, default ~3) for the fan-out semaphore.
- **Tuner targets read live:** `correlate()` reads `CorrelationRule.n` every poll and the connector
  reads feed `severity_floor` every poll, so the tuner is a pure **config writer** — no pipeline
  change. `cluster_signature` hashes only `("cluster", entity_type, value)`, so raising `n`/floor
  changes future volume, never case identity (#4 holds by construction).

### 6.2 Two NEW subsystems the research added (both additive, both out of `decide()`)
- **Campaign correlation** (`engine/campaigns.py` + `stores/campaigns.py`, KV zero-migration,
  `Campaign` model + `CampaignStatus`, `api/routes_campaigns.py`). A scheduled (default **daily**)
  deterministic pass that groups related **cases** into a separate `Campaign` object via the existing
  `cross_source`/RELATED machinery (namespace `"xsrc"`, time-bucketed) — it only *references*
  `case_ids`, never re-clusters, never mutates `cluster_signature`, never imports `case_manager`.
  Idempotent by sorted-member-signature hash. This is the ALERT-feed "investigate the bunch too."
- **Entity baseline / anomaly producer** (`engine/baseline.py` + `stores/baseline.py`,
  `BaselineState` model, `Preferences.baseline`). This is the precise answer to *"how does the base
  improve over time?"* → **online, single-pass streaming stats updated recursively once per
  observation**, per `cluster_signature`, per **168 hour-of-week** bucket: **EWMA mean + EWMV
  variance** (`s_t = α·x_t + (1−α)·s_{t−1}`, decay exposed as **half-life H, default slow 14 days**,
  `α = 1−exp(−ln2/H)`) + a per-entity **t-digest** (compression 100) for p50/p95/p99; flag via robust
  **modified-z `|M|>3.5`** (MAD-based, not 3σ); **warm-up = 3× period (3 weeks)** surfaced in the UI.
  It is a pure **producer** of candidate cases for the EVENT-feed funnel — deterministic (stable
  order, pinned compression, versioned state), never reads `decide()`, never touches risk weights,
  NEEDS_HUMAN still never auto-closes.

### 6.3 Two-tier ingestion (the user's data-stream vision, made concrete)
- **ALERT feeds** (`Feed.role=="alerts"`): unchanged realtime per-alert investigate spine + the
  daily **campaign** pass (§6.2). Base "improves over time" via the resolved-case→RAG loop + the
  baseline warm-up + tuner noise-learning.
- **EVENT feeds** (`Feed.role=="events"`): a 4-stage **cheap-first funnel** —
  pre-aggregate (per-entity/hour-of-week buckets, #7 "never raw logs to a model") → Sigma-style
  DetectionRule pass → §6.2 anomaly gate (`|M|>3.5`) → **batched LLM detection** on survivors only.
  Each LLM-confirmed candidate becomes a candidate case that re-enters the SAME
  `correlate → handle_clusters → pipeline → decide()` path (unchanged). New `engine/event_detection.py`
  + `DetectionSource` enum (`detection|anomaly|rule`) records provenance. **Cost verdict (sourced):
  viable only behind the funnel** — batch (0.5×) × cache-read (~0.1× on the shared rubric prefix) ×
  Haiku-vs-Opus (~0.2×) collapses a night of events to cents–low-dollars; raw un-funnelled events to
  any model is NOT viable. High-volume EVENT feeds stay OUT of the realtime correlation-window read.

### 6.4 Authoritative model catalog + pricing (claude-api-verified) — replaces the `$15/$75` bug
Per-MTok. Batch = 0.5× in/out; cache-read = 0.1× input; cache-write 1.25× (5-min) / 2× (1-h).
| Model | in | out | batch in/out | cache-read | min-prefix | ctx |
|---|--|--|--|--|--|--|
| `claude-fable-5` | $10 | $50 | $5 / $25 | $1.00 | 2048 | 1M |
| `claude-opus-4-8` | **$5** | **$25** | $2.50 / $12.50 | $0.50 | 4096 | 1M |
| `claude-opus-4-7` | $5 | $25 | $2.50 / $12.50 | $0.50 | 4096 | 1M |
| `claude-sonnet-4-6` | $3 | $15 | $1.50 / $7.50 | $0.30 | 2048 | 1M |
| `claude-haiku-4-5` | $1 | $5 | $0.50 / $2.50 | $0.10 | 4096 | 200K |
Plus OpenAI (incl. Batch + `service_tier:"flex"`), Google Gemini, and the Round-3 Azure/Bedrock/Vertex
providers, each with in/out/cache/batch columns. `pricing.cost_for` must **apply the stored cache
rates** (currently ignored) and add cache/batch token fields to `UsageDoc`. Wire the dead
`providers.with_retry()`.

### 6.5 Batch/flex — resume-safe, idempotent state machine (verified sound)
`BatchProvider` SPI (Anthropic `/v1/messages/batches`; OpenAI `/v1/batches` + flex) + KVStore
`BatchJobStore` (`BatchJob`/`BatchJobState = submitted→polling→retrieving→retrieved (+errored/expired)`).
`custom_id = sha256(cluster_signature)[:N]`; results arrive **unordered** so we key by `custom_id`;
per-`custom_id` `retrieved:bool` gives exactly-once → **one UsageDoc per result (#6)** → one
`decide()` per result (#3). Resume-safe: on restart, reload any job not `retrieved`, re-poll
`processing_status`, skip already-retrieved ids. **Constraint:** Anthropic Batches ≤100k reqs/256 MB,
<1h typical/24h max, retained 29 days, and **not available on Bedrock/Vertex/Foundry** (those use
OpenAI Batch or run realtime). Batching **defaults OFF**; only latency-tolerant work (EVENT funnel,
low/med-sev enrichment, backfill, digests) batches — high-severity always realtime.

### 6.6 Reset — tiered danger zone (`POST /api/admin/reset {scope,confirm}`, admin + fresh-auth)
`ResetScope = cases | sources | factory`, GitHub-style type-to-confirm per tier, `ActionType.RESET`
audited before acting.
| Tier | clears | keeps | token |
|---|---|---|---|
| Cases only | cases/campaigns/baseline/inbox/activity/batch-jobs/live-tail rings | sources, secrets, users, settings, RAG | `RESET CASES` |
| Sources+logs | tier-1 **+** `Preferences.sources[]` + cursors | secrets, users, settings, setup | `RESET SOURCES` |
| Factory | everything in StateStore + prefs + users + `setup_complete=false` → fresh OOBE | **env-provided secrets only** | `FACTORY RESET` |
**HARD rule: never wipe env-provided secrets** (`TLSOC_*`/`ES_API_KEY`/LLM keys/`STATE_DB_URL`);
only wizard/in-memory + per-source connector secrets clear (tiers 2/3). Reset only ever touches the
mgmt/state side (#1, #12 — upstream `all-logs-*` untouched); it destroys cases but never *runs*
`decide()` (#3).

### 6.7 OOBE with account setup (`POST /api/setup/account`, self-locks after first success)
A NEW first-run "Create admin account" step (grounded in Grafana/Kibana/Splunk/Wazuh/GitLab):
username + display-name + **force-set strong password** (server policy) + optional MFA, reusing
`auth/passwords.py`/`stores/users.py`/`auth/service.py`. Replaces the `Admin/Admin@123` seed as the
operator credential; the seed survives **only** as the auth-OFF/offline-test default (unchanged).
Factory reset (`setup_complete=false`) restarts into it; env secrets remain so the operator can
immediately create the admin.

### 6.8 Terminology lock (UI/docs only; wire keys + aliases kept)
Canonical nouns **event · detection · alert(candidate) · case · campaign**. "correlate" →
**Auto-investigate** (per-source/feed forwarding toggle) / **clustering** (the fn) / **campaign
correlation** (RELATED pass). "rule" → **detection-rule (match/trigger)** / **case automation**
(`AutomationRule → CaseAutomationRule`, Python + TS alias kept; wire key `threshold_automation`
unchanged). `.auto_correlate`, `config['index_patterns']`, `config['auto_correlate']` are load-bearing
— never renamed in code.

### 6.9 Revised wave plan (adds campaigns/baseline/event-detection to §4)
- **W0** — price fix (`$5/$25`) + apply cache rates + wire `with_retry` + the 3 UI glitches
  (hover-card `collisionPadding`; SettingsCard `break-words`+`flex-1`; CaseDetail merge swapped/dup
  Collaboration↔Feedback tabs) + the `(?)` risk help (verbatim, corrected 25/20/30/15/10 + caveat).
- **W1** — hot-file contracts once (`models.py`/`config.py`/`constants.py`): UsageDoc cache/batch
  fields; `Campaign`/`CampaignStatus`/`BaselineState`/`BatchJob`/`BatchJobState`/`DetectionSource`/
  `ResetScope`; `ActionType.{TUNING,RESET}`; `Preferences.{threshold_tuning,batch,baseline,caps.max_concurrent}`
  + login_* branding; `AutomationRule→CaseAutomationRule` alias; additive `DetectionRule` migrate-on-read.
- **W2** — `state.py` + **`engine/poller_manager.py`** (the bug fix, with the legacy-cursor-collision
  guard) + per-signature in-flight guard.
- **W3** — engine: `threshold_tuner.py`+`stores/tuning.py` (auto-apply observer) · `explain_forwarding()`
  · bounded-concurrency semaphore + realtime/batch partition · `BatchProvider`+`stores/batch_jobs.py`+batch
  poller · per-rule noise metric · prompt-prefix restructure (cacheable) · `engine/campaigns.py`+`stores/campaigns.py`
  · `engine/baseline.py`+`stores/baseline.py` · `engine/event_detection.py`.
- **W4** — `routes.py` once + new routers (`routes_tuning`/`routes_logs`/`routes_campaigns`/`routes_batch`/
  reset/setup): acknowledge fix + unified Close dialog · `GET /api/logs` · `/api/tuning/*` ·
  `/api/campaigns/*` · `/api/baseline/*` · `/api/batch/jobs` · `/api/admin/reset` · `/api/setup/{account,status}`
  · `/api/cases/{id}/forwarding` · `/api/sources/health`.
- **W5** — webui IA: page consolidation + nav cleanup · analytics declutter (Cost as the one cost home) ·
  per-section reset + DangerZone · UnifiedLogsSheet · CaseDetail single-CTA + Close-with-disposition ·
  Login white-label · OOBE AccountSetupStep · Models catalog+pricing · tuning/campaign/baseline surfaces.
- **W6** — big test fan-out (#3-boundary tuner/campaign/baseline tests, price-fix, cache-rate, batch
  idempotency by custom_id, unified-logs partial-failure, reset never-wipes-secrets, OOBE) + docs + Journal.
Then an adversarial audit fleet + harden pass (Round-3 pattern). Per wave: builder fan-out → integrator
for hot files → clean-room verifier; `pytest -q` + `npm run build` + `vitest` green between waves. Commits
drop the Claude co-author trailer.
