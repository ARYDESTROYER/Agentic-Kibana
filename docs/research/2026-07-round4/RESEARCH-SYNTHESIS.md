# Round 4 — Research Synthesis (refined design)

> Status: **AWAITING USER APPROVAL.** Branch `Testing`. This document refines the
> two locked product decisions — (A) two-tier ALERT/EVENT ingestion, (B) RESET +
> OOBE — plus the four supporting pieces the fleet flagged (baseline-over-time,
> Batch/Flex API, terminology, and the wiring of both back into the pipeline).
> It is grounded in the Area briefs (area-c on disk) + authoritative vendor docs;
> **every load-bearing claim carries a source URL**.
>
> Invariants held by every item below, verbatim from the codebase:
> **#1** two physically-separate ES clients (read-only `all-logs-*` + mgmt `tlsoc-agent-*`);
> **#3** `engine/case_manager.decide(verdict, confidence, risk_score, policy)` byte-identical
> and the ONLY producer of a closed/escalated case, NEEDS_HUMAN never auto-closes;
> **#4** `engine/signatures.cluster_signature(entity_type, entity_value)` byte-identical
> (entity-based case identity); **#6** ONE `llm/gateway.py` writes exactly one `UsageDoc`
> per call; **#9** all attacker-influenceable text fenced/escaped. Additive, zero new
> runtime deps, KVStore zero-migration stores (mirror `stores/user_prefs.py` /
> `stores/proposals.py`).

---

## 0. TL;DR of what this ADDS to `PROPOSAL.md`

`PROPOSAL.md` already scoped: PollerManager multi-source fan-out, the Opus-4.8 price
fix + cache-rate application, a `BatchProvider` SPI + `BatchJobStore`, and terminology
renames. This synthesis makes four of those **concrete and load-bearing**, and adds two
genuinely new subsystems the proposal did not have:

1. **NEW — Campaign correlation object** (`engine/campaigns.py` + `stores/campaigns.py`):
   a daily pass over ALERT-derived cases that groups related cases into a *separate*
   `Campaign` object. It never touches `cluster_signature` or re-clusters primary cases.
2. **NEW — Entity baseline + anomaly candidate producer** (`engine/baseline.py` +
   `stores/baseline.py`): the EWMA/EWMV + hour-of-week + t-digest model from area-c that
   turns raw EVENTS into candidate cases — a pure *producer* that never reads `decide()`.
3. Batch/Flex is promoted from "SPI" to a **resume-safe state machine** with
   `custom_id`-keyed idempotency proven against #6/#3.
4. RESET + OOBE are fully specified (they were only a one-line "Restore defaults" in the
   proposal); RESET now has **tiered scopes** with a hard "never wipe env secrets" rule.

The one thing that **changes** the proposal's stance: PROPOSAL.md §5.2 says batch is
"only latency-tolerant work." This synthesis keeps that default but adds a **specific,
sourced cost verdict** that LLM-over-raw-EVENTS detection *is* viable — but only behind a
cheap-first anomaly/rules funnel, never as a blanket "send all events to a model."

---

## 1. TWO-TIER INGESTION

### 1.1 Vocabulary lock (used throughout; full table in §4)

- **event** — one raw OCSF record from an EVENTS feed (`Feed.role == "events"`).
- **detection** — a pre-classified finding on an ALERTS feed (`Feed.role == "alerts"`);
  the upstream SIEM already decided "this is suspicious."
- **alert (candidate)** — a cluster our pipeline decides is worth investigating (from a
  detection, OR synthesised by the EVENTS anomaly funnel). Identity = `cluster_signature`.
- **case** — the audited, decided unit produced by the deterministic pipeline.
- **campaign** — a read-time grouping of *related cases* into one incident. NEW object.

### 1.2 ALERT feeds → realtime per-alert + daily campaign correlation

**Realtime per-detection investigation (unchanged spine).** Each detection on an
`alerts` feed is normalised to OCSF, correlated by entity into a cluster
(`cluster_signature`, #4), risk-scored, cost-gated, optionally forwarded to the two-tier
LLM investigation, and closed/escalated by `decide()` (#3). This is exactly today's path;
Round 4 only fixes the single-source poller bug (PollerManager, per PROPOSAL.md §2.1) so
*every* alerts feed is polled, not just the "primary" one.

**Daily CAMPAIGN correlation pass (NEW, additive, out of `decide()`).** SOC practice and
every major SIEM group related *alerts/cases* into a higher-order **incident/campaign**
so an analyst reviews one attack story instead of 40 rows. This is the standard
alert→incident aggregation model:

- Elastic Security groups related alerts into **cases**/attack discovery; the "alert vs
  case" separation is explicit.
  <https://www.elastic.co/guide/en/security/current/cases-overview.html>
- Microsoft Sentinel/Defender XDR **correlate alerts into incidents** — "an incident is a
  collection of related alerts."
  <https://learn.microsoft.com/en-us/azure/sentinel/investigate-cases>
- MITRE ATT&CK models an intrusion as a **campaign** = related activity over time against
  targets, tied to techniques.
  <https://attack.mitre.org/campaigns/>

**Concrete design.**

- `engine/campaigns.py :: correlate_campaigns(cases, window, links) -> list[Campaign]`.
  A **deterministic, scheduled** pass (default daily, operator-tunable cadence, mirroring
  PROPOSAL.md's "threshold-tuner observer" cadence pattern) over the trailing window of
  cases. It builds an **undirected graph** whose nodes are cases and whose edges are
  *shared entities* — reusing the existing opt-in cross-source RELATED linkage
  (`engine/correlation.py`) rather than inventing a second entity model — plus shared
  MITRE technique and shared source-IP/host/user/hash/domain. Connected components with
  ≥2 cases and ≥1 shared entity become a `Campaign`. Single-case components are NOT a
  campaign (no noise).
- **Data structure / store:** `Campaign` is a Pydantic model in `models.py`
  (`id: campaign-XXXX`, `case_ids: list[str]`, `entities`, `mitre`, `first_seen`,
  `last_seen`, `severity_rollup`, `status`, `created_at`). Persisted in a **new KVStore
  store** `stores/campaigns.py` (ns=`"campaigns"`, key=`"entries"`), read-modify-write
  over one JSON list — the exact zero-migration pattern of `stores/proposals.py` (no new
  ES index / SQL table / migration). Campaign IDs come from the existing customizable
  `engine/case_id.py` KV-sequence generator with a `campaign-` template.
- **How it stays out of `decide()` and #4 — the three hard rails:**
  1. `campaigns.py` **never imports `case_manager`** and never calls `decide()`. It is a
     read-time aggregator, exactly like `engine/shift_report.py` (aggregate-only, #7).
  2. It **never mutates `cluster_signature`** and never re-clusters the primary cases — a
     `Campaign` only *references* `case_ids`; the cases keep their own identity and status.
     Removing a case from / adding a case to a campaign does not change that case's
     `cluster_signature` (#4 byte-identical).
  3. It is **advisory**: a campaign can roll up severity and surface an attention item,
     but it can never close/escalate a member case — that stays with `decide()` (#3).
  Re-running the pass is **idempotent**: campaign identity is the sorted-tuple of member
  `cluster_signature`s (a stable content hash), so the same cases always fold into the
  same campaign, and NEEDS_HUMAN cases can join a campaign without ever auto-closing.
- **New modules/endpoints/models/enums:**
  - Model: `Campaign` (+ `CampaignStatus` enum: open/monitoring/resolved — pure UI state,
    never fed to `decide()`).
  - Store: `stores/campaigns.py` (`CampaignStore`, KV, zero-migration).
  - Engine: `engine/campaigns.py` (`correlate_campaigns()` pure fn + a scheduler hook).
  - Router: `api/routes_campaigns.py` — `GET /api/campaigns`, `GET /api/campaigns/{id}`,
    `POST /api/campaigns/recorrelate` (admin, manual trigger), `GET /api/cases/{id}/campaign`.
- **Invariants:** #1 (campaigns read only from StateStore/case store, never the log key) ·
  #3 (never calls decide, NEEDS_HUMAN never auto-closes) · #4 (never touches
  cluster_signature) · #6 (no LLM call in the default deterministic pass → no UsageDoc; if
  a later opt-in LLM "campaign narrative" is added it goes through the ONE gateway) · #9
  (campaign name/notes render as plain text; member evidence stays fenced).
- **OPEN DECISION:** (a) Is the campaign pass **fully deterministic** (recommended — graph
  of shared entities, zero LLM, $0) or do you also want an **opt-in LLM campaign
  narrative** summarising the story (one gateway call per campaign, batched at the 50%
  discount)? (b) Default cadence — **daily** (recommended) vs 6-h vs on-demand only.

### 1.3 EVENT feeds → cheap-first funnel → batched LLM detection → SAME pipeline

The user's idea: batch raw EVENTS together, send them to an LLM at the 50% batch
discount, and let the agent DETECT / create its own candidate alerts, which then run the
SAME deterministic pipeline. **This is viable, but only behind a cheap-first funnel** —
the industry-standard "tiered / funnel" detection pattern, because LLM-over-every-raw-log
is neither affordable nor accurate.

**The funnel (four stages, cheap→expensive):**

1. **Pre-aggregation (free, deterministic).** Collapse raw EVENTS into per-entity,
   per-hour-of-week buckets (the same buckets the baseline maintains, §2). This is the
   "aggregate-then-summarise, never raw logs to a model" non-negotiable (#7) applied to
   detection, and it is how log-analytics platforms scope anomaly work — Elastic's
   anomaly detection runs over **aggregated buckets (bucket_span)**, not raw docs.
   <https://www.elastic.co/guide/en/machine-learning/current/ml-ad-run-jobs.html>
2. **Rules pass (cheap, deterministic).** The existing Sigma-style DetectionRule
   classify/fire halves (PROPOSAL.md §1) run over the aggregates. Sigma is the vendor-
   neutral standard for "generic signature format for log events."
   <https://github.com/SigmaHQ/sigma>
3. **Anomaly pass (cheap, deterministic).** The §2 baseline emits candidates for buckets
   whose volume/rate exceeds the robust modified-z gate (`|M| > 3.5`, area-c). Only
   buckets that survive stages 1–3 are eligible for the LLM.
4. **Batched LLM detection (paid, 50% off).** The surviving *aggregated* summaries (never
   raw logs) are packed into ONE Message Batch. Each request asks the strong model to
   confirm/deny a candidate detection and emit a structured verdict. Each successful
   result becomes a **candidate alert** that enters the SAME pipeline: OCSF-shaped →
   `cluster_signature` (#4) → risk → cost-gate → `decide()` (#3, unchanged).

**The cost argument (is LLM-over-raw-events viable? — sourced).**

- **Batch = exactly 50% off** on both providers. Anthropic Message Batches: "processes
  Messages API requests asynchronously at 50% of standard prices," ≤100,000 requests or
  256 MB/batch, most complete <1h (max 24h), results retained 29 days.
  <https://docs.anthropic.com/en/docs/build-with-claude/batch-processing> ·
  OpenAI Batch API: "50% cost discount," 24-hour completion window.
  <https://platform.openai.com/docs/guides/batch>
- **Flex is a second, orthogonal ~50% lever** for near-real-time work that can tolerate
  slower/occasional-unavailable responses: OpenAI `service_tier: "flex"` "provides
  significantly lower costs … in exchange for slower response times and occasional
  resource unavailability."
  <https://platform.openai.com/docs/guides/flex-processing>
- **Prompt caching multiplies the saving** when many event-batch requests share one large
  system/rubric prefix: cache reads cost ~0.1× base input; writes 1.25× (5-min TTL) / 2×
  (1-h TTL); prefix-match, verified via `usage.cache_read_input_tokens`.
  <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching> · min cacheable
  prefix is model-dependent (Opus 4.8 = 4096 tokens, Sonnet 4.6 = 2048).
- **Model tiering caps the bill.** Detection triage is a good Haiku/Sonnet job, not Opus:
  Haiku 4.5 $1/$5 per MTok, Sonnet 4.6 $3/$15, Opus 4.8 $5/$25 (per-MTok input/output).
  <https://www.anthropic.com/pricing>
- **Verdict.** Batching the *aggregated survivors of a rules+anomaly funnel* through a
  cheap model with a cached prefix stacks 50% (batch) × ~10× (cache read on the shared
  prefix) × ~5× (Haiku vs Opus) reductions, so a night's EVENTS collapses to a few cents
  to low-dollars of LLM spend — **viable**. Sending *raw, un-funnelled* events to any
  model is NOT (token blow-up + poison-by-noise). The funnel is the guardrail; the batch
  discount is the icing.

**Guardrails (all sourced to invariants):**
- Aggregate-then-summarise; **never raw logs to a model** (#7) — the LLM sees per-entity
  bucket summaries + rule hits, not raw records.
- Untrusted-data fencing (#9): every aggregated field is attacker-influenceable (it came
  from logs), so it is wrapped in the existing `UNTRUSTED_OPEN/CLOSE` fence; forged
  close-markers are escaped by `fence()`.
- Candidate alerts run the **unchanged** `decide()` (#3): the LLM's detection verdict is a
  *verdict input*, exactly like the investigator's — it never sets status; NEEDS_HUMAN
  never auto-closes.
- One `UsageDoc` per batch result (#6, see §3).

**New modules/endpoints/enums:**
- Enum: `DetectionSource` (`detection` | `anomaly` | `rule`) recorded on the candidate so
  a case shows its provenance ("AI-detected from raw events" vs "upstream detection").
- Engine: `engine/event_detection.py` (`funnel(events) -> list[CandidateAlert]` +
  `build_batch(candidates)`), reusing `engine/baseline.py` (§2) and the existing
  DetectionRule engine.
- Endpoint: `GET /api/detection/candidates` (review the funnel output), `POST
  /api/detection/run` (admin, manual funnel+batch trigger for a window).
- **OPEN DECISION:** default model for event-batch detection — **Haiku 4.5** (cheapest,
  recommended for triage) vs Sonnet 4.6 (more accurate). And: default EVENTS funnel
  cadence — **hourly aggregate, nightly batch** (recommended) vs continuous.

---

## 2. HOW THE BASELINE IMPROVES OVER TIME (the user's literal question, answered precisely)

**Answer in one line:** the baseline improves because it is a set of **online,
single-pass streaming statistics** that update **recursively, once per observation**, and
**self-correct as n grows** — old data is continuously down-weighted (EWMA) so the
baseline *tracks drift* instead of rescanning history or ossifying. Every update is a
fixed recursion over the ordered stream, so identical inputs in identical order produce
**byte-identical state** — which is why it can live entirely outside `decide()`.
(area-c, "Consensus standard" + "Why it improves over time".)

**Recommended method — a two-layer, per-`cluster_signature`, per-hour-of-week model:**

**Layer 1 — EWMA mean + EWMV variance (drift-tracking).**
- EWMA recursion (pandas `adjust=False` form): `s_t = alpha·x_t + (1 - alpha)·s_{t-1}`,
  seeded `s_1 = x_1`.
  <https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.ewm.html>
- EWMV = two parallel EWMAs, of `x` and `x²`, with `Var = E[x²] − (E[x])²`; RiskMetrics
  form `sigma²_t = lambda·sigma²_{t-1} + (1 - lambda)·r²_t`.
  <https://riverml.xyz/dev/api/stats/EWVar/>
- **Expose decay as half-life `H` in days, not raw `alpha`.** Convert internally
  `alpha = 1 − exp(−ln2 / H)`. **Default a conservative (slow) `H = 14 days`** so a
  *sustained* attack is not silently absorbed into "normal" — the deliberate slow-adapt
  choice (RiskMetrics `beta = 0.94` ≈ 11-day half-life; Datadog `robust` treats slow
  level shifts as anomalies), NOT the fast-adapt River default (`fading_factor = 0.5`)
  which can absorb a sustained attack.
  <https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.ewm.html> ·
  <https://docs.datadoghq.com/monitors/types/anomaly/>
- Optionally keep a **Welford** running mean/variance alongside for a stable
  unbounded-history reference: `M_k = M_{k-1} + (x_k − M_{k-1})/k`,
  `S_k = S_{k-1} + (x_k − M_{k-1})(x_k − M_k)`, `var = S_k/(k-1)`; error shrinks ~1/n.
  <https://nullbuffer.com/articles/welford_algorithm.html>

**Layer 2 — one t-digest per entity for robust p50/p95/p99** (heavy-tailed volume/rate),
`compression = 100` (the Elasticsearch default; nodes ≤ 20·compression, ~32 B/node),
pinned so replay is byte-identical.
<https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations-metrics-percentile-aggregation.html>

**Seasonality — 168 hour-of-week buckets** (day-of-week × hour), each carrying its own
EWMV + t-digest; a value is compared only to its matching bucket, capturing both the 24-h
diurnal and the weekday/weekend cycle. This fits the daily campaign cadence cleanly.
<https://docs.elementary-data.com/data-tests/anomaly-detection-configuration/seasonality>

**Threshold — robust modified-z, NOT 3-sigma.** Flag a bucket when
`M = 0.6745·(x − median)/MAD` has `|M| > 3.5`, with `MAD = median(|x − median|)`. The
robust variant resists the very outliers we are hunting (one bad reading can't inflate
dispersion), which plain `mean ± 3σ` cannot.
<https://en.wikipedia.org/wiki/Median_absolute_deviation> ·
<https://standarddeviationcalculator.app/learn/modified-z-score-outlier-detection>

**Warm-up / cold-start rule.** Suppress baseline-derived candidates until a bucket has
≥ **3× the seasonal period** of history — **3 weeks** for weekly buckets (Datadog uses up
to ~6 weeks). Surface a "baseline warming up (n / target samples)" state in the webui with
live p50/p95/p99 so "improves over time" is **visible and auditable**.
<https://docs.datadoghq.com/monitors/types/anomaly/>

**Determinism + entirely out of `decide()`.** Persist only the small sketch state (Welford
`M/S/n`, EWMA `s`/`s2`, t-digest centroids) in KV, so each EVENTS batch updates
incrementally — never a full-history rescan. Requirements from area-c: process events in
a stable `custom_id`/timestamp order, fix float summation order, pin t-digest
`compression`, and **version/snapshot the baseline state separately from — and it can
never mutate — the byte-identical `cluster_signature` or `decide()`.** The baseline is a
pure **advisory candidate-signal producer**: it only ranks/emits candidates that feed the
SAME `decide()` pipeline; it never reads risk weights, never reads `decide()`, and
NEEDS_HUMAN still never auto-closes.

**New modules/endpoints/stores/models/enums:**
- Store: `stores/baseline.py` (`BaselineStore`, KV, ns=`"baseline"`, one doc per
  `cluster_signature` OR one JSON blob keyed by signature — zero-migration, mirrors
  `stores/user_prefs.py`). Sketch state only; small.
- Engine: `engine/baseline.py` — `update(signature, hour_of_week, value)` (pure recursion),
  `modified_z(signature, hour_of_week, value)`, `is_warm(signature, hour_of_week)`,
  `snapshot()/restore()`.
- Model: `BaselineState` (Welford `M/S/n`, EWMA `s`/`s2`, t-digest centroids, `n_samples`,
  `warm: bool`, `version: int`).
- Config: `Preferences.baseline` (UI-editable) — `half_life_days` (default 14),
  `warmup_multiplier` (default 3), `modified_z_threshold` (default 3.5),
  `tdigest_compression` (default 100), `seasonality` (default `hour_of_week`).
- Endpoint: `GET /api/baseline/{signature}` (warm-up + p50/p95/p99 for the webui gauge),
  `GET /api/baseline/stats`.
- **Invariants:** #3 (producer only; never reads/influences decide; NEEDS_HUMAN unaffected)
  · #4 (baseline state is versioned separately and can never mutate cluster_signature) ·
  #6 (baseline is pure math, no LLM → no UsageDoc) · #9 (candidate summaries fenced when
  they later reach a model in §1.3).
- **OPEN DECISION (the adaptation-speed fork area-c flags):** confirm the **slow-adapt
  default** `H = 14 days` (recommended — a sustained attack stays anomalous) vs a
  fast-adapt default. Also: keep **Welford alongside EWMV** (recommended, cheap) or
  EWMV-only?

---

## 3. BATCH / FLEX API INTEGRATION (idempotent, resume-safe)

**Provider facts (sourced).**
- **Anthropic Message Batches** — 50% off; each request carries a `custom_id`; you poll
  `processing_status` until `"ended"`; **results arrive in any order — key by
  `custom_id`, never by position**; ≤100,000 requests or 256 MB/batch; most complete <1h,
  max 24h; results retained 29 days; supports caching/tools; no beta header.
  <https://docs.anthropic.com/en/docs/build-with-claude/batch-processing>
- **OpenAI Batch** — upload a JSONL file of requests each with a `custom_id`; 50% discount;
  24-hour completion window; poll batch status.
  <https://platform.openai.com/docs/guides/batch>
- **OpenAI `service_tier: "flex"`** — near-real-time, ~50% cheaper, tolerant of slower/
  occasionally-unavailable responses (a middle tier between realtime and Batch).
  <https://platform.openai.com/docs/guides/flex-processing>

**Idempotent result handling → exactly one `UsageDoc` per result (#6) → `decide()` per
result (#3).** This is the load-bearing correctness argument:

1. **`custom_id` = the cluster's stable identity.** For every batched work item,
   `custom_id = sha256(cluster_signature)[:N]` (or the raw signature). Because
   `cluster_signature` is byte-identical (#4), the same cluster always maps to the same
   `custom_id`, so a resubmitted or duplicate batch cannot create two work items for one
   cluster.
2. **Dedup on retrieval.** When results are pulled, each is keyed by `custom_id`. The
   `BatchJobStore` records a per-`custom_id` `retrieved: bool`. A result whose `custom_id`
   is already `retrieved` is **dropped** — so exactly one path runs per result.
3. **Exactly one `UsageDoc` per result (#6).** The batch retrieval calls the SAME ONE
   `llm/gateway.py` ledger-write path per result — the gateway writes exactly one
   `UsageDoc` (with `batch=True` + the 50% price applied + any cache tokens). Because step
   2 guarantees one execution per `custom_id`, there is exactly one ledger row per result.
4. **`decide()` per result (#3).** Each retrieved verdict runs the byte-identical
   `decide(verdict, confidence, risk_score, policy)` — identical to the realtime path.
   NEEDS_HUMAN never auto-closes.

**Durable KVStore `BatchJobStore` state machine (resume-safe, dedup).**
- Store: `stores/batch_jobs.py` (KV, ns=`"batch_jobs"`, zero-migration, mirrors
  `stores/proposals.py`). One `BatchJob` per submission.
- Model: `BatchJob { id, provider, provider_batch_id, state, custom_ids: {custom_id ->
  {retrieved: bool, result_state}}, submitted_at, polled_at, model, discount }`.
- Enum: `BatchJobState` = `submitted → polling → retrieving → retrieved` (+ `errored`,
  `expired`). **Resume-safe:** on restart the batch poller reloads any job not in
  `retrieved`, re-polls `processing_status`, and resumes retrieval; already-`retrieved`
  `custom_id`s are skipped (step 2), so a crash mid-retrieval never double-counts.
- Poller: a background task (same pattern as `engine/poller.py`) that, per open job:
  poll `processing_status`; when `"ended"`, stream results; per result dedup→gateway→decide.
- Endpoint: `GET /api/batch/jobs`, `GET /api/batch/jobs/{id}` (already hinted in
  PROPOSAL.md §3 as optional — now load-bearing).

**Which work is batched vs realtime (severity floor).**
- **Realtime (never batched):** high-severity detections and any candidate at/above the
  operator's severity floor — 1–24 h latency is unacceptable for a live escalation.
- **Batched (50% off):** the EVENTS anomaly-detection funnel (§1.3), low/medium-severity
  enrichment, backfill, digests, and re-investigation sweeps.
- **Flex (optional middle tier, OpenAI only):** medium-severity work that wants
  near-real-time latency but tolerates the ~50% price/occasional-unavailability trade.
- Gate lives in one place: `Preferences.batch.severity_floor` + `caps` (mirrors
  PROPOSAL.md §5.2). **Defaults OFF** so the byte-identical spine is unchanged until an
  operator opts in.

**Invariants:** #1 (batch results are LLM verdicts, never touch the log key) · #3
(decide() unchanged, one per result, NEEDS_HUMAN never auto-closes) · #4 (custom_id
derived FROM cluster_signature, never the reverse — signature stays byte-identical) · #6
(one gateway ledger write per retrieved result; dedup guarantees no double-count) · #9
(batched prompts carry fenced untrusted evidence).

**OPEN DECISION:** (a) Which providers in scope — **Anthropic Batch + OpenAI Batch**
(recommended) and do you also want **OpenAI flex** as a third tier now? (b) Default
`severity_floor` for batching (recommended: batch strictly *below* "high"). (c) `custom_id`
= raw `cluster_signature` vs a hash of it (recommended: hash, to bound length and avoid
leaking entity values in provider logs).

---

## 4. TERMINOLOGY (UI/docs-only renames; wire keys + aliases kept)

Grounded in the vendor-neutral standards for each overloaded word:

| Concept | Canonical term | What it is | Source of the standard |
|---|---|---|---|
| raw record | **event** | one OCSF log record | OCSF is the canonical schema. <https://schema.ocsf.io/> |
| pre-classified finding | **detection** | upstream "this is suspicious" | Sigma classify/fire model. <https://github.com/SigmaHQ/sigma> |
| our candidate | **alert (candidate)** | a cluster worth investigating | identity = `cluster_signature` (#4) |
| decided unit | **case** | audited, `decide()`-produced | Elastic cases. <https://www.elastic.co/guide/en/security/current/cases-overview.html> |
| grouped incident | **campaign** | related cases as one story | MITRE campaigns. <https://attack.mitre.org/campaigns/> |

**Resolving the two overloads (exactly as the fleet flagged):**

- **"correlate" (3 meanings) →**
  1. per-source toggle "auto-correlate" → renamed **"Auto-investigate"** in UI/docs (it
     actually gates paid AI forwarding, per PROPOSAL.md §1). Wire key
     `config['auto_correlate']`/`correlate` **unchanged**.
  2. the clustering function → **"clustering"** (produces `cluster_signature`). Code name
     unchanged; docs stop calling it "correlate."
  3. the cross-source RELATED-linking pass → **"campaign correlation"** (§1.2). It is the
     only thing that keeps the word "correlate."
- **"rule" (3 meanings) →**
  1. classify half ("this IS a brute-force") → **"detection rule — match"**.
  2. fire half ("open a case when N in a window") → **"detection rule — trigger"**.
     (PROPOSAL.md's `DetectionRule` unifies these two additively.)
  3. the post-`decide()` tag/notify object → renamed **"case automation"**
     (`AutomationRule → CaseAutomationRule`, alias kept) so it stops sharing the word.

**How this stays additive:** every rename is **UI-string + docs only**. Wire keys, JSON
field names, `constants.py` enum *values*, and Python identifiers keep their old spelling;
where a Python rename helps (`AutomationRule → CaseAutomationRule`) an **alias is kept**
(migrate-on-read), exactly as PROPOSAL.md §2.3 specifies. `webui/src/lib/types.ts` stays
in sync with `models.py`; terminology overrides also flow through the existing
`GET/PUT /api/terminology` per-user store so a site can re-label further without code.
**Invariants:** none affected (pure labels); #9 fencing unchanged.

**OPEN DECISION:** confirm the five canonical nouns above (event / detection / alert /
case / campaign) as the product's fixed vocabulary, and whether "alert" should be
user-visible at all or folded into "case" everywhere (recommended: keep "alert" only for
the *candidate* stage, "case" once `decide()` has run).

---

## 5. RESET UX (danger-zone, tiered, never wipe env secrets)

**Pattern.** A dedicated **Danger Zone** section (GitHub's established destructive-action
pattern) with **type-to-confirm** per action — the operator must type an exact token
before the action arms.
- GitHub Danger Zone + "type the repository name to confirm."
  <https://docs.github.com/en/repositories/creating-and-managing-repositories/deleting-a-repository>
- The type-to-confirm modal is a recognised destructive-action UX safeguard.
  <https://www.nngroup.com/articles/confirmation-dialog/>

**Tiered scopes (each with its own confirm token):**

| Tier | Clears | Keeps | Confirm token |
|---|---|---|---|
| **1. Logs / cases only** | cases, campaigns, baseline sketches, inbox/activity, batch jobs, in-memory live-tail rings | sources, secrets, users, settings, RAG corpus | type `RESET CASES` |
| **2. Sources + logs** | tier 1 **plus** configured sources + per-source cursors | secrets, users, settings, setup flag | type `RESET SOURCES` |
| **3. Full factory reset** | everything in the StateStore + preferences + users + setup flag → app returns to **fresh OOBE** (§6) | **env-provided secrets only** | type `FACTORY RESET` |

**The HARD rule — never wipe env-provided secrets.** Every tier is code-forbidden from
touching anything sourced from `config.py` env (`TLSOC_*` → `ES_API_KEY`, LLM keys,
`STATE_DB_URL`, etc.). Wizard-pushed in-memory secrets and per-source connector secrets
*are* cleared by tiers 2/3 (they are the in-memory tier by design), but env secrets are
the durable floor the operator relies on to even reach the login screen after a reset.
This mirrors how the reversible Demo Mode tenant is isolated — reset re-initialises the
StateStore, it does not rewrite `.env`.

**Which stores/indices each tier clears (concrete):**
- Tier 1: cases store, `CampaignStore`, `BaselineStore`, inbox/case_thread/case_activity/
  case_tasks KV, `BatchJobStore`, `IngestService` live-tail rings, usage ledger (optional).
- Tier 2: tier 1 + `Preferences.sources[]` + `cursor_store` keys.
- Tier 3: tier 2 + users/sessions/user_prefs/custom_roles/proposals/memory + branding +
  `setup_complete=false` (triggers OOBE) — **but the env-secret tier is never read/written.**

**New modules/endpoints/enums:**
- Enum: `ResetScope` = `cases | sources | factory` in `constants.py`.
- Endpoint: `POST /api/admin/reset` `{scope, confirm}` — **admin + `require_fresh_auth`**
  (step-up re-auth, reusing the existing sudo-reauth gate), server validates the confirm
  token matches the scope, audits an append-only `ActionType.RESET` record BEFORE acting
  (#2 audit trail survives a cases-tier reset by living in `tlsoc-agent-audit-*`, which
  tier 1/2 do not clear; tier 3 documents that the audit index is also reset).
- webui: a `DangerZone` component under Settings → Organization, RBAC-gated to super_admin,
  three tiered cards each with an independent type-to-confirm dialog.
- **Invariants:** #1 (reset only ever touches the mgmt/state side, never the read-only log
  key or upstream `all-logs-*`; the "read-only consumer, upstream untouched" non-negotiable
  #12 holds) · #2 (reset is itself audited, append-only) · #3/#4 (reset destroys cases; it
  never *runs* `decide()` or re-derives a `cluster_signature`) · #6 (no LLM) · #9 (n/a).
- **OPEN DECISION:** (a) does tier 1 also clear the **usage/cost ledger** (recommended:
  NO — keep cost history through a cases reset) and the **audit index** (recommended: NO
  for tiers 1/2, YES only for factory)? (b) Confirm the three tier tokens above. (c) Should
  factory reset also disable auth back to default-OFF, or keep auth ON if it was ON?

---

## 6. OOBE WITH ACCOUNT SETUP (first-run admin creation)

**Pattern (grounded in the products the brief names).** Every mature platform's first run
forces creation of an initial admin with a strong password before the console is usable:
- **Grafana** ships `admin/admin` and **forces a password change on first login.**
  <https://grafana.com/docs/grafana/latest/setup-grafana/sign-in-to-grafana/>
- **Kibana / Elastic** first-run enrollment sets up the initial credentials.
  <https://www.elastic.co/guide/en/kibana/current/production.html#kibana-authentication>
- **Splunk** first login **requires setting the admin password** (no shipped default).
  <https://docs.splunk.com/Documentation/Splunk/latest/Admin/Aboutusersandroles>
- **Wazuh** first run provisions admin credentials via the setup flow.
  <https://documentation.wazuh.com/current/getting-started/index.html>
- **GitLab** first visit **forces setting the root password before any other action.**
  <https://docs.gitlab.com/ee/install/next_steps.html>

**Concrete flow (a new first step in the existing first-run wizard):**

1. **Account setup step (NEW, first).** If `setup_complete == false` AND auth is enabled,
   the wizard opens on **"Create admin account"**: username + display name + a
   **force-set strong password** (server-enforced policy: min length, not equal to
   username, not a common password) + optional MFA-enrol prompt. This replaces the current
   `Admin/Admin@123` seed with an operator-chosen credential — the seed remains ONLY as
   the auth-disabled/offline-test default (unchanged, per the "auth default OFF" rule).
2. **Data source step** (existing) — connect SIEM/EDR sources.
3. **Policy step** (existing) — AutoClosePolicy, feeds (alerts/events/ignore roles),
   baseline half-life, batch severity-floor.
4. **Finish** — sets `setup_complete = true`; the account created in step 1 is the sole
   super_admin.

**How a full reset restarts into it.** Tier-3 factory reset (§5) sets
`setup_complete = false` and clears the user store, so the very next request lands back on
the OOBE account-setup step — the app is genuinely "fresh," but the env-provided secrets
(§5 hard rule) are still present so the operator can immediately create a new admin.

**New modules/endpoints/enums:**
- Endpoint: `POST /api/setup/account` `{username, display_name, password}` — **only callable
  while `setup_complete == false`** (self-locks after first success), server enforces the
  password policy and creates the first super_admin; `GET /api/setup/status` returns
  `{setup_complete, has_admin, auth_enabled}` to drive the wizard entry point.
- Reuse: existing `auth/passwords.py` (PBKDF2), `stores/users.py`, `auth/service.py`
  (6-role RBAC), `auth/mfa.py` (optional enrol). No new auth primitives.
- webui: a first-run `AccountSetupStep` before the source step, wired into the existing
  wizard router.
- **Invariants:** #1 (unaffected) · #3/#4/#6 (no pipeline/LLM in setup) · #9 (username/
  display-name rendered as plain text; password never echoed — booleans only, per the
  "UI shows `configured ✓`, never values" rule).
- **OPEN DECISION:** (a) Password policy floor — **min 12 chars + not-common-password**
  (recommended) vs a lighter rule. (b) Is MFA enrolment in OOBE **prompted-optional**
  (recommended) or **mandatory** for the first admin? (c) When auth is DEFAULT-OFF, does
  OOBE still run an account step (recommended: **no** — auth-off keeps today's zero-friction
  behavior; the account step appears only when `TLSOC_AUTH_ENABLED=true`)?

---

## 7. Consolidated invariant proof (one line each)

- **#1** — Every new subsystem (campaigns, baseline, batch, reset, OOBE) reads/writes only
  the StateStore/mgmt side; none touches the read-only `all-logs-*` key; upstream untouched.
- **#3** — `decide()` is byte-identical; campaigns/baseline/batch are all *producers or
  aggregators* that feed OR sit beside `decide()`; none imports `case_manager`; NEEDS_HUMAN
  never auto-closes anywhere.
- **#4** — `cluster_signature` is byte-identical; campaigns only *reference* case ids;
  `custom_id` is derived FROM the signature; baseline state is versioned separately and can
  never mutate the signature.
- **#6** — Every LLM call (event-detection batch, optional campaign narrative) goes through
  the ONE gateway; batch dedup guarantees exactly one `UsageDoc` per retrieved result.
- **#9** — Every attacker-influenceable field (aggregated event summaries, campaign notes,
  usernames) is fenced/escaped or rendered as plain text.

## 8. New surface area at a glance (all additive, zero new deps)

- Models: `Campaign`, `CampaignStatus`, `BaselineState`, `BatchJob`, `BatchJobState`,
  `DetectionSource`, `ResetScope`; `ActionType.RESET`.
- Stores (KV, zero-migration): `stores/campaigns.py`, `stores/baseline.py`,
  `stores/batch_jobs.py`.
- Engine: `engine/campaigns.py`, `engine/baseline.py`, `engine/event_detection.py`;
  batch poller task.
- Routers: `api/routes_campaigns.py`, plus `/api/detection/*`, `/api/baseline/*`,
  `/api/batch/jobs`, `/api/admin/reset`, `/api/setup/{account,status}`.
- webui: `DangerZone`, `AccountSetupStep`, baseline warm-up gauge, campaign views.
- Preferences (UI-editable): `baseline.*`, `batch.*` (severity_floor, caps), campaign
  cadence.
