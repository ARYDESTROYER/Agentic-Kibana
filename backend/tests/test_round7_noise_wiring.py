"""Round 7 — Noise-Reduction counter sink wiring (offline).

★a wires a fail-open ``_noise_sink`` onto BOTH ingest paths as a SEPARATE hook from the
Round-4 ``_event_funnel`` (P0 name-collision avoidance). These tests prove — fully offline
(fake ES, no LLM, no network) — that:

* ``AppState`` exposes the durable ``noise_counters`` store over the SAME shared KV, and it
  survives a ``_wire()`` rebuild (the persistent-handle contract the sibling stores hold);
* the sink is fanned out to EVERY per-source Poller (a MIRROR of the ``_event_funnel``
  fan-out pair) and re-propagated on ``rebuild()``;
* a normal poll tick RECORDS the ingested tally into the counters;
* an EVENTS-ONLY quiet tick (funnel routing on → ``new_events`` empty) still records its
  ingested volume and NEVER raises the ``UnboundLocalError`` the scope-fix guards against;
* the existing ``_event_funnel`` wiring is untouched (both hooks coexist).

Advisory only — none of this feeds ``case_manager.decide()`` (#3)."""

from __future__ import annotations

import pytest

from app.config import (
    BaselineConfig,
    BatchConfig,
    CorrelationRule,
    Secrets,
    SourceInstance,
)
from app.constants import CorrelationMode, EntityType, SourceType
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.stores.noise_counters import NoiseCounterStore
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

asyncio_mark = pytest.mark.asyncio


# --------------------------------------------------------------------------- #
# helpers (mirror test_round4_wave4_wiring)
# --------------------------------------------------------------------------- #
def _make_state() -> AppState:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )
    mp = MockProvider()
    overrides = {"anthropic": mp, "openai": mp, "mock": mp}
    return AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)


async def _set_threshold(state: AppState, n: int = 3) -> None:
    p = state.prefs.model_copy(deep=True)
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=n, window_seconds=3600, group_by=EntityType.IP
    )
    await state.update_prefs(p)


def _fed_source(sid: str, feeds: list[dict], *, primary: bool = False) -> SourceInstance:
    return SourceInstance(
        id=sid, source_type=SourceType.ELASTICSEARCH, display_name=sid,
        enabled=True, is_primary=primary, config={"index_patterns": feeds},
    )


async def _configure(state: AppState, sources: list[SourceInstance], **prefs_over) -> None:
    prefs = state.prefs.model_copy(deep=True)
    prefs.sources = sources
    for k, v in prefs_over.items():
        setattr(prefs, k, v)
    await state.update_prefs(prefs)
    state.rebuild_log_source()


def _seed(state: AppState, index: str, ip: str, n: int = 4) -> None:
    base = to_millis(now_utc()) - 60_000
    for i in range(n):
        state.es.add_log(index, make_log_event(ip=ip, ts_millis=base + i * 1000),
                         doc_id=f"{index}-{ip}-{i}")


# --------------------------------------------------------------------------- #
# 1. Store exposure + shared KV + wire-rebuild survival.
# --------------------------------------------------------------------------- #
def test_appstate_exposes_noise_counter_store_on_shared_kv() -> None:
    st = _make_state()
    assert isinstance(st.noise_counters, NoiseCounterStore)
    # Rides the SAME shared KV the Round-3/4/5 stores use — no new index/table.
    assert st.noise_counters._kv is st._kv
    assert st.noise_counters._kv is st.baseline_store._kv


@asyncio_mark
async def test_noise_store_survives_a_wire_rebuild() -> None:
    st = _make_state()
    st._wire()  # simulate a credential-change rewire
    assert isinstance(st.noise_counters, NoiseCounterStore)
    assert st.noise_counters._kv is st._kv
    await st.shutdown()


# --------------------------------------------------------------------------- #
# 2. The sink is wired onto the primary + fanned out to EVERY child (mirror of
#    the _event_funnel fan-out pair) and coexists with _event_funnel.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_noise_sink_wired_on_primary_and_coexists_with_event_funnel():
    st = _make_state()
    await st.startup(start_poller=True)
    try:
        # BOTH hooks are wired on the primary — separate attributes, neither replaced.
        assert st.poller._primary._noise_sink is not None
        assert st.poller._primary._event_funnel is not None
        # The manager holds the sink so a rebuild re-propagates it.
        assert st.poller._noise_sink is not None
    finally:
        await st.shutdown()


@asyncio_mark
async def test_noise_sink_fans_out_to_every_child(app_state: AppState):
    """MIRROR of test_poller_manager_fanout_unaffected_by_routing_wiring: with multiple
    PULL sources the sink rides EVERY per-source Poller (primary + non-primary)."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "a-logs", "10.5.0.1")
    _seed(app_state, "b-logs", "10.5.0.2")
    await _configure(app_state, [
        SourceInstance(id="a", source_type=SourceType.ELASTICSEARCH, display_name="a",
                       enabled=True, is_primary=True, config={"data_view_pattern": "a-logs*"}),
        SourceInstance(id="b", source_type=SourceType.ELASTICSEARCH, display_name="b",
                       enabled=True, config={"data_view_pattern": "b-logs*"}),
    ])
    pollers = app_state.poller._all_pollers()
    assert len(pollers) >= 2
    assert all(p._noise_sink is not None for p in pollers)
    # A fan-out poll records ingested volume from BOTH sources into the counters.
    stats = await app_state.poller.poll_once(app_state.prefs)
    assert stats["clusters"] >= 2
    w = await app_state.noise_counters.read_window(24)
    assert w["available"] is True
    assert sum(w["ingested"].values()) == 8  # 4 + 4 raw events


@asyncio_mark
async def test_noise_sink_survives_rebuild_log_source(app_state: AppState):
    """A source edit re-mints the primary via rebuild(); the sink must survive on every
    child (manager-level hook re-propagated) — mirrors the _event_funnel re-attach."""
    await _configure(app_state, [
        _fed_source("s1", [{"pattern": "x-logs*", "role": "alerts"}], primary=True),
    ])
    assert app_state.poller._primary._noise_sink is not None
    assert all(p._noise_sink is not None for p in app_state.poller._all_pollers())


# --------------------------------------------------------------------------- #
# 3. A normal poll records the ingested tally.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_normal_poll_records_ingested_counters(app_state: AppState):
    await _set_threshold(app_state, 3)
    _seed(app_state, "al-logs", "10.4.0.1", n=5)
    await _configure(app_state, [
        _fed_source("s1", [{"pattern": "al-logs*", "role": "alerts"}], primary=True),
    ])
    stats = await app_state.poller.poll_once(app_state.prefs)
    assert stats["clusters"] == 1
    w = await app_state.noise_counters.read_window(24)
    assert w["available"] is True
    assert sum(w["ingested"].values()) == 5
    # A cluster formed → the clustered band tally is non-empty too.
    assert sum(w["clustered"].values()) >= 1


# --------------------------------------------------------------------------- #
# 4. THE CRITICAL SCOPE FIX — an events-only quiet tick never UnboundLocalErrors
#    and still records its ingested volume (new_events empty, funnel_events full).
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_noise_sink_survives_events_only_quiet_tick(app_state: AppState):
    """batch + baseline enabled → an events-role feed routes to the funnel, so
    ``new_events`` is EMPTY while ``funnel_events`` is full. The poll must NOT raise
    (the scope fix) and STILL record the ingested volume for that events-only tick."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "ev-logs", "10.3.0.1", n=6)
    await _configure(
        app_state,
        [_fed_source("s1", [{"pattern": "ev-logs*", "role": "events"}], primary=True)],
        batch=BatchConfig(enabled=True),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )

    routed: list = []

    async def _spy(events, prefs):
        routed.append(len(events))

    app_state.poller._primary._event_funnel = _spy

    # This is the tick that previously crashed with UnboundLocalError on own_source.
    stats = await app_state.poller.poll_once(app_state.prefs)
    assert stats["funnel_routed"] == 6      # events routed to the funnel
    assert stats["clusters"] == 0           # realtime correlate skipped → no case
    assert routed == [6]
    # ...yet the ingested tally STILL captured the events-only volume.
    w = await app_state.noise_counters.read_window(24)
    assert w["available"] is True
    assert sum(w["ingested"].values()) == 6
    # No cluster on the realtime path → clustered band tally stays zero this tick.
    assert sum(w["clustered"].values()) == 0


# --------------------------------------------------------------------------- #
# 5. THE OVER-COUNT FIX — clustered/suppressed/ignored are per-tick deltas, not a
#    re-tally of the FULL re-scanned look-back window on every straggler tick.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_clustered_counter_is_a_per_tick_delta_not_window_rescan(app_state: AppState):
    """Round-7 over-count fix: ``correlate`` runs over the FULL sliding look-back window
    every active tick, so a burst that stays inside that window must NOT re-inflate the
    ``clustered`` band on each subsequent (straggler) tick while ``ingested`` is only the
    per-tick cursor delta (which would invert the funnel).

    Drive ``poll_once`` across TWO ticks: tick 1 ingests a 3-event burst that clusters
    (threshold n=3); tick 2 ingests ONE straggler for a DIFFERENT entity that never
    reaches threshold (so it forms NO new cluster) while the tick-1 burst is STILL inside
    the look-back window and is re-scanned. ``clustered`` must stay the tick-1 delta (before
    the fix it doubled to 2), and ``ingested`` must dominate ``clustered`` over the window."""
    await _set_threshold(app_state, 3)
    base = to_millis(now_utc()) - 60_000
    # Tick-1 burst: 3 events for the SAME IP → exactly one cluster.
    for i in range(3):
        app_state.es.add_log(
            "nx-logs", make_log_event(ip="10.9.0.1", ts_millis=base + i * 1000),
            doc_id=f"burst-{i}",
        )
    await _configure(app_state, [
        _fed_source("s1", [{"pattern": "nx-logs*", "role": "alerts"}], primary=True),
    ])

    await app_state.poller.poll_once(app_state.prefs)          # TICK 1
    w1 = await app_state.noise_counters.read_window(24)
    clustered_1 = sum(w1["clustered"].values())
    assert clustered_1 == 1                                    # the burst clustered ONCE

    # A lone straggler for a DIFFERENT IP arrives AFTER tick 1 — below threshold, so it
    # never forms its own cluster, yet the tick-1 burst (still inside the look-back window)
    # is re-scanned whole by correlate on tick 2.
    app_state.es.add_log(
        "nx-logs", make_log_event(ip="10.9.0.9", ts_millis=base + 10_000),
        doc_id="straggler-0",
    )
    await app_state.poller.poll_once(app_state.prefs)          # TICK 2
    w2 = await app_state.noise_counters.read_window(24)
    clustered_2 = sum(w2["clustered"].values())
    ingested_2 = sum(w2["ingested"].values())

    # The straggler tick did NOT re-count the re-scanned burst → clustered is a per-tick
    # delta (before the fix this would be 2). Ingested (3 burst + 1 straggler = 4) still
    # dominates clustered, so the funnel can never invert under sustained load.
    assert clustered_2 == clustered_1 == 1
    assert ingested_2 == 4
    assert ingested_2 >= clustered_2
