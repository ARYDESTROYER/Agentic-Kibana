"""Round 4 / Wave 6 harden — poller fan-out concurrency (H2).

Two HIGH findings from the adversarial audit are fixed here and proved offline:

  * FINDING #5 — the poller fan-out runs per-source pollers CONCURRENTLY, and the
    ``find_open_by_signature → save`` critical section (register_candidate /
    investigate_cluster / ingest.handle_clusters) was NOT atomic across them, so two
    concurrent ticks/sources for the SAME cluster signature could each mint a case
    (breaking #4 — one open case per signature). FIX: a shared per-signature
    ``asyncio.Lock`` on the pipeline serializes that critical section per signature.

  * FINDING #6/#15 — the manager MONKEYPATCHED the shared ``pipeline.investigate_cluster``
    on each fan-out tick and restored it on exit; two overlapping ticks (the scheduler
    loop + a manual ``POST /api/poll``) could install/restore concurrently and
    permanently corrupt the shared method. FIX: the monkeypatch is GONE; whole ticks are
    serialized by a per-manager ``asyncio.Lock`` (a manual poll waits for the loop tick).

  * FINDING #7 — the EVENT-feed funnel hook was wired onto the PRIMARY child only. FIX:
    the manager propagates its ``_event_funnel`` reference to EVERY child on rebuild.

All offline: fake ES, no LLM (candidate path is $0; forced-investigation uses the mock
provider). The InMemoryESClient's async search/save give real ``await`` yield points, so
without the locks the interleaved tasks WOULD both create a case — the assertions below
are meaningful.
"""

from __future__ import annotations

import asyncio

import pytest

from app.config import CorrelationRule, SourceInstance
from app.constants import (
    CorrelationMode,
    EntityType,
    SourceSurface,
    SourceType,
)
from app.engine.correlation import correlate
from app.engine.ingest import handle_clusters
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

asyncio_mark = pytest.mark.asyncio


async def _set_threshold(state: AppState, n: int = 3) -> None:
    p = state.prefs.model_copy(deep=True)
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=n, window_seconds=3600, group_by=EntityType.IP
    )
    await state.update_prefs(p)


def _events(ip: str, n: int = 4, prefix: str = "e") -> list:
    base = to_millis(now_utc()) - 60_000
    return [
        make_log_event(ip=ip, ts_millis=base + i * 1000) | {}  # dict copy
        for i in range(n)
    ]


def _cluster_for(state: AppState, ip: str, n: int = 4):
    """Correlate ``n`` events for one IP into a single cluster (stable signature =
    (ip, value); source-independent, so two sources yield the SAME signature)."""
    from app.models import RawEvent

    base = to_millis(now_utc()) - 60_000
    evs = [
        RawEvent(
            id=f"{ip}-{i}", index="x", source={}, timestamp_millis=base + i * 1000,
            ip=ip, rule="r", rule_name="r", severity=6.0,
        )
        for i in range(n)
    ]
    clusters = correlate(evs, state.prefs)
    assert len(clusters) == 1
    return clusters[0]


def _source(sid: str, pattern: str, *, primary: bool = False, **cfg) -> SourceInstance:
    return SourceInstance(
        id=sid, source_type=SourceType.ELASTICSEARCH, display_name=sid,
        enabled=True, is_primary=primary,
        config={"data_view_pattern": pattern, **cfg},
    )


def _seed(state: AppState, index: str, ip: str, n: int = 4) -> None:
    base = to_millis(now_utc()) - 60_000
    for i in range(n):
        state.es.add_log(index, make_log_event(ip=ip, ts_millis=base + i * 1000),
                         doc_id=f"{index}-{ip}-{i}")


async def _configure_sources(state: AppState, sources: list[SourceInstance]) -> None:
    prefs = state.prefs.model_copy(deep=True)
    prefs.sources = sources
    await state.update_prefs(prefs)
    state.rebuild_log_source()


# --------------------------------------------------------------------------- #
# FINDING #5 — one signature → exactly ONE case under concurrency.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_concurrent_register_candidate_same_signature_one_case(app_state: AppState):
    """Two concurrent ``register_candidate`` calls for the SAME cluster signature must
    create EXACTLY ONE case (#4). Without the per-signature lock both would run their
    find→save interleaved and each insert a new case."""
    await _set_threshold(app_state, 3)
    c1 = _cluster_for(app_state, "10.0.0.1")
    c2 = _cluster_for(app_state, "10.0.0.1")  # SAME entity → SAME signature
    assert c1.signature == c2.signature

    await asyncio.gather(
        app_state.pipeline.register_candidate(c1, SourceSurface.AUTOMATED_SCAN, app_state.prefs),
        app_state.pipeline.register_candidate(c2, SourceSurface.AUTOMATED_SCAN, app_state.prefs),
    )

    cases, total = await app_state.cases.list()
    assert total == 1
    sigs = {c.cluster_signature for c in cases}
    assert sigs == {c1.signature}


@asyncio_mark
async def test_concurrent_handle_clusters_same_signature_one_case(app_state: AppState):
    """Two concurrent ``handle_clusters`` runs (the shared ingest path — poller +
    receivers) for the SAME signature must yield ONE case. Proves the ingest critical
    section holds the same shared per-signature lock as the pipeline methods."""
    await _set_threshold(app_state, 3)
    c1 = _cluster_for(app_state, "10.0.0.2")
    c2 = _cluster_for(app_state, "10.0.0.2")
    assert c1.signature == c2.signature

    stats = await asyncio.gather(
        handle_clusters([c1], app_state.prefs, cases=app_state.cases,
                        pipeline=app_state.pipeline, source_surface=SourceSurface.AUTOMATED_SCAN),
        handle_clusters([c2], app_state.prefs, cases=app_state.cases,
                        pipeline=app_state.pipeline, source_surface=SourceSurface.AUTOMATED_SCAN),
    )
    # Exactly one candidate was created; the other run attached (or also candidate-then-
    # attach), but the store holds ONE case for the signature.
    cases, total = await app_state.cases.list()
    assert total == 1
    # Combined stats: exactly one create across both runs (candidates==1 total), the
    # second run attaches (attached>=1) — never two candidates for one signature.
    total_candidates = sum(s.get("candidates", 0) for s in stats)
    assert total_candidates == 1


@asyncio_mark
async def test_concurrent_fanout_poll_same_signature_one_case(app_state: AppState):
    """Two enabled PULL sources emitting events for the SAME IP (→ SAME signature) are
    polled concurrently in ONE fan-out tick; the store must hold exactly ONE case for
    that signature (#4). This is the end-to-end version of finding #5."""
    await _set_threshold(app_state, 3)
    # Both sources carry the SAME entity IP → identical signature.
    _seed(app_state, "srcA-logs", "10.0.0.9")
    _seed(app_state, "srcB-logs", "10.0.0.9")
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
    ])

    stats = await app_state.poller.poll_once(app_state.prefs)
    assert stats["clusters"] >= 2  # both sources correlated a cluster

    cases, total = await app_state.cases.list()
    # ONE signature across two sources → ONE case (attach, not duplicate).
    assert total == 1
    assert cases[0].entity.value == "10.0.0.9"


# --------------------------------------------------------------------------- #
# FINDING #6/#15 — no monkeypatch; overlapping poll_once ticks don't corrupt.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_overlapping_poll_once_does_not_corrupt_investigate_cluster(app_state: AppState):
    """Two overlapping ``poll_once`` calls (loop tick + manual /api/poll) must leave
    ``pipeline.investigate_cluster`` the ORIGINAL bound method afterwards — the old
    monkeypatch-and-restore guard corrupted it on overlap. The per-manager poll lock
    serializes ticks so this can never happen."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "srcA-logs", "10.1.0.1")
    _seed(app_state, "srcB-logs", "10.1.0.2")
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
    ])

    pipeline = app_state.pipeline
    # Compare the UNDERLYING function (bound methods aren't identity-stable): a
    # monkeypatch would have replaced it with a wrapped closure / free function.
    original_func = pipeline.investigate_cluster.__func__

    # Fire two overlapping ticks concurrently.
    await asyncio.gather(
        app_state.poller.poll_once(app_state.prefs),
        app_state.poller.poll_once(app_state.prefs),
    )

    # The shared method is UNCHANGED — never left a wrapped closure from a guard.
    assert pipeline.investigate_cluster.__func__ is original_func
    # It is still a real bound method of the shared pipeline (not a swapped-in closure).
    assert getattr(pipeline.investigate_cluster, "__self__", None) is pipeline


@asyncio_mark
async def test_overlapping_poll_once_forced_investigation_no_double_investigate(app_state: AppState):
    """With auto-forwarding ON and TWO overlapping ticks over the SAME signature (two
    sources, same IP), the signature is investigated at most once → exactly ONE case,
    and never two concurrent investigations racing on the case doc."""
    await _set_threshold(app_state, 3)
    # Enable auto-forward for everything so the alert path investigates.
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = True
    prefs.auto_forward_allowlist = ["*"]
    await app_state.update_prefs(prefs)

    _seed(app_state, "srcA-logs", "10.2.0.1")
    _seed(app_state, "srcB-logs", "10.2.0.1")  # SAME ip → SAME signature
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
    ])

    await asyncio.gather(
        app_state.poller.poll_once(app_state.prefs),
        app_state.poller.poll_once(app_state.prefs),
    )
    cases, total = await app_state.cases.list()
    assert total == 1
    assert cases[0].cluster_signature is not None
    # The one case for the signature is a single coherent case (not two racing writes).
    assert cases[0].entity.value == "10.2.0.1"


@asyncio_mark
async def test_poll_lock_serializes_ticks(app_state: AppState):
    """The per-manager poll lock makes overlapping ``poll_once`` calls run one-at-a-time.
    We wrap the locked body to observe max concurrency == 1."""
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
    ])
    mgr = app_state.poller
    inflight = {"n": 0, "max": 0}
    orig = mgr._poll_once_locked

    async def _tracking(prefs):
        inflight["n"] += 1
        inflight["max"] = max(inflight["max"], inflight["n"])
        await asyncio.sleep(0)  # yield so a second tick could interleave if unlocked
        try:
            return await orig(prefs)
        finally:
            inflight["n"] -= 1

    mgr._poll_once_locked = _tracking  # type: ignore[assignment]
    try:
        await asyncio.gather(
            mgr.poll_once(app_state.prefs),
            mgr.poll_once(app_state.prefs),
            mgr.poll_once(app_state.prefs),
        )
    finally:
        mgr._poll_once_locked = orig  # type: ignore[assignment]
    assert inflight["max"] == 1  # never two ticks in the locked body at once


# --------------------------------------------------------------------------- #
# FINDING #7 — the funnel hook rides EVERY child, not just the primary.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_event_funnel_propagates_to_every_child_via_state(app_state: AppState):
    """The state-wired manager-level EVENT-feed hook reaches EVERY child (primary +
    non-primary) after a normal multi-source (re)build — the finding-#7 fix. Previously
    only the primary child carried it, so an events-role feed on a NON-primary source
    was never routed to the funnel."""
    # The app_state fixture wired state._route_event_feed onto the primary → captured
    # as the manager-level hook on rebuild. (Bound methods aren't identity-stable, so
    # compare the underlying func + bound instance.)
    hook = app_state.poller._event_funnel
    assert hook is not None
    ref = (hook.__func__, hook.__self__)
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
        _source("srcC", "srcC-logs*"),
    ])
    # At least two NON-primary children exist and ALL carry the SAME state hook.
    assert len(app_state.poller._children) >= 2
    for p in app_state.poller._all_pollers():
        f = p._event_funnel
        assert f is not None
        assert (f.__func__, f.__self__) == ref


@asyncio_mark
async def test_set_event_funnel_fans_out_to_children(app_state: AppState):
    """``set_event_funnel`` stores the manager-level reference and fans it out to every
    CURRENT child immediately (no rebuild needed). We configure sources FIRST, then set
    the hook, so the children pre-exist when it is applied."""
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
    ])
    assert len(app_state.poller._children) >= 1

    async def _funnel(events, prefs):  # pragma: no cover - identity marker
        return None

    app_state.poller.set_event_funnel(_funnel)
    for p in app_state.poller._all_pollers():
        assert p._event_funnel is _funnel

    # Clearing it fans None out to every child too (routing off).
    app_state.poller.set_event_funnel(None)
    for p in app_state.poller._all_pollers():
        assert p._event_funnel is None
