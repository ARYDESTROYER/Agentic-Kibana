"""Round 4 Wave 3 — entity BASELINE that improves over time (offline).

Covers the precise "how does the base improve" method from
``docs/research/2026-07-round4`` — online single-pass streaming stats updated
recursively per observation, per ``cluster_signature``, per 168 hour-of-week bucket:

* **Determinism** — a repeated identical stream yields byte-identical sketch state.
* **EWMA drift** — tracks a level shift with the ``alpha`` expected for ``H = 14d``.
* **Robust threshold** — modified-z flags a clear outlier and NOT normal variation.
* **Warm-up gate** — suppresses candidates until ``3 × seasonal_period`` samples.
* **Store round-trip / snapshot / restore** over the fake KV.
* **Invariant #3** — the module never imports ``case_manager`` / reads risk weights /
  calls ``decide()``.

Network-free (the autouse conftest guard blocks non-loopback egress); the baseline is
pure math + a KV store, so nothing here touches the network or an LLM.
"""

from __future__ import annotations

import math

import pytest

from app.config import BaselineConfig
from app.engine import baseline as baseline_mod
from app.engine.baseline import (
    BaselineEngine,
    _TDigest,
    bucket_for,
    half_life_to_alpha,
    hour_of_week,
)
from app.models import BaselineState
from app.state import AppState
from app.stores.baseline import BaselineStore


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _cfg(**over) -> BaselineConfig:
    base = dict(enabled=True, half_life_days=14.0, warmup_multiplier=3,
                modified_z_threshold=3.5, tdigest_compression=100,
                seasonality="hour_of_week")
    base.update(over)
    return BaselineConfig(**base)


def _feed(eng: BaselineEngine, sig: str, bucket: int, values) -> None:
    for v in values:
        eng.update(sig, bucket, float(v))


# --------------------------------------------------------------------------- #
# half-life ↔ alpha + bucketing
# --------------------------------------------------------------------------- #
def test_half_life_to_alpha_matches_formula() -> None:
    # alpha = 1 - exp(-ln2 / H); H = 14 days.
    assert half_life_to_alpha(14.0) == pytest.approx(1.0 - math.exp(-math.log(2) / 14.0))
    # Slower half-life -> smaller alpha (more weight on history).
    assert half_life_to_alpha(28.0) < half_life_to_alpha(14.0) < half_life_to_alpha(7.0)
    # Degenerate inputs are guarded into (0, 1].
    assert half_life_to_alpha(0.0) == 1.0
    assert 0.0 < half_life_to_alpha(14.0) <= 1.0


def test_hour_of_week_bucketing() -> None:
    assert hour_of_week(0, 0) == 0
    assert hour_of_week(6, 23) == 167
    assert hour_of_week(3, 5) == 3 * 24 + 5
    # Clamp out-of-range so a malformed timestamp never indexes past 168 buckets.
    assert 0 <= hour_of_week(99, 99) <= 167
    assert bucket_for("hour_of_day", 3, 5) == 5
    assert bucket_for("day_of_week", 3, 5) == 3
    assert bucket_for("none", 3, 5) == 0


# --------------------------------------------------------------------------- #
# DETERMINISM: repeated identical stream -> byte-identical state
# --------------------------------------------------------------------------- #
def test_determinism_identical_stream_byte_identical_state() -> None:
    stream = [5.0, 7.0, 6.0, 8.0, 5.5, 9.0, 4.0, 12.0, 6.5, 7.5, 3.0, 11.0, 6.0, 8.5]

    def run() -> dict:
        eng = BaselineEngine(_cfg())
        for v in stream:
            eng.update("sig-A", 42, v)
        st = eng.snapshot("sig-A")[42]
        return st.model_dump(mode="json")

    a = run()
    b = run()
    assert a == b  # byte-identical serialised sketch state

    # Order matters for the recursion, but the SAME order always reproduces. A
    # different insertion order is (correctly) allowed to differ — determinism is
    # about identical inputs in identical order.
    eng1, eng2 = BaselineEngine(_cfg()), BaselineEngine(_cfg())
    for v in stream:
        eng1.update("s", 0, v)
    for v in stream:
        eng2.update("s", 0, v)
    assert eng1.snapshot("s")[0].model_dump() == eng2.snapshot("s")[0].model_dump()


def test_tdigest_serialisation_is_stable_and_pinned() -> None:
    eng = BaselineEngine(_cfg(tdigest_compression=100))
    for v in range(1, 200):
        eng.update("s", 0, float(v))
    st = eng.snapshot("s")[0]
    # Round-trip the persisted centroids -> identical percentiles (pinned compression).
    td = _TDigest.from_list(st.tdigest, 100)
    p50a, p95a, p99a = eng.percentiles("s", 0)
    assert td.quantile(0.5) == pytest.approx(p50a)
    assert td.quantile(0.95) == pytest.approx(p95a)
    assert td.quantile(0.99) == pytest.approx(p99a)
    # Centroid count stays bounded by ~compression (t-digest space bound).
    assert len(st.tdigest) <= 100 * 2


def test_tdigest_centroid_count_is_hard_bounded_under_a_long_stream() -> None:
    """The t-digest MUST NOT grow without limit: the K1 scale-function merge caps the
    centroid count at ≈ compression regardless of how many observations stream in.

    Regression for finding #16 — the old ``max(bound, 1.0)`` floor forced every tail
    centroid to survive as a weight-1 singleton, so the count grew ~logarithmically
    (memory per signature/bucket leaked forever). Feeding 5000 heavy-tailed values into
    one bucket must leave the centroid count comfortably under the Elasticsearch node
    bound of ``20 × compression`` — and, in fact, near ``compression`` itself."""
    import random

    for compression in (50, 100, 200):
        eng = BaselineEngine(_cfg(tdigest_compression=compression))
        rng = random.Random(1234)
        for _ in range(5000):
            # A skewed, heavy-tailed mix (the worst case for the buggy floor: many
            # distinct tail values that used to each survive as a singleton).
            eng.update("s", 0, rng.lognormvariate(3.0, 1.0))
        st = eng.snapshot("s")[0]
        # Faithful bound: well under the ES node cap of 20*compression, and in practice
        # ~compression (the K1 total range is compression/2 k-units).
        assert len(st.tdigest) <= 20 * compression
        assert len(st.tdigest) <= 2 * compression
        # All the weight is still accounted for (no observations dropped by merging).
        assert sum(w for _, w in st.tdigest) == pytest.approx(5000.0)


def test_tdigest_bounded_and_byte_identical_replay() -> None:
    """A long identical stream stays byte-identical across runs AND bounded — the fix
    must not trade determinism (replay is the property that lets the baseline live
    OUTSIDE the deterministic decision) for the memory bound."""
    import random

    def run() -> list:
        eng = BaselineEngine(_cfg(tdigest_compression=100))
        rng = random.Random(99)
        for _ in range(5000):
            eng.update("sig-Z", 3, rng.gauss(100.0, 15.0))
        return eng.snapshot("sig-Z")[3].tdigest

    a = run()
    b = run()
    assert a == b                       # byte-identical centroid list across replays
    assert len(a) <= 2 * 100            # and still bounded


def test_tdigest_bound_holds_as_stream_grows_no_leak() -> None:
    """The count must PLATEAU as n grows (not keep climbing) — the direct assertion the
    old docstring/test falsely implied. With the buggy floor the count rose monotonically
    with n; with the K1 bound it settles."""
    import random

    eng = BaselineEngine(_cfg(tdigest_compression=100))
    rng = random.Random(7)
    counts: dict[int, int] = {}
    for i in range(1, 40001):
        eng.update("s", 0, rng.gauss(50.0, 8.0))
        if i in (10000, 20000, 40000):
            counts[i] = len(eng.snapshot("s")[0].tdigest)
    # 4× the data must not meaningfully grow the sketch (bounded, not logarithmic).
    assert counts[40000] <= 2 * 100
    assert counts[40000] <= counts[10000] + 20   # essentially flat, no unbounded creep


# --------------------------------------------------------------------------- #
# EWMA tracks a level shift with the expected alpha for H = 14d
# --------------------------------------------------------------------------- #
def test_ewma_seed_and_recursion_match_expected_alpha() -> None:
    cfg = _cfg(half_life_days=14.0)
    eng = BaselineEngine(cfg)
    alpha = half_life_to_alpha(14.0)
    assert eng.alpha == pytest.approx(alpha)

    # Seed: s1 = x1 (pandas adjust=False form).
    eng.update("s", 0, 10.0)
    assert eng.snapshot("s")[0].ewma == pytest.approx(10.0)
    assert eng.snapshot("s")[0].ewma_sq == pytest.approx(100.0)

    # One recursion step: s_t = alpha*x + (1-alpha)*s_{t-1}.
    eng.update("s", 0, 20.0)
    expected = alpha * 20.0 + (1 - alpha) * 10.0
    assert eng.snapshot("s")[0].ewma == pytest.approx(expected)


def test_ewma_tracks_a_sustained_level_shift() -> None:
    # A conservative (slow) H=14d must MOVE toward a sustained new level but NOT snap
    # to it instantly (so a sustained attack isn't absorbed into "normal" in one step).
    cfg = _cfg(half_life_days=14.0)
    eng = BaselineEngine(cfg)
    alpha = eng.alpha
    for _ in range(50):          # settle at level 10
        eng.update("s", 0, 10.0)
    settled = eng.snapshot("s")[0].ewma
    assert settled == pytest.approx(10.0, abs=1e-6)

    # Level shifts to 100 and sustains. The EWMA should climb but lag.
    ewma = settled
    for _ in range(100):
        eng.update("s", 0, 100.0)
        ewma = alpha * 100.0 + (1 - alpha) * ewma  # mirror the recursion
    assert eng.snapshot("s")[0].ewma == pytest.approx(ewma)
    # After enough sustained observations it has substantially converged toward 100
    # (tracks drift) but the recursion, not a rescan, produced it.
    assert eng.snapshot("s")[0].ewma > 90.0

    # A FAST half-life converges faster than the slow default (the adaptation-speed
    # fork): more weight on recent data -> closer to 100 after the same # of steps.
    fast = BaselineEngine(_cfg(half_life_days=1.0))
    for _ in range(50):
        fast.update("s", 0, 10.0)
    for _ in range(20):
        fast.update("s", 0, 100.0)
    slow = BaselineEngine(_cfg(half_life_days=14.0))
    for _ in range(50):
        slow.update("s", 0, 10.0)
    for _ in range(20):
        slow.update("s", 0, 100.0)
    assert fast.snapshot("s")[0].ewma > slow.snapshot("s")[0].ewma


def test_welford_running_mean_variance() -> None:
    eng = BaselineEngine(_cfg())
    xs = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0]
    for v in xs:
        eng.update("s", 0, v)
    st = eng.snapshot("s")[0]
    # Welford mean == arithmetic mean; sample variance == S/(n-1).
    assert st.welford_m == pytest.approx(sum(xs) / len(xs))
    n = len(xs)
    mean = sum(xs) / n
    sample_var = sum((x - mean) ** 2 for x in xs) / (n - 1)
    assert st.welford_s / (st.n - 1) == pytest.approx(sample_var)
    assert st.n == n


# --------------------------------------------------------------------------- #
# Robust threshold: modified-z flags a clear outlier and NOT normal variation
# --------------------------------------------------------------------------- #
def test_modified_z_flags_outlier_not_normal_variation() -> None:
    eng = BaselineEngine(_cfg(modified_z_threshold=3.5))
    # A tight, roughly-symmetric baseline centred ~10.
    normal = [9, 10, 11, 10, 9, 11, 10, 8, 12, 10, 9, 11, 10, 10, 9, 11, 10, 8, 12, 10] * 5
    _feed(eng, "s", 0, normal)

    # A value inside the normal band is NOT flagged.
    z_norm = eng.modified_z("s", 0, 10.0)
    assert abs(z_norm) < 3.5
    z_edge = eng.modified_z("s", 0, 12.0)
    assert abs(z_edge) < 3.5

    # A gross spike IS flagged (|M| well over 3.5).
    z_spike = eng.modified_z("s", 0, 1000.0)
    assert abs(z_spike) > 3.5


def test_modified_z_resists_a_single_bad_reading() -> None:
    # The robust estimator must not let one huge value inflate dispersion enough to
    # hide a later spike (the whole point of MAD over stddev).
    eng = BaselineEngine(_cfg())
    for v in ([10.0] * 200):
        eng.update("s", 0, v)
    eng.update("s", 0, 5000.0)          # one contaminating reading
    # A subsequent real spike is still an outlier (dispersion wasn't blown out).
    assert abs(eng.modified_z("s", 0, 900.0)) > 3.5


def test_modified_z_empty_bucket_is_zero() -> None:
    eng = BaselineEngine(_cfg())
    assert eng.modified_z("never-seen", 0, 42.0) == 0.0


# --------------------------------------------------------------------------- #
# Warm-up gate: suppress until 3x seasonal period, then open
# --------------------------------------------------------------------------- #
def test_warmup_gate_suppresses_then_opens() -> None:
    cfg = _cfg(seasonality="hour_of_week", warmup_multiplier=3)
    eng = BaselineEngine(cfg)
    target = eng.warmup_target()
    assert eng.seasonal_period == 168
    assert target == 3 * 168            # 504 for weekly buckets

    # Feed a clean baseline, then one clear anomaly value each step. Below target the
    # bucket is COLD so NO candidate fires even for an extreme value.
    for i in range(target - 1):
        sig = eng.observe("s", 5, 10.0)
        assert sig.warm is False
        # An anomaly is never emitted while cold, regardless of the value.
        assert sig.is_anomaly is False
        n, tgt = eng.warmup("s", 5)
        assert tgt == target and n == i + 1

    # The observation that reaches the target flips warm.
    sig = eng.observe("s", 5, 10.0)
    assert sig.warm is True
    assert eng.is_warm("s", 5) is True

    # Now a clear spike DOES produce an anomaly candidate (warm + |M| > threshold).
    hot = eng.observe("s", 5, 5000.0)
    assert hot.warm is True
    assert hot.is_anomaly is True
    assert abs(hot.modified_z) > cfg.modified_z_threshold


def test_is_anomaly_false_when_cold_even_for_extreme_value() -> None:
    eng = BaselineEngine(_cfg())
    # Only a handful of samples => cold => no anomaly no matter how extreme.
    for _ in range(5):
        eng.update("s", 0, 10.0)
    assert eng.is_warm("s", 0) is False
    assert eng.is_anomaly("s", 0, 99999.0) is False


def test_warmup_target_scales_with_seasonality() -> None:
    assert BaselineEngine(_cfg(seasonality="hour_of_week")).warmup_target() == 504
    assert BaselineEngine(_cfg(seasonality="hour_of_day")).warmup_target() == 72
    assert BaselineEngine(_cfg(seasonality="day_of_week")).warmup_target() == 21
    assert BaselineEngine(_cfg(seasonality="none")).warmup_target() == 3


# --------------------------------------------------------------------------- #
# snapshot / restore continues the stream
# --------------------------------------------------------------------------- #
def test_snapshot_restore_continues_stream_identically() -> None:
    stream = [float(v) for v in range(1, 40)]
    # Run straight through.
    straight = BaselineEngine(_cfg())
    for v in stream:
        straight.update("s", 0, v)

    # Run half, snapshot, restore into a fresh engine, run the rest.
    a = BaselineEngine(_cfg())
    for v in stream[:20]:
        a.update("s", 0, v)
    snap = {b: st.model_copy(deep=True) for b, st in a.snapshot("s").items()}
    b_eng = BaselineEngine(_cfg())
    b_eng.restore("s", snap)
    for v in stream[20:]:
        b_eng.update("s", 0, v)

    assert straight.snapshot("s")[0].model_dump() == b_eng.snapshot("s")[0].model_dump()


# --------------------------------------------------------------------------- #
# BaselineStore round-trip over the fake KV (mirrors user_prefs pattern)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_baseline_store_round_trip(app_state: AppState) -> None:
    store = BaselineStore(app_state._kv)
    assert await store.get("sig-1") == {}
    assert await store.list_signatures() == []

    buckets = {
        5: BaselineState(welford_m=10.0, welford_s=4.0, n=3, ewma=10.0, ewma_sq=101.0,
                         tdigest=[[9.0, 1.0], [10.0, 1.0], [11.0, 1.0]],
                         n_samples=3, warm=False, version=1),
        160: BaselineState(welford_m=2.0, n=1, ewma=2.0, ewma_sq=4.0, n_samples=1),
    }
    await store.put("sig-1", buckets)

    loaded = await store.get("sig-1")
    assert set(loaded.keys()) == {5, 160}
    assert loaded[5].model_dump() == buckets[5].model_dump()
    assert loaded[160].model_dump() == buckets[160].model_dump()
    assert await store.list_signatures() == ["sig-1"]

    # A second signature is isolated.
    await store.put("sig-2", {0: BaselineState(n_samples=7)})
    assert set(await store.list_signatures()) == {"sig-1", "sig-2"}
    assert (await store.get("sig-2"))[0].n_samples == 7
    # sig-1 untouched by the sig-2 write.
    assert (await store.get("sig-1"))[5].n_samples == 3


@pytest.mark.asyncio
async def test_baseline_store_snapshot_restore_whole_store(app_state: AppState) -> None:
    store = BaselineStore(app_state._kv)
    eng = BaselineEngine(_cfg())
    for v in [1.0, 2.0, 3.0, 4.0, 5.0]:
        eng.update("sig-X", 0, v)
        eng.update("sig-Y", 12, v * 2)

    # Flush the whole engine to durable KV, then warm a fresh engine from it.
    series = {sig: eng.snapshot(sig) for sig in ("sig-X", "sig-Y")}
    await store.restore(series)

    restored = await store.snapshot()
    assert set(restored.keys()) == {"sig-X", "sig-Y"}

    fresh = BaselineEngine(_cfg())
    for sig, buckets in restored.items():
        fresh.restore(sig, buckets)
    # Continuing the stream from the restored state matches an uninterrupted run.
    fresh.update("sig-X", 0, 6.0)
    eng.update("sig-X", 0, 6.0)
    assert fresh.snapshot("sig-X")[0].model_dump() == eng.snapshot("sig-X")[0].model_dump()


@pytest.mark.asyncio
async def test_baseline_store_delete_and_clear(app_state: AppState) -> None:
    store = BaselineStore(app_state._kv)
    await store.put("a", {0: BaselineState(n_samples=1)})
    await store.put("b", {0: BaselineState(n_samples=1)})
    assert await store.delete("a") is True
    assert await store.delete("a") is False
    assert await store.list_signatures() == ["b"]
    await store.clear()
    assert await store.list_signatures() == []


# --------------------------------------------------------------------------- #
# INVARIANTS: pure producer — never imports case_manager / reads risk weights /
# calls decide()
# --------------------------------------------------------------------------- #
def _imported_module_names(mod) -> set[str]:
    """Every module name a module imports (via AST, so docstring/comment prose that
    merely MENTIONS a name doesn't count) — the real #3 producer-purity check."""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(mod))
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            names.add(base)
            names.update(f"{base}.{a.name}" for a in node.names)
    return names


def _code_identifiers(mod) -> set[str]:
    """All ast.Name / ast.Attribute identifiers used in EXECUTABLE code (not in
    docstrings/comments), so we can assert the module never calls ``decide`` or reads
    a risk-weight attribute even though its prose describes both."""
    import ast
    import inspect

    tree = ast.parse(inspect.getsource(mod))
    ids: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            ids.add(node.id)
        elif isinstance(node, ast.Attribute):
            ids.add(node.attr)
    return ids


def test_baseline_module_never_imports_decision_or_risk() -> None:
    from app.stores import baseline as store_mod

    for mod in (baseline_mod, store_mod):
        imports = _imported_module_names(mod)
        # #3 — never imports the deterministic decision or the risk engine.
        assert not any("case_manager" in name for name in imports), imports
        assert not any(name.endswith(".risk") or name.endswith(".engine.risk")
                       for name in imports), imports
        # And never CALLS decide() anywhere in executable code.
        idents = _code_identifiers(mod)
        assert "decide" not in idents
        assert "case_manager" not in idents
        # Sanity: we really parsed real code (the engine imports its config model).
    assert any("config" in n for n in _imported_module_names(baseline_mod))


def test_signal_is_pure_data_no_verdict_or_status() -> None:
    eng = BaselineEngine(_cfg(seasonality="none", warmup_multiplier=1))
    # 'none' seasonality => target = 1*1 = 1, so it warms immediately.
    for v in [10.0] * 30:
        eng.observe("s", 0, v)
    sig = eng.observe("s", 0, 10.0)
    # The signal carries measurements only — no 'verdict'/'status'/'decision' fields.
    fields = set(sig.__dataclass_fields__)
    assert "verdict" not in fields and "status" not in fields and "decision" not in fields
    assert {"signature", "bucket", "value", "modified_z", "is_anomaly", "warm",
            "n", "p50", "p95", "p99"} <= fields
