# Round 4 — IMPLEMENTATION (what shipped, per wave)

> Companion to [`PROPOSAL.md`](PROPOSAL.md) (the approved plan) and
> [`RESEARCH-SYNTHESIS.md`](RESEARCH-SYNTHESIS.md) (the design grounding). This is the
> **as-built** record: what each wave delivered, the new modules, and the endpoint
> surface. Branch **`Testing`**, **local — not pushed**.
>
> **Outcome:** Round 4 — "fix the logic, fine-tune the product." **12 user requests +
> 3 confirmed bugs delivered across Waves 0–6.** **Additive, default-OFF, zero new
> runtime dependencies, `engine/case_manager.py` `decide()`/`apply()` byte-identical**
> (guard test), and the **12 non-negotiables held throughout** — in particular **#1**
> (every per-source connector still forces the mgmt key to `None`; the new `/api/logs`
> scatter-gather is read-only and never returns secrets), **#3** (the deterministic
> close/escalate decision is still the ONLY producer of CLOSED — the tuner, campaigns,
> baseline, and event-detection all steer *what gets investigated*, never the verdict;
> candidate cases from the EVENT funnel re-enter the SAME `correlate → decide()`
> pipeline), **#4** (per-`{source.id}:{feed.id}` durable cursor + a per-signature lock
> so concurrent sources never duplicate a case; campaigns only *reference* case_ids,
> never re-cluster), **#6** (one LLM-gateway ledger write per real call — including the
> new batch path, which is an atomic claim-before-bill exactly-once), and **#9** (every
> new log/source/operator/AI-influenceable value is fenced before a prompt and escaped
> in the UI; the EVENT-detection funnel feeds the model a fenced aggregate, #7).
>
> **Green baseline:** backend **1234 → 1461 pytest** (W0 1235 · W1 1253 · W2 1263 ·
> W3 1371 · W4 1437 · W6 1461) · webui `tsc + vite` clean · **vitest 205 → 273** ·
> eslint 0 `react-hooks/rules-of-hooks` errors.
>
> **Commit chain:** `068ede4` (docs) → `3aeab6c` (W0) → `41ee54b` (W1) → `f7509a3`
> (W2) → `b07f172` (W3) → `11ea46e` (W4) → `3c68cf5` (W5) → `1df27ac` (W6 audit +
> harden).

---

## The 12 requests + 3 bugs → where they landed

| # | Request / Bug | Wave(s) | Headline |
|---|---------|---------|----------|
| — | **Bug 1 — single-source poller** | W2 | `engine/poller_manager.py` fans out over every enabled PULL source (per `{source.id}:{feed.id}` cursor + legacy-`"primary"`-cursor-collision guard + per-signature lock so concurrent sources never duplicate a case, #4) |
| — | **Bug 2 — `claude-opus-4-8` mispriced** | W0, W3 | `$15/$75 → $5/$25`; cache rates now applied (read 0.1× / write 1.25×-5m / 2×-1h) + batch 0.5×; wired the dead `providers.with_retry()` |
| — | **Bug 3 — acknowledge did nothing** | W4 | `acknowledge` now sets `CaseStatus.INVESTIGATING` (was `None`) + stamps `acknowledged_at` |
| 1 | Two-tier ingestion (ALERT vs EVENT) | W3, W4 | ALERT feeds = realtime per-alert; EVENT feeds = a batched agent-driven detection funnel creating candidate cases (`engine/event_detection.py`) |
| 2 | Adaptive threshold tuning | W3, W4 | `engine/threshold_tuner.py` — nightly deterministic auto-tuner (Wilson-LB + min-samples + EWMA + shadow-eval + bounded +1 step + rollback; DROPs → HITL Proposal; default OFF) |
| 3 | Daily campaign correlation | W3, W4 | `engine/campaigns.py` — daily deterministic shared-entity graph → `Campaign` objects that *reference* case_ids only, never re-cluster (#4) |
| 4 | Entity baselining "over time" | W3, W4 | `engine/baseline.py` — online EWMA/EWMV + 168 hour-of-week buckets + bounded t-digest + modified-z |M|>3.5 + 3×-period warm-up (H=14d slow); pure producer |
| 5 | Batch / flex economics | W3 | `llm/batch.py` `BatchProvider` SPI (Anthropic Message Batches + OpenAI Batch + flex), custom_id-keyed idempotent; cache rates applied in `cost_for` |
| 6 | Broad multi-provider Models | W0, W3, W5 | Opus-4.8 price fix + broadened Anthropic family; cache/batch pricing columns on the Models page |
| 7 | Unified logs view | W4, W5 | `GET /api/logs` unified scatter-gather over browse-capable sources + `UnifiedLogsSheet` |
| 8 | Tiered reset + fresh OOBE | W4, W5 | `engine/reset.py` (cases / sources / factory tiers, NEVER wipes env secrets) + `routes_setup.py` (OOBE first-admin, strong-pw, self-locking) |
| 9 | Cleaner case view | W5 | Single primary CTA + a unified Close-with-disposition dialog (still posts through `decide()`, #3) |
| 10 | Analytics declutter | W5 | One tab strip; Cost is the single home; de-duped posture |
| 11 | Login white-label + branding | W1, W5 | `BrandingConfig.login_*` bounded plain-text (validator rejects any `<`, #9) + `BrandHero` / curated layouts |
| 12 | Terminology cleanup | W1, W5 | UI/docs vocabulary lock (event / detection / alert / case / campaign); wire keys + aliases kept |

> **Terminology note (UI/docs only — wire keys + aliases unchanged):** "correlate" was
> split in the prose into *Auto-investigate* / *clustering* / *campaign-correlation*;
> "rule" into *detection-rule* / *case-automation*. `AutomationRule` was renamed
> `CaseAutomationRule` with a module alias kept, and the stored wire key
> `threshold_automation` round-trips verbatim.

---

## Wave 0 — pricing fix + retry wiring + UI glitches (`3aeab6c`)

Four disjoint fixes + one clean-room verifier. All additive.

- **Bug 2 (price)** — `claude-opus-4-8` corrected **$15/$75 → $5/$25** in all THREE
  coordinated places (`llm/pricing.py` `PRICES` + `_TIER_HEURISTIC`;
  `llm/model_registry.json` incl. cache 18.75/1.5 → 6.25/0.5 + ctx 200K → 1M) +
  broadened the Anthropic family (fable-5 10/50, opus-4-7 5/25, sonnet-4-6 3/15 ctx→1M,
  haiku-4-5 1/5). Cache-rate *application* was deliberately deferred to W3 (it needs the
  `UsageDoc` / `CompletionResult` / provider chain); the non-cache cost math stayed
  byte-identical, no second `UsageDoc` write (#6), demo `pricing_source='zero'`
  unaffected.
- **Bug 2 (retry)** — wired the dead `providers.with_retry()` around the raw
  `self._client.post` in the Anthropic / OpenAI `.complete` / `.embed` paths (the gateway
  was untouched).
- **UI glitches** — `ui/hover-card.tsx` `collisionPadding` default 8 (right-edge clip);
  `SettingsGrid.tsx` `min-w-0 flex-1` + description `break-words` (one-word-per-line);
  `CaseDetail.tsx` de-duplicated the Collaboration/Feedback tabs and renamed the
  grading-only component `CollaborationTab → FeedbackTab` so value ↔ label ↔ component
  agree.
- **Risk help (#8-style clarity)** — a `HelpTip` on the RiskBreakdownBars authored
  VERBATIM from `risk.py` (weights **25/20/30/15/10**, Reputation heaviest) with an
  honest "ranks, never closes" caveat; synced the duplicated string across
  `priority.py` + `CaseTriageHeader.tsx`.

Tests: backend **1234 → 1235** (+1 provider-retry); vitest **205 → 214** (+9);
`case_manager.py` byte-identical (#3).

---

## Wave 1 — additive hot-file contracts (`41ee54b`)

One coordinated pass over the three interdependent hot files (`constants.py` /
`models.py` / `config.py`) so later waves never re-edit the headers. All defaulted,
zero behavior change, zero new deps.

- **`constants.py`** — `ActionType.{TUNING, RESET}`; 4 enums (`CampaignStatus` /
  `BatchJobState` / `DetectionSource` / `ResetScope`); 4 KV-namespace triples
  (`CAMPAIGNS` / `BASELINE` / `BATCH_JOBS` / `TUNING`).
- **`models.py`** — `UsageDoc` +`cache_read_tokens` / `cache_write_tokens` / `batch`
  (data-only; cost unchanged, W3 applies the rates); new `CampaignEntity` / `Campaign` /
  `BaselineState` (Welford + EWMA + t-digest centroids) / `BatchJob` / `DetectionRule`
  (a composite match + trigger carrier, not yet rewired); `Case` +advisory
  `campaign_id` / `detection_source` (kept OUT of `case_manager.py`).
- **`config.py`** — `ThresholdTuningConfig` / `BatchConfig` (severity_floor=3) /
  `BaselineConfig` (H=14d, warmup=3, mod-z=3.5, tdigest=100) / `CampaignConfig` — **all
  default OFF**; `CapsConfig.max_concurrent=3`; `BrandingConfig.login_*` bounded
  plain-text with a validator that rejects any `<` (no markup, #9) + curated
  illustration keys; `AutomationRule → CaseAutomationRule` with a module alias
  (approve/reject routes + the stored `threshold_automation` wire key round-trip
  verbatim).
- **`settings_schema.py`** — titles for the new blocks.

Tests: backend **1235 → 1253** (+18 `test_round4_wave1_contracts.py` incl. old-dict
back-compat, alias, legacy wire-key, branding `<`-rejection, #3 guard);
`case_manager.py` byte-identical (grep: no `campaign_id` / `detection_source` /
`automation`).

---

## Wave 2 — PollerManager multi-source fan-out (`f7509a3`) — THE bug fix

Bug 1, the #1 incoherence: the poller only ever polled a single source. One backend
owner (`state.py` is a hot file) → clean-room verifier.

- **NEW `engine/poller_manager.py`** — `PollerManager(state)` IS `state.poller`; it owns
  N per-source `Poller` children. It enumerates enabled PULL sources
  (`registry.is_pull` or `ingest_mode == PULL`; receivers skipped). The PRIMARY child =
  `state.log_source` (so the 0-/1-source path is byte-identical); every NON-primary
  source gets its connector via `state.es_client_for_source(src)` (which forces the mgmt
  key to `None`, #1) with `connector_id = src.id`, and the owned client is tracked +
  closed on rebuild/stop (no leak).
- **Cursor-collision guard (#4)** — un-fed non-primary sources get a distinct
  `f"{src.id}:primary"` legacy cursor key so two un-fed sources never stomp the shared
  `"primary"` doc; the true primary keeps `"primary"` (no migration). `poll_once` fans
  out under a `caps.max_concurrent` semaphore + a per-tick in-flight guard keyed on the
  cluster `signature`, and aggregates per-source stats.
- **`poller.py`** — the entity-strategy line now resolves *its own* source
  (`prefs.source_by_id(self._source.connector_id)`), not the primary.
- **`state.py`** — `Poller → PollerManager`; `rebuild_log_source` calls
  `poller.rebuild()`; `startup` calls `rebuild_log_source()` after the persisted prefs
  load so a multi-source boot polls all. Shares the ONE pipeline / gateway / cases /
  audit / cursor_store (#6). `state.poller` still exposes
  `start` / `stop` / `poll_once` / `_source` / `_attach`.

Tests: backend **1253 → 1263** (+10 `test_round4_wave2_poller_manager.py`:
both-sources-polled, no-cursor-collision, single/zero-source legacy-cursor parity,
per-source `connector_id` gate, per-source entity strategy, owned-client close,
demo-off, #1 mgmt-key); `case_manager.py` byte-identical (#3).

---

## Wave 3 — engine capabilities (`b07f172`)

The big engine wave: 4 parallel disjoint builders → event-detection (depends on
baseline + batch) → integrator (`state.py` store-wiring) → verifier. All additive +
default OFF.

- **LLM economics** — `pricing.cost_for` now applies cache rates via keyword-only args
  (read 0.1×, write 1.25× [5m] / 2× [1h], batch 0.5×; the non-cache path stays
  byte-identical); `providers.py` extracts Anthropic/OpenAI cache tokens into
  `CompletionResult` + an OpenAI `service_tier='flex'` opt-in; `gateway._record`
  populates the `UsageDoc` cache/batch fields (still ONE write per call, #6). NEW
  `llm/batch.py` `BatchProvider` SPI (Anthropic `/v1/messages/batches` + OpenAI
  `/v1/batches`; results are UNORDERED → keyed by `custom_id`). NEW
  `stores/batch_jobs.py` (resume-safe; a per-`custom_id` `retrieved` dedup → exactly one
  `UsageDoc` per result at the 0.5× batch rate, #6).
- **Adaptive tuner** — NEW `engine/threshold_tuner.py` + `stores/tuning.py`: a
  deterministic nightly observer computing a per-rule FP rate via Wilson-LB (z=1.96) +
  min-samples (25) + EWMA; it auto-applies a bounded **+1** to a `CorrelationRule.n` or a
  feed `severity_floor` with an `ActionType.TUNING` audit + rollback; a **shadow-eval**
  blocks any change that would have hidden a confirmed TP; suppression DROPs are routed
  to the HITL Proposal queue instead of applied. It is a config-writer only — it NEVER
  imports `case_manager` / `decide` / the risk weights / the signature logic. Default
  OFF.
- **Campaigns** — NEW `engine/campaigns.py` + `stores/campaigns.py`: a daily
  deterministic graph of cases sharing an entity (reuses the cross-source RELATED
  machinery); ≥2 cases + ≥1 shared entity → a `Campaign` (idempotent = a hash of the
  sorted member signatures). It only REFERENCES case_ids — never re-clusters or closes
  (#3/#4).
- **Baseline** — NEW `engine/baseline.py` + `stores/baseline.py`: an online EWMA mean +
  EWMV variance per `cluster_signature` per 168 hour-of-week buckets
  (α = 1 − exp(−ln2/H), H=14d slow), Welford alongside, a bounded t-digest
  (compression 100) for p50/p95/p99, a robust modified-z |M|>3.5, and a 3×-period
  warm-up. It is a deterministic pure PRODUCER — it never reads `decide()` or the risk
  weights.
- **Event-detection** — NEW `engine/event_detection.py`: a 4-stage cheap-first funnel
  (pre-aggregate → rules → anomaly [baseline] → batched Haiku detection; #7
  aggregate-only, #9 fenced) whose survivors re-enter `correlate` under the SAME
  `cluster_signature` (#4); the `custom_id` is hashed. NEW `engine/forwarding.py`
  (`explain_forwarding` — a read-only 7-gate explainer).
- **Integrate** — `state.py` wires the Tuning / Campaign / Baseline / BatchJob stores +
  the 4 services into `AppState`, all gated OFF (schedulers / routes / feed-routing land
  in W4).

Tests: backend **1263 → 1371** (+108: llm 21, tuner 15, campaigns 15, baseline 19,
event-detect 29, wiring ~4, + parametrize expansions); `case_manager.py` byte-identical
(#3, grep-clean across all 6 new modules); no `cluster_signature` reassignment (#4);
batch one-`UsageDoc`/result + dedup proven (#6).

---

## Wave 4 — API surface + runtime wiring (`11ea46e`)

The routes + runtime wave: 6 parallel owners on disjoint files → `main.py` integrator →
verifier (route-auth-coverage + reset-secrets + default-off checks). Every new router
mounts under `require_auth`.

- **Tuning / batch** — NEW `routes_tuning.py` (dry-run recommendations · config get/put ·
  per-rule apply/rollback, `automation:*` gated, `ActionType.TUNING` audited; a
  shadow-blocked change raises → HITL Proposal, never auto-applied) + `routes_batch.py`
  (read-only job listing, secret-free).
- **Campaigns / baseline** — NEW `routes_campaigns.py` (list / get / by-case + an
  admin-gated `recorrelate` that never mutates case status, #4) + `routes_baseline.py`
  (stats + a per-signature warm-up gauge with p50/p95/p99).
- **Reset (Bug/req 8)** — NEW `engine/reset.py` + `routes_reset.py`: `POST
  /api/admin/reset {scope, confirm}` (admin + `require_fresh_auth`, type-to-confirm
  `RESET CASES` / `RESET SOURCES` / `FACTORY RESET`). Cases-tier clears
  cases/campaigns/baseline/inbox/collab/batch-jobs/live-tail but KEEPS the cost ledger +
  audit; sources-tier adds sources + cursors; factory adds
  users/sessions/prefs/roles/proposals/memory/branding + flips `setup_complete = false`
  → OOBE. **Env secrets are byte-identical across ALL tiers (an airtight test)**;
  every reset is audited before it acts (#2); the SQL backend factory-reset truncates
  tables while preserving secrets.
- **OOBE (req 8)** — NEW `routes_setup.py`: `POST /api/setup/account` (public,
  self-locking, creates the FIRST super_admin; forces a strong password [min-12, ≠
  username, not-common], MFA prompted-optional). `Admin / Admin@123` survives only as the
  auth-OFF default. `/api/setup/*` was added to `deps.PUBLIC_API_PATHS`. (`GET
  /api/setup/status` is already served by the monolith router.)
- **Monolith (`routes.py`)** — **Bug 3**: `acknowledge → CaseStatus.INVESTIGATING`
  (non-terminal, not a close, #3) + stamps `acknowledged_at`. NEW `GET /api/logs`
  (scatter-gather over browse-capable sources, `asyncio.gather(return_exceptions=True)` +
  per-source `wait_for`, mandatory source provenance, secrets never returned, #1
  read-only) + `GET /api/cases/{id}/forwarding` (explain_forwarding) + `GET
  /api/sources/health`.
- **Schedulers + feed-routing** — `state.py` / `poller.py` spawn gated background
  schedulers (nightly tuner / daily campaign / batch-jobs poller — spawn-but-sleep when
  disabled, byte-identical boot); EVENT feeds route to the funnel ONLY when batch +
  baseline are both enabled (default-off = the existing realtime path byte-identical;
  ALERT feeds are always realtime; demo/kill-switch gate off).

Tests: backend **1371 → 1437** (+66); `test_route_auth_coverage.py` PASS (setup
public-allowlist correct); `case_manager.py` byte-identical (acknowledge is
INVESTIGATING, not CLOSED; no route closes outside `decide()`); reset env-secret
preservation airtight across all 3 tiers (#1/#10); default-off boot byte-identical.

---

## Wave 5 — webui surfaces + consolidation (`3c68cf5`)

The last big feature wave: surface every new backend capability + cleanup. 8 disjoint
surface builders → integration (done directly by the orchestrator after the integrator
agent overran twice). Backend untouched (empty backend diff).

- **Unified logs** — `UnifiedLogsSheet` over `GET /api/logs` (mandatory
  source-provenance column, 10s live-tail, a partial-failure strip, #9 plain-text).
- **Tuning + campaigns** — a Tuning page (recommendations table + apply/rollback +
  config, honest "only changes what's investigated, never closes" framing, DROP →
  Approvals) + a Campaigns page + a `CampaignChip`.
- **Baseline + batch** — `BaselineGauge` components (warm-up n/target gauge + p50/p95/p99
  + a stats overview) + a BatchJobs viewer.
- **Cleaner case view (req 9)** — a single primary CTA + overflow, and a unified
  Close-with-disposition dialog that posts the existing close → `decide()` (#3).
- **Analytics declutter (req 10)** — one tab strip, Cost as the single home, de-duped
  posture.
- **Login white-label + OOBE (req 11 / 8)** — `BrandHero` renders
  `BrandingConfig.login_*` bounded plain-text + 3 curated layouts + illustrations (no raw
  HTML/SVG, #9); the OOBE account-setup step is wired to `/api/setup/*`.
- **Models (req 6)** — cache/batch pricing columns on the Models catalog.
- **Danger Zone (req 8)** — 3 tiered type-to-confirm reset cards (super_admin,
  env-secrets-preserved copy) mounted in Settings → Experimental.
- **Integration (orchestrator)** — `nav.ts` new PageIds
  (logs/campaigns/tuning/batchjobs/baseline) + nav entries + icons; REMOVED the dead
  `NavGroupIds 'automation' + 'admin'`. `App.tsx` +5 `React.lazy` imports + render arms.
  A `pages/Baseline.tsx` fetch wrapper. `<DangerZone/>` mounted in Experimental.

Tests: webui build exit 0; **vitest 214 → 273** (+59 across 9 new W5 specs); lint 0
rules-of-hooks errors; #9 audited (no `dangerouslySetInnerHTML` on data; login
white-label plain-text); backend untouched.

---

## Wave 6 — adversarial audit + harden (`1df27ac`)

A Round-3-style audit close-out. **6a** = a 16-dimension READ-ONLY audit fleet (16
auditors + per-finding skeptics that refute-by-default). **6b** = 5 disjoint fix owners
+ a full-gate verifier.

- **Result: 16 confirmed / 4 refuted** (2 HIGH, 6 MEDIUM, 8 LOW; some deduped:
  event-detection dead-end ×2, openai-cache ×2, inflight-guard ×2). All 16 fixed +
  regression-tested.
- **HIGH — poller concurrency (#4)** — a per-`cluster_signature` `asyncio.Lock` on the
  ONE pipeline serialises `find_open_by_signature → save` across the fan-out so
  concurrent sources/ticks create exactly ONE case (`pipeline._sig_locks` +
  `ingest.handle_clusters` holds it around the critical section).
- **HIGH — poller reentrancy** — DELETED an `_InflightGuard` monkeypatch of the shared
  `pipeline.investigate_cluster`; replaced with a per-manager `_poll_lock` serialising
  whole fan-out ticks (loop vs manual `/api/poll`).
- **MEDIUM — event-detection now REALLY creates cases** — `BatchJob.candidates`
  persists the funnel survivors at submit, and `_reenter_detections` reconstructs +
  feeds each confirmed result through `register_candidate` + `investigate_cluster` → the
  SAME `cluster_signature` (#4), UNCHANGED `decide()` (#3), gated default-OFF.
- **MEDIUM — tuner** — the shadow-eval reader now pages CLOSED + RESOLVED
  (`TERMINAL_CASE_STATUSES`) so it isn't blind to RESOLVED TPs; the tuner is cadence-gated
  (`last_run_at` + `already_tuned`) so a knob bumps once per window (was unbounded).
- **MEDIUM — OpenAI prompt-cache double-bill** — the provider now passes the UNCACHED
  remainder as full-rate input (the Anthropic path was already correct).
- **MEDIUM — OOBE** — the legacy public `/api/setup/init-admin` was REMOVED (it bypassed
  the strong-pw policy); the sole first-admin writer is now the policy-enforced
  `/api/setup/account`. Migrated `test_oobe` / `test_rbac_users` off `init-admin`.
- **LOW** — `process_results` dedup is now an atomic CAS claim-before-bill (#6
  exactly-once under concurrency); the funnel hook propagates to ALL fan-out children +
  the primary; setup self-lock fails SAFE (raising `has_any()`) + is race-safe; the
  t-digest centroid count is now bounded ~O(compression) (was unbounded).

Tests: backend **1437 → 1461** (+24 regression across
concurrency/event-reentry/tuner-cadence/openai-cache/oobe/tdigest); `case_manager.py`
byte-identical (#3, event-detection re-enters via the normal pipeline, never calls
`decide()`); the 2 HIGH fixes test-locked (concurrent same-signature → 1 case;
monkeypatch gone); #6 batch atomic + openai-cache proven; webui build exit 0.

---

## Two-tier ingestion (as-built)

The core "fix the logic" of Round 4 is a clean split of the pipeline by feed intent
(default OFF; when off, everything is byte-identical to the pre-round realtime path):

- **ALERT feeds** — realtime, per-alert (the existing path). Every alert flows through
  `correlate → risk → cost-gate → router → investigator → decide()` immediately. A
  **daily campaign correlation** pass then links RELATED cases into `Campaign` objects
  (references only, never re-clusters, #4).
- **EVENT feeds** — batched, agent-driven detection. Raw events go through a cheap-first
  **funnel** (`engine/event_detection.py`): pre-aggregate → deterministic rules →
  baseline anomaly (`engine/baseline.py`) → a batched Haiku **detection** pass (an
  aggregate, #7; fenced, #9). Survivors become **candidate cases** that re-enter the SAME
  `correlate → decide()` pipeline under the same `cluster_signature` (#3/#4) — so the
  deterministic close/escalate decision is never bypassed. Engages only when batch +
  baseline are both enabled.

**Adaptive tuning** rides on top: a nightly deterministic observer measures a per-rule FP
rate and applies a bounded, audited, rollback-able +1 step (or routes a suppression DROP
to HITL) — steering *what gets investigated*, never the verdict.

**Batch / flex economics** (req 5) run the EVENT-detection LLM work (and any opt-in
batchable path) through the `BatchProvider` SPI at the 0.5× batch rate. Results come back
UNORDERED and are reconciled by `custom_id` (a hash of the signature); the claim
(`retrieved` CAS) + billing is exactly-once (#6), and each result still flows to the same
`decide()` (#3).

---

## Endpoint surface (Round 4 additions)

Mounted under `require_auth`; every non-GET route carries an authZ gate
(`test_route_auth_coverage.py` enforces this). New routers use the `/api` prefix.

**Unified logs / forwarding / source health** (`routes.py`)
- `GET /api/logs` — scatter-gather over browse-capable sources (read-only, secret-free,
  mandatory source provenance, #1)
- `GET /api/cases/{case_id}/forwarding` — `explain_forwarding` (read-only 7-gate)
- `GET /api/sources/health`

**Adaptive tuning** (`routes_tuning.py`)
- `GET /api/tuning/recommendations` (dry-run) · `GET/PUT /api/tuning/config`
- `POST /api/tuning/{rule_id}/apply` · `POST /api/tuning/{rule_id}/rollback`
  (`automation:*` gated, `ActionType.TUNING` audited)

**Campaigns** (`routes_campaigns.py`)
- `GET /api/campaigns` · `GET /api/campaigns/{campaign_id}` ·
  `GET /api/cases/{case_id}/campaign`
- `POST /api/campaigns/recorrelate` (admin-gated, never mutates case status, #4)

**Baseline** (`routes_baseline.py`)
- `GET /api/baseline/stats` · `GET /api/baseline/{signature}` (warm-up gauge +
  p50/p95/p99)

**Batch jobs** (`routes_batch.py`)
- `GET /api/batch/jobs` · `GET /api/batch/jobs/{job_id}` (read-only, secret-free)

**Reset** (`routes_reset.py`)
- `POST /api/admin/reset` — `{scope, confirm}` (admin + `require_fresh_auth`,
  type-to-confirm; env secrets never wiped)

**OOBE setup** (`routes_setup.py`)
- `POST /api/setup/account` — public, self-locking first-super_admin (strong-pw enforced)
- (`GET /api/setup/status` is already served by the monolith router)

---

## Environment / secrets — no changes

Round 4 introduced **no new env vars and no new `Secrets` fields.** The new
capabilities are all **`Preferences.*` UI-editable toggles** that **default OFF**
(`threshold_tuning`, `batch`, `baseline`, `campaign`, `caps.max_concurrent`,
`BrandingConfig.login_*`), and the batch/flex path **reuses the existing OpenAI /
Anthropic keys** — there is no new key to set. Verified by diffing the full Round-4
backend change set for any new `os.environ` / `getenv` read or `Secrets` field (none
found). Accordingly, **`docs/ENVIRONMENT.md` and `.env.example` are unchanged this
round.**

---

## Invariants held (verification)

- **#1 (read-only, scoped key)** — the PollerManager forces the mgmt key to `None` for
  every per-source client; `GET /api/logs` is read-only and never returns secrets;
  reset preserves env secrets byte-identical across all tiers.
- **#3 (deterministic close)** — `git diff` on `case_manager.py` empty across the whole
  round; the tuner/campaigns/baseline/event-detection modules are grep-clean of
  `case_manager` / `decide`; the EVENT funnel's candidates re-enter the normal pipeline;
  the unified Close dialog still posts through `decide()`; a guard test asserts the new
  advisory `Case` fields are never referenced in `case_manager.py`.
- **#4 (no skip / no dup; idempotent)** — per-`{source.id}:{feed.id}` durable cursor +
  the legacy-`"primary"` collision guard + a per-`cluster_signature` lock so concurrent
  sources create exactly one case; campaigns only reference case_ids, never re-cluster.
- **#6 (one ledger write per call)** — cache/batch fields populate the SINGLE `UsageDoc`;
  the batch path is an atomic claim-before-bill exactly-once under concurrency; the
  OpenAI cache double-bill was fixed.
- **#7 (aggregate-then-summarise)** — the EVENT-detection funnel feeds the model a fenced
  aggregate, never raw logs.
- **#9 (untrusted data fenced/escaped)** — funnel input, unified-logs rows, campaign
  entities, and the login white-label are all fenced (prompts) / escaped (UI);
  `BrandingConfig.login_*` rejects any `<`; no `dangerouslySetInnerHTML` on data.
- **Zero new runtime deps** (backend stdlib-first — batch via `httpx` to the vendor
  Batch endpoints, SigV4-style auth kept stdlib; webui composes already-installed
  primitives).

---

## Deferred / known items (honest)

- **Admin-page consolidation-REDIRECTS (req 4-adjacent)** — the standalone admin pages
  still render standalone (they work and deep-link fine); the planned refactor to
  *redirect* them under Settings was flagged as the top-risk item in the webui map and
  deliberately deferred. Nothing is broken — this is a navigation-cleanup follow-up.
- **A dead `api.setup.initAdmin` webui stub** — never called (the live flow uses
  `/api/setup/account`); a trivial prune-later left after the backend `init-admin` route
  was removed in W6.

---

## Green baseline (verified 2026-07-01)

- backend **1461 pytest** pass (1234 → 1235 → 1253 → 1263 → 1371 → 1437 → 1461)
- webui `tsc --noEmit && vite build` exit 0 · **vitest 273** (205 → 214 → 273)
- eslint **0 `react-hooks/rules-of-hooks` errors** (3 benign `exhaustive-deps` warnings)
- `engine/case_manager.py` **byte-identical** across the whole round
- **zero new runtime deps**; branch **`Testing`**, local — **not pushed**.
