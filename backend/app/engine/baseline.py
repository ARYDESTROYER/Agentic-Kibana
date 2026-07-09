"""Entity BASELINE — an anomaly baseline that IMPROVES OVER TIME (Round 4 Wave 3).

This module is the precise, sourced answer to "how does the base improve": a set of
**online, single-pass streaming statistics** that update **recursively, once per
observation**, keyed per ``cluster_signature`` and per **168 hour-of-week bucket**
(day-of-week × hour). Old data is continuously down-weighted (EWMA) so the baseline
*tracks drift* instead of rescanning history or ossifying, and it self-corrects as
``n`` grows. Every update is a fixed recursion over the ordered stream, so identical
inputs in identical order yield **byte-identical state** — which is exactly why the
baseline can live entirely OUTSIDE the deterministic decision.

The four streaming primitives per bucket (all from ``docs/research/2026-07-round4``):

* **EWMA mean + EWMV variance** (drift-tracking). Two parallel EWMAs — of ``x`` and
  ``x²`` — with ``Var = E[x²] − (E[x])²``. Decay is exposed as a **half-life ``H`` in
  DAYS** (``half_life_days``, default 14 — deliberately SLOW so a sustained attack is
  not silently absorbed into "normal"), converted internally to
  ``alpha = 1 − exp(−ln2 / H)`` and applied ONE decay-step per observation. Seeded
  ``s₁ = x₁`` (pandas ``adjust=False`` form).
* **Welford** running mean/variance (numerically-stable unbounded-history reference):
  ``M_k = M_{k−1} + (x_k − M_{k−1})/k``;
  ``S_k = S_{k−1} + (x_k − M_{k−1})·(x_k − M_k)``; ``var = S_k/(k−1)``. Error ~1/n.
* **t-digest** (one per bucket, ``compression`` pinned, default 100) for robust
  p50/p95/p99 on heavy-tailed volume/rate. Deterministic insertion + a fixed merge
  order (the Dunning **K1 scale function**, so tail centroids stay fine while central
  ones coalesce) → replay is byte-identical AND the centroid count is HARD-bounded at
  ≈ ``compression/2`` no matter how long the stream runs (memory per bucket is capped).
* **Modified-z / MAD** robust threshold: ``M = 0.6745·(x − median)/MAD`` (median +
  MAD read robustly from the t-digest), flag when ``|M| > modified_z_threshold``
  (default 3.5). Robust so the very outliers we hunt can't inflate the dispersion.

**Warm-up gate.** Baseline-derived candidates are suppressed until a bucket has at
least ``warmup_multiplier × seasonal_period`` observations (3 × 168 = 504 for weekly
buckets, i.e. ~3 weeks of matching-hour history). ``warmup_target()`` exposes
``(n, target)`` for a UI warm-up gauge, so "improves over time" is visible + auditable.

**Non-negotiables held.**

* **#3** — a PURE PRODUCER. It NEVER imports ``case_manager``, NEVER calls / reads
  ``decide()``, and NEVER reads risk weights. It only ranks/emits candidate signals
  that feed the SAME deterministic pipeline; NEEDS_HUMAN still never auto-closes.
* **#4** — the baseline state is versioned SEPARATELY (``BaselineState.version``) and
  can never mutate / recompute ``cluster_signature`` — it only *references* it as a
  bucket key.
* **#6** — pure math, no LLM call → no ``UsageDoc``.
* Determinism — stable observation order (the caller sorts by timestamp/custom_id),
  fixed float summation order, pinned t-digest compression, versioned sketch state.

DEFAULTS OFF (``Preferences.baseline.enabled`` is False out of the box), so nothing
changes until an operator opts in.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import datetime

from ..config import BaselineConfig
from ..models import BaselineState

# Namespaced signature prefix for the PER-SOURCE ingest-volume series the realtime
# producer folds in (silent-source / flood detection, A4). Kept distinct from every
# real per-``cluster_signature`` key so the source-volume baseline can never collide with
# or influence the detection baseline (#4). Shared here so the state.py consumer and any
# observability reader key it identically.
SOURCE_VOLUME_PREFIX = "__source_volume__:"


def source_volume_signature(source_id: str) -> str:
    """The baseline series key for a source's ingest volume: ``__source_volume__:<id>``."""
    return f"{SOURCE_VOLUME_PREFIX}{source_id}"


# The sketch layout version stamped onto every produced :class:`BaselineState`. Bump
# this if the persisted shape changes so a later wave can migrate-on-read. It is
# entirely separate from the byte-identical ``cluster_signature`` (#4).
SKETCH_VERSION = 1

# Seasonal periods (number of buckets in one cycle) per seasonality mode. Weekly =
# 168 hour-of-week buckets (7 days × 24 h); the warm-up target scales off this.
SEASONAL_PERIODS: dict[str, int] = {
    "none": 1,
    "hour_of_day": 24,
    "day_of_week": 7,
    "hour_of_week": 168,
}

# The modified-z rescale constant: MAD ≈ 0.6745·σ for a normal distribution, so
# 0.6745·(x−median)/MAD is on the same scale as a standard z-score.
_MODIFIED_Z_K = 0.6745


def half_life_to_alpha(half_life_days: float) -> float:
    """Convert a decay HALF-LIFE ``H`` (in days) to the EWMA smoothing ``alpha``.

    ``alpha = 1 − exp(−ln2 / H)`` (pandas / RiskMetrics). A larger ``H`` (slower
    forgetting) yields a smaller ``alpha`` (more weight on history) — the deliberate
    slow-adapt choice so a sustained attack is not absorbed into "normal". Guarded to
    a valid ``(0, 1]`` even for degenerate inputs."""
    try:
        h = float(half_life_days)
    except (TypeError, ValueError):
        h = 14.0
    if not math.isfinite(h) or h <= 0.0:
        return 1.0
    return 1.0 - math.exp(-math.log(2.0) / h)


def hour_of_week(day_of_week: int, hour: int) -> int:
    """Fold ``(day_of_week 0–6, hour 0–23)`` into a single 0–167 hour-of-week bucket.

    ``day_of_week`` follows Python's ``datetime.weekday()`` (Mon=0 … Sun=6). Inputs
    are clamped into range so a malformed timestamp can never index out of the 168
    buckets (it lands in a nearby bucket rather than raising)."""
    d = max(0, min(6, int(day_of_week)))
    h = max(0, min(23, int(hour)))
    return d * 24 + h


def bucket_for(seasonality: str, day_of_week: int, hour: int) -> int:
    """The seasonal bucket index for the given seasonality mode.

    * ``hour_of_week`` → 0–167 (day × 24 + hour)
    * ``hour_of_day``  → 0–23  (hour)
    * ``day_of_week``  → 0–6   (day)
    * ``none``         → 0     (a single global bucket)
    """
    if seasonality == "hour_of_week":
        return hour_of_week(day_of_week, hour)
    if seasonality == "hour_of_day":
        return max(0, min(23, int(hour)))
    if seasonality == "day_of_week":
        return max(0, min(6, int(day_of_week)))
    return 0


# --------------------------------------------------------------------------- #
# t-digest — a compact, deterministic quantile sketch (Ted Dunning), stored as a
# list of [mean, weight] centroids. Single-pass, mergeable; accuracy is proportional
# to q(1−q) so it is most accurate at the tails (p95/p99). Insertion is a buffered
# batch-merge: values are appended then, once the buffer + centroids exceed a bound,
# folded in with a FIXED sort/merge order so replay is byte-identical.
#
# The merge test uses the canonical Dunning **K1 scale function** (NOT a raw q(1−q)
# product): two adjacent centroids spanning cumulative quantiles [q_left, q_right] may
# merge only while ``k(q_right) − k(q_left) ≤ 1`` for
# ``k(q) = (compression / 2π)·arcsin(2q − 1)``. K1 is steep at the tails (so tail
# centroids stay fine-grained → the p95/p99 accuracy we rely on) and flat in the middle
# (so central centroids coalesce aggressively). Because k(q) rises monotonically from
# −compression/4 to +compression/4, the total centroid count is HARD-BOUNDED at
# ≈ compression/2 regardless of how many observations stream in — the bound is real.
# --------------------------------------------------------------------------- #
@dataclass
class _TDigest:
    """A minimal deterministic t-digest over ``[mean, weight]`` centroids.

    Determinism guarantees: centroids are kept sorted by mean; the compress step
    merges in ascending-mean order under the Dunning **K1 scale-function** merge
    criterion (``k(q_right) − k(q_left) ≤ 1``, ``k(q) = (compression/2π)·arcsin(2q−1)``),
    which bounds the centroid count at ≈ ``compression/2`` — accuracy is concentrated
    at the tails. No randomness, no hashing — the same ordered input always yields the
    same centroid list."""

    compression: float = 100.0
    centroids: list[list[float]] = None  # type: ignore[assignment]  # [[mean, weight], ...]

    def __post_init__(self) -> None:
        if self.centroids is None:
            self.centroids = []

    def _k1(self, q: float) -> float:
        """The canonical t-digest K1 scale function ``(compression/2π)·arcsin(2q−1)``.

        Monotonic on ``[0, 1]`` from ``−compression/4`` to ``+compression/4``; its slope
        is steepest at the tails (fine centroids there) and flattest in the middle
        (coarse centroids there). The 1-unit merge budget over its bounded total range
        is exactly what caps the centroid count at ≈ ``compression/2``."""
        if q <= 0.0:
            q = 0.0
        elif q >= 1.0:
            q = 1.0
        return (float(self.compression) / (2.0 * math.pi)) * math.asin(2.0 * q - 1.0)

    @property
    def total_weight(self) -> float:
        return math.fsum(w for _, w in self.centroids)

    def add(self, x: float, weight: float = 1.0) -> None:
        """Add one observation, then compress if the centroid count grew past bound."""
        # Insert as its own centroid keeping the list sorted by mean (stable order).
        cs = self.centroids
        lo, hi = 0, len(cs)
        while lo < hi:  # binary search for the insertion point (deterministic)
            mid = (lo + hi) // 2
            if cs[mid][0] < x:
                lo = mid + 1
            else:
                hi = mid
        cs.insert(lo, [float(x), float(weight)])
        # Compress once we exceed a generous factor of the compression bound so the
        # amortised cost is low but the count stays O(compression).
        if len(cs) > max(16, int(self.compression) * 2):
            self._compress()

    def _compress(self) -> None:
        """Fold adjacent centroids under the K1 scale-function merge test — a single
        left-to-right pass over the mean-sorted centroids, fully deterministic.

        A centroid growing from left-edge quantile ``q_left`` to right-edge ``q_right``
        may absorb the next centroid only while ``k(q_right) − k(q_left) ≤ 1`` (``k`` =
        :meth:`_k1`). There is NO ``max(bound, 1.0)`` floor: the floor was the bug — it
        forced every tail centroid to survive as a weight-1 singleton, so the count grew
        ~logarithmically without limit. Under the true K1 budget, tail centroids merge as
        soon as their combined quantile span fits one k-unit, so the count is bounded at
        ≈ ``compression/2`` no matter how long the stream runs."""
        cs = self.centroids
        total = math.fsum(w for _, w in cs)
        if total <= 0 or len(cs) <= 1:
            return
        merged: list[list[float]] = []
        cum = 0.0                       # cumulative weight LEFT of the current centroid
        cur_mean, cur_w = cs[0]
        cur_mean = float(cur_mean)
        cur_w = float(cur_w)
        q_left = 0.0                    # left-edge quantile of the current merged centroid
        for mean, w in cs[1:]:
            mean = float(mean)
            w = float(w)
            # Right-edge quantile if we were to absorb this next centroid.
            q_right = (cum + cur_w + w) / total
            if self._k1(q_right) - self._k1(q_left) <= 1.0:
                # Merge: weighted-mean update (fixed arithmetic order).
                new_w = cur_w + w
                cur_mean = cur_mean + (mean - cur_mean) * (w / new_w)
                cur_w = new_w
            else:
                merged.append([cur_mean, cur_w])
                cum += cur_w
                q_left = cum / total
                cur_mean, cur_w = mean, w
        merged.append([cur_mean, cur_w])
        self.centroids = merged

    def quantile(self, q: float) -> float:
        """The value at quantile ``q`` (0..1) by linear interpolation across the
        centroid means at their cumulative-weight midpoints. Empty digest → 0.0."""
        cs = self.centroids
        if not cs:
            return 0.0
        if len(cs) == 1:
            return cs[0][0]
        total = math.fsum(w for _, w in cs)
        if total <= 0:
            return cs[0][0]
        target = q * total
        cum = 0.0
        prev_mean = cs[0][0]
        prev_center = 0.0
        for mean, w in cs:
            center = cum + w / 2.0
            if target <= center:
                if center == prev_center:
                    return mean
                frac = (target - prev_center) / (center - prev_center)
                frac = max(0.0, min(1.0, frac))
                return prev_mean + (mean - prev_mean) * frac
            prev_mean = mean
            prev_center = center
            cum += w
        return cs[-1][0]

    def median(self) -> float:
        return self.quantile(0.5)

    def to_list(self) -> list[list[float]]:
        return [[float(m), float(w)] for m, w in self.centroids]

    @classmethod
    def from_list(cls, centroids: list[list[float]] | None, compression: float) -> "_TDigest":
        td = cls(compression=float(compression), centroids=[])
        for c in centroids or []:
            try:
                td.centroids.append([float(c[0]), float(c[1])])
            except (TypeError, ValueError, IndexError):
                continue
        # Keep the invariant: sorted by mean (loads of a persisted, already-sorted
        # list are a no-op; a hand-edited list is normalised).
        td.centroids.sort(key=lambda c: c[0])
        return td


# --------------------------------------------------------------------------- #
# The candidate signal + the baseline engine.
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class BaselineSignal:
    """One advisory anomaly candidate the baseline emits for a bucket.

    PURE DATA — it carries the robust modified-z, the observed value, the bucket
    percentiles and the warm-up state so a downstream funnel can rank/decide whether
    to escalate it. It NEVER carries a verdict or a status; it can never close a case
    (#3). ``is_anomaly`` is True only when the bucket is warm AND ``|modified_z|``
    exceeds the configured threshold."""

    signature: str
    bucket: int
    value: float
    modified_z: float
    is_anomaly: bool
    warm: bool
    n: int
    p50: float
    p95: float
    p99: float


class BaselineEngine:
    """Streaming, per-(signature, bucket) baseline — a pure advisory PRODUCER.

    Holds the small sketch state per bucket in memory; the persistence layer
    (:mod:`app.stores.baseline`) snapshots/restores it as a compact JSON dict keyed by
    ``cluster_signature``. NOTHING in this class reads risk weights, imports
    ``case_manager``, or calls ``decide()``.
    """

    def __init__(self, config: BaselineConfig | None = None) -> None:
        self._cfg = config or BaselineConfig()
        self._alpha = half_life_to_alpha(self._cfg.half_life_days)
        self._compression = float(self._cfg.tdigest_compression)
        self._seasonality = self._cfg.seasonality
        self._period = SEASONAL_PERIODS.get(self._seasonality, 168)
        # LRU cardinality bound: evict the least-recently-updated series once the count
        # exceeds this (0 == unbounded, the legacy behaviour). Bounds memory / KV size on
        # high-cardinality feeds without touching the per-bucket sketch math.
        self._max_series = int(getattr(self._cfg, "max_series", 0) or 0)
        # {signature: {bucket: BaselineState}} — insertion/update order is the LRU order
        # (a plain dict preserves it; ``_touch`` re-inserts a series to the MRU end).
        self._series: dict[str, dict[int, BaselineState]] = {}
        # Signatures the LRU bound evicted since the last ``drain_evictions()`` — the
        # persistence layer drains these to delete the evicted series from durable KV too,
        # so ``max_series`` bounds the STORE, not just memory.
        self._evicted: list[str] = []

    # ---- config-derived constants (exposed for tests/UI) ----------------- #
    @property
    def alpha(self) -> float:
        """The EWMA smoothing derived from ``half_life_days`` (``1 − exp(−ln2/H)``)."""
        return self._alpha

    @property
    def seasonal_period(self) -> int:
        """Buckets in one seasonal cycle (168 for weekly)."""
        return self._period

    def warmup_target(self) -> int:
        """Samples a bucket needs before it is WARM: ``warmup_multiplier × period``
        (3 × 168 = 504 for weekly). Exposed for the UI warm-up gauge."""
        return int(self._cfg.warmup_multiplier) * self._period

    @property
    def seasonality(self) -> str:
        """The configured seasonality mode (``hour_of_week`` by default)."""
        return self._seasonality

    @property
    def max_series(self) -> int:
        """The LRU series cardinality bound (0 == unbounded)."""
        return self._max_series

    def series_count(self) -> int:
        """How many distinct series are currently held in memory (for the LRU bound)."""
        return len(self._series)

    def drain_evictions(self) -> list[str]:
        """Return + clear the signatures the LRU bound has evicted since the last drain,
        so the persistence layer can delete them from durable KV (keeping the STORE
        bounded, not just memory)."""
        out = self._evicted
        self._evicted = []
        return out

    def bucket_for_time(self, when: datetime) -> int:
        """The seasonal bucket index for a wall-clock ``when`` under this engine's
        seasonality — the realtime consumer uses it to fold a per-tick observation into
        the right hour-of-week bucket without reaching into private state."""
        return bucket_for(self._seasonality, when.weekday(), when.hour)

    # ---- core update recursion ------------------------------------------- #
    def _touch(self, signature: str) -> None:
        """Mark ``signature`` most-recently-used by re-inserting it at the dict's end.
        No-op when the LRU bound is disabled (``max_series == 0``) so the unbounded path
        is byte-identical to before."""
        if not self._max_series:
            return
        buckets = self._series.pop(signature, None)
        if buckets is not None:
            self._series[signature] = buckets

    def _state(self, signature: str, bucket: int) -> BaselineState:
        buckets = self._series.get(signature)
        if buckets is None:
            # A NEW series — enforce the LRU cardinality bound BEFORE inserting it, so the
            # count never exceeds ``max_series`` (evict the least-recently-updated first).
            if self._max_series and len(self._series) >= self._max_series:
                oldest = next(iter(self._series), None)
                if oldest is not None:
                    self._series.pop(oldest, None)
                    self._evicted.append(oldest)
            buckets = {}
            self._series[signature] = buckets
        else:
            self._touch(signature)
        st = buckets.get(bucket)
        if st is None:
            st = BaselineState(version=SKETCH_VERSION)
            buckets[bucket] = st
        return st

    def update(self, signature: str, bucket: int, value: float) -> BaselineState:
        """Fold ONE observation into the (signature, bucket) sketches, recursively.

        Updates, in a FIXED order (so replay is byte-identical):
          1. Welford running mean/variance,
          2. EWMA of ``x`` and of ``x²`` (seeded on the first observation),
          3. the bucket t-digest,
        then re-evaluates the warm-up gate. Returns the updated
        :class:`BaselineState`. Pure recursion — never reads decide()/risk (#3)."""
        x = float(value)
        st = self._state(signature, int(bucket))

        # 1) Welford (numerically-stable unbounded running mean/variance).
        n = st.n + 1
        delta = x - st.welford_m
        new_m = st.welford_m + delta / n
        new_s = st.welford_s + delta * (x - new_m)

        # 2) EWMA of x and of x² (drift-tracking). Seed on the first observation
        #    (pandas adjust=False form: s₁ = x₁), else s_t = α·x + (1−α)·s_{t−1}.
        a = self._alpha
        if st.ewma is None:
            new_ewma = x
            new_ewma_sq = x * x
        else:
            new_ewma = a * x + (1.0 - a) * st.ewma
            prev_sq = st.ewma_sq if st.ewma_sq is not None else (st.ewma * st.ewma)
            new_ewma_sq = a * (x * x) + (1.0 - a) * prev_sq

        # 3) t-digest (robust percentiles for the modified-z / MAD estimate).
        td = _TDigest.from_list(st.tdigest, self._compression)
        td.add(x)

        n_samples = st.n_samples + 1
        warm = n_samples >= self.warmup_target()

        st.welford_m = new_m
        st.welford_s = new_s
        st.n = n
        st.ewma = new_ewma
        st.ewma_sq = new_ewma_sq
        st.tdigest = td.to_list()
        st.n_samples = n_samples
        st.warm = warm
        st.version = SKETCH_VERSION
        return st

    # ---- robust threshold ------------------------------------------------- #
    def modified_z(self, signature: str, bucket: int, value: float) -> float:
        """Robust modified z-score of ``value`` against the (signature, bucket)
        baseline: ``M = 0.6745·(value − median)/MAD`` with the median + MAD read from
        the bucket t-digest. Returns 0.0 for an empty/degenerate bucket (no MAD).

        MAD is estimated robustly from the digest as ``max(median−p25, p75−median)`` —
        a symmetric-half spread that, unlike a full ``median(|x−median|)`` (which needs
        raw history), is available from the streaming quantiles and equals the true MAD
        for a symmetric distribution. Falls back to a small quantile spread when the
        IQR is degenerate so a spike against a near-constant baseline still flags."""
        st = self._series.get(signature, {}).get(int(bucket))
        if st is None or not st.tdigest:
            return 0.0
        td = _TDigest.from_list(st.tdigest, self._compression)
        median = td.median()
        p25 = td.quantile(0.25)
        p75 = td.quantile(0.75)
        # Robust dispersion: the larger half-spread from the median (≈ MAD for a
        # symmetric spread; for the true normal, MAD = 0.6745·σ and IQR/2 = 0.6745·σ).
        mad = max(median - p25, p75 - median)
        if mad <= 0.0:
            # Degenerate IQR (near-constant history): fall back to a wider spread so a
            # genuine spike still registers; if THAT is also zero the bucket is a flat
            # constant and any different value is trivially an outlier.
            mad = max(td.quantile(0.99) - median, median - td.quantile(0.01))
            if mad <= 0.0:
                return 0.0 if float(value) == median else math.inf
        return _MODIFIED_Z_K * (float(value) - median) / mad

    def is_anomaly(self, signature: str, bucket: int, value: float) -> bool:
        """True when the bucket is WARM and ``|modified_z| > modified_z_threshold``.

        Cold buckets NEVER flag (the warm-up gate), so a candidate is only produced
        once the baseline has earned trust for that hour-of-week. Advisory only."""
        if not self.is_warm(signature, bucket):
            return False
        return abs(self.modified_z(signature, bucket, value)) > float(self._cfg.modified_z_threshold)

    # ---- warm-up gate ----------------------------------------------------- #
    def is_warm(self, signature: str, bucket: int) -> bool:
        """Whether the (signature, bucket) baseline has enough history to be trusted:
        ``n_samples ≥ warmup_multiplier × seasonal_period``. Missing bucket → cold."""
        st = self._series.get(signature, {}).get(int(bucket))
        if st is None:
            return False
        return st.n_samples >= self.warmup_target()

    def warmup(self, signature: str, bucket: int) -> tuple[int, int]:
        """``(n, target)`` for a UI warm-up gauge — how many observations the bucket
        has vs how many it needs to become warm."""
        st = self._series.get(signature, {}).get(int(bucket))
        n = st.n_samples if st is not None else 0
        return n, self.warmup_target()

    # ---- percentiles (UI: live p50/p95/p99) ------------------------------ #
    def percentiles(self, signature: str, bucket: int) -> tuple[float, float, float]:
        """Robust ``(p50, p95, p99)`` for the (signature, bucket) t-digest (all 0.0
        when the bucket is empty). Read-only — never mutates the sketch."""
        st = self._series.get(signature, {}).get(int(bucket))
        if st is None or not st.tdigest:
            return 0.0, 0.0, 0.0
        td = _TDigest.from_list(st.tdigest, self._compression)
        return td.quantile(0.5), td.quantile(0.95), td.quantile(0.99)

    # ---- the producer: observe → maybe-emit a candidate signal ----------- #
    def observe(self, signature: str, bucket: int, value: float) -> BaselineSignal:
        """Fold ``value`` in AND return the advisory :class:`BaselineSignal` for it.

        The modified-z is computed on the state INCLUDING this observation (the value
        is folded before scoring, so the sketch always reflects everything seen — the
        anomaly is judged against the baseline it is now part of). The candidate is a
        pure signal: it feeds the SAME deterministic pipeline downstream and can never
        close a case (#3)."""
        self.update(signature, bucket, value)
        b = int(bucket)
        mz = self.modified_z(signature, b, value)
        warm = self.is_warm(signature, b)
        p50, p95, p99 = self.percentiles(signature, b)
        n, _target = self.warmup(signature, b)
        anomalous = warm and abs(mz) > float(self._cfg.modified_z_threshold)
        return BaselineSignal(
            signature=signature, bucket=b, value=float(value), modified_z=mz,
            is_anomaly=anomalous, warm=warm, n=n, p50=p50, p95=p95, p99=p99,
        )

    # ---- snapshot / restore (persistence bridge) ------------------------- #
    def snapshot(self, signature: str) -> dict[int, BaselineState]:
        """The per-bucket sketch states for one signature (empty dict when unseen).
        Returned by reference — the caller serialises via ``model_dump``."""
        return dict(self._series.get(signature, {}))

    def restore(self, signature: str, buckets: dict[int, BaselineState]) -> None:
        """Load persisted per-bucket sketch states for one signature (replaces any
        in-memory state for it). The store owns (de)serialisation; this just seats the
        typed states so subsequent ``update``/``observe`` calls continue the stream."""
        self._series[signature] = {int(b): st for b, st in (buckets or {}).items()}

    def clear(self, signature: str | None = None) -> None:
        """Drop in-memory sketches (one signature, or all when ``signature`` is None)."""
        if signature is None:
            self._series.clear()
        else:
            self._series.pop(signature, None)
