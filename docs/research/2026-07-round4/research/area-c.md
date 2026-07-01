# Area C — Baselining that improves over time (EWMA / percentiles / seasonality / warm-up / online)

> Round-4 research brief. Scope: how an anomaly baseline "improves over time," the
> exact online-statistics primitives, the numbers/params/APIs, and how to keep the
> whole thing a deterministic *candidate-signal producer* that never touches the
> byte-identical `decide()`.

## Consensus standard

The industry-standard way a baseline "improves over time" is a set of **online,
single-pass streaming statistics** that update **recursively per observation** and
self-correct as `n` grows — no full-history rescans. Old data is continuously
**down-weighted** (EWMA) or **evicted** (rolling window) so the baseline *tracks
drift* instead of ossifying. Every primitive is a fixed recursion over the ordered
stream, so it is deterministic and can live entirely outside the decision function.

The canonical primitives (all sources agree):

1. **Rolling window mean/stddev** — fixed window `N`; baseline = `mean ± k·stddev`.
2. **EWMA/EWMV** — exponential decay by factor `alpha`, expressed via half-life `H`.
3. **Welford** — numerically-stable running mean/variance for unbounded history.
4. **Streaming percentile sketches** — t-digest / HDRHistogram for robust p50/p95/p99.
5. **Robust z-score / MAD** — outlier-resistant thresholds (modified-z > 3.5).
6. **Seasonality** — per-bucket baselines (24 hour-of-day or 168 hour-of-week).
7. **Warm-up / cold-start** — ~3× the seasonal period of history before alerting.

## Concrete facts, formulas, params, APIs

### EWMA / EWMV (exponential decay)

- EWMA recursion: `s_t = alpha·x_t + (1-alpha)·s_{t-1}`, `s_1 = x_1`, `alpha ∈ (0,1]`;
  higher `alpha` = more weight on recent data. pandas `adjust=False` form:
  `y_t = (1-alpha)·y_{t-1} + alpha·x_t`, `y_0 = x_0`.
  <https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.ewm.html>
- **alpha ↔ half-life** (pandas / RiskMetrics): `alpha = 1 - exp(-ln2/H)`; for forgetting
  factor `beta = 1-alpha`, half-life `H` solves `beta^H = 1/2` (`H = -ln2/ln beta`).
  Also `alpha = 2/(span+1)` and `alpha = 1/(1+com)`. RiskMetrics `beta = 0.94` ≈ **11-day
  half-life**.
  <https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.ewm.html> ·
  <https://corporatefinanceinstitute.com/resources/capital-markets/exponentially-weighted-moving-average-ewma/>
- `adjust=True` applies a bias-correction denominator that removes early-sample bias
  (baseline is *less* wrong when `n` is small).
  <https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.ewm.html>
- **EWMV**: keep two parallel EWMAs (of `x` and `x^2`); `Var = E[x^2] - (E[x])^2`.
  RiskMetrics variance form: `sigma^2_t = lambda·sigma^2_{t-1} + (1-lambda)·r^2_t`.
  River `EWVar` default **`fading_factor = 0.5`** (param literally named `fading_factor`),
  cites Finch (2009).
  <https://riverml.xyz/dev/api/stats/EWVar/>

### Welford (unbounded-history running variance, 1962)

- Update: `M_k = M_{k-1} + (x_k - M_{k-1})/k`;
  `S_k = S_{k-1} + (x_k - M_{k-1})·(x_k - M_k)`; init `M_1 = x_1, S_1 = 0`.
  Sample variance `= S_k/(k-1)`, stddev `= sqrt(S_n/(n-1))`. **O(1) memory**, avoids
  catastrophic cancellation; error shrinks ~`1/n`.
  <https://nullbuffer.com/articles/welford_algorithm.html>

### Streaming percentile sketches

- **t-digest** (Ted Dunning): centroid/cluster-based, single-pass, **fully mergeable**;
  accuracy proportional to `q(1-q)` ⇒ **more accurate at the tails** (p1/p99) than at the
  median. Elasticsearch default **`compression = 100`** (nodes ≤ `20·compression`, ~64 KB
  worst case, ~**32 B/node**); higher compression = more accuracy + more memory.
  <https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations-metrics-percentile-aggregation.html> ·
  Redis t-digest (default `COMPRESSION 100`, `TDIGEST.CREATE/ADD/QUANTILE/MERGE`):
  <https://redis.io/docs/latest/develop/data-types/probabilistic/t-digest/>
- **HDRHistogram** alternative: fixed relative error via
  `number_of_significant_value_digits` (`3` ⇒ **0.1%** error); faster than t-digest but
  larger memory and **positive values only**. Use t-digest for general/heavy-tailed data.
  <https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations-metrics-percentile-aggregation.html>

### Thresholds — standard vs robust

- Standard z-score: flag `|z| = |(x-mean)/stddev| > 3` (3-sigma).
  <https://standarddeviationcalculator.app/learn/modified-z-score-outlier-detection>
- **Modified z-score (robust, preferred for anomaly baselines)**:
  `M_i = 0.6745·(x_i - median)/MAD`, `MAD = median(|x_i - median|)`; widely-used flag
  **`|M_i| > 3.5`**. The `0.6745` rescales MAD to normal stddev (`MAD ≈ 0.6745·sigma`,
  i.e. `1/0.6745 ≈ 1.4826`). One bad reading can't inflate dispersion.
  <https://standarddeviationcalculator.app/learn/modified-z-score-outlier-detection> ·
  <https://en.wikipedia.org/wiki/Median_absolute_deviation>

### Seasonality / diurnal

- Per-bucket baselines: **24 hour-of-day** OR **168 hour-of-week** (`7·24`) buckets;
  `hour_of_week` keys on `(day-of-week, hour)` to capture both the 24h diurnal cycle and
  the weekday/weekend cycle. Each new value is compared only to its matching bucket;
  each bucket carries its own EWMV/t-digest.
  <https://docs.elementary-data.com/data-tests/anomaly-detection-configuration/seasonality>

### Warm-up / cold-start

- Require **≥ 3× the seasonality period** of history before alerting (3 h hourly / 3 d
  daily / **3 w weekly**); Datadog uses up to ~**6 weeks** for the baseline. Simple
  streaming detectors use a short warm-up (~**30 samples / ~30 minutes**).
  <https://docs.datadoghq.com/monitors/types/anomaly/>

### Datadog production algorithm taxonomy (authoritative reference)

- **`basic`** — lagging rolling **quantile** band; no seasonality; fast; scale-insensitive.
- **`agile`** — robust SARIMA variant; seasonal + adapts to level shifts; scale-sensitive.
- **`robust`** — seasonal-trend decomposition; treats slow level shifts *as anomalies*;
  scale-insensitive; slow to adapt.
- Sensitivity via **`bounds` = number of deviations**; docs recommend **2 or 3**.
  <https://docs.datadoghq.com/monitors/types/anomaly/>

## Why it improves over time (precise, auditable)

- EWMA/EWMV converge toward the true *local* mean/variance; `adjust=True` removes early
  bias so the baseline is less wrong when `n` is small.
- Welford's running-variance error shrinks ~`1/n`.
- t-digest centroids **refine per ADD**, tightening p95/p99.
- Per-hour-of-week buckets fill in and stabilize over the 3×-period warm-up.
- Old data is down-weighted (EWMA) or evicted (rolling window), so the baseline tracks
  drift rather than ossifying.
  (Synthesized from all sources above.)

## Determinism

Every method is a **fixed recursion over the ordered stream** ⇒ identical inputs in
identical order yield **byte-identical state**. Requirements: fix float summation order
for EWMA/Welford; fix insertion order + pin t-digest `compression`. Because the baseline
is purely a **candidate-signal producer**, it stays outside — and can never influence —
the byte-identical `decide()` (or the byte-identical `cluster_signature`).

## Disagreements / tensions between sources

- **Threshold rule.** Textbook 3-sigma (`|z|>3`) vs the robust modified-z (`|M|>3.5`,
  MAD-based). The robust variant is the *recommended* choice for anomaly detection
  because it resists the very outliers being hunted; the 3-sigma rule is the simpler
  legacy default.
- **Percentile sketch.** Elastic/Redis default to **t-digest** (heavy-tailed, mergeable,
  best at tails) while HDRHistogram is faster with a *fixed* relative error but is
  positive-only and heavier — a memory/accuracy/latency trade, not a correctness dispute.
- **Adaptation speed philosophy.** Datadog's `agile` deliberately *adapts to* level
  shifts, while `robust` deliberately *flags slow level shifts as anomalies*. This is a
  genuine design fork: fast-adapt can silently absorb a sustained attack into "normal";
  slow-adapt (high half-life) preserves detection at the cost of more lag.
- **Warm-up length.** Simple streaming detectors alert after ~30 samples; seasonal
  detectors need 3× the period (up to ~6 weeks). Choice follows whether seasonality is
  modeled.
- **Decay param default.** River `EWVar` ships `fading_factor = 0.5` (aggressive, fast
  forgetting) whereas RiskMetrics uses `beta = 0.94` (~11-day half-life, slow). Defaults
  differ by domain; expose it, don't hardcode one.

## IMPLICATIONS FOR OUR ROUND-4 DESIGN

- **Two-layer per-entity baseline, keyed by `cluster_signature`.** Layer 1: Welford
  running mean/variance (unbounded history) **plus** an EWMV with a config half-life
  (default e.g. `H = 14 days` ⇒ `alpha = 1 - exp(-ln2/14)`) so it tracks drift. Layer 2:
  one **t-digest per entity** (`compression = 100`) for robust p95/p99 volume/rate bounds.
  Persist only the small sketch state (Welford `M/S/n`, EWMA `s` and `s2`, t-digest
  centroids) in KV so each raw-EVENTS batch updates incrementally — never rescan history.
- **Emit candidate alerts from raw EVENTS via modified-z / MAD (`|M| > 3.5`)**, not
  `mean ± 3σ`, so the anomalies we hunt don't poison the threshold. Those candidates feed
  the **same** deterministic decision pipeline. The baseline is *only* a producer — it
  must never read or influence `decide()`; **NEEDS_HUMAN still never auto-closes**.
- **Seasonality = 168 hour-of-week buckets per entity** (day-of-week × hour), each with
  its own EWMV/t-digest. Clean fit for the 24 h "correlate into campaigns" cadence:
  compare each hour's volume only to its matching bucket.
- **Explicit warm-up gate:** suppress baseline-derived candidates until an entity's bucket
  has ≥ 3× the seasonal period (**3 weeks** for weekly buckets). Surface a "baseline
  warming up (n / target samples)" state in the webui, and show live p50/p95/p99 + bucket
  target so "improves over time" is *visible and auditable*.
- **Determinism guarantees:** process EVENTS in a stable `custom_id`/timestamp order, pin
  t-digest `compression`, and snapshot/version the baseline state so replaying a batch
  reproduces byte-identical sketches. Document that baseline state is versioned separately
  from — and cannot mutate — the byte-identical `cluster_signature` or `decide()`.
- **Expose decay as half-life `H` (days-to-forget) in Settings**, not raw `alpha`; convert
  internally via `alpha = 1 - exp(-ln2/H)`. Default to a **conservative (slow) H** so a
  sustained attack isn't silently absorbed into "normal" — matching Datadog's `robust`
  philosophy of treating slow level shifts as anomalies.
