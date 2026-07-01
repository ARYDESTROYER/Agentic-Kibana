"""Round 4 / Wave 4 — runtime wiring: gated schedulers + EVENT-feed routing (offline).

Wave 4 turns the Wave-3 engines/stores from inert plumbing into DRIVEN runtime, WITHOUT
changing default behaviour. Two seams are wired into ``AppState`` + the ``Poller``:

  1. GATED SCHEDULERS — three background asyncio tasks modelled on the poller lifecycle
     (a nightly threshold-tuner pass, a daily campaign-correlation pass, a batch-jobs
     poller loop). All default-OFF: each loop is a NO-OP until its
     ``Preferences.{threshold_tuning,campaign,batch}`` block is enabled. Started under the
     same ``start_poller`` guard the poller uses; cancelled cleanly on shutdown. Demo mode
     keeps ALL real schedulers OFF.

  2. EVENT-FEED ROUTING — when a feed's ``role == 'events'`` AND batch + event-detection
     (baseline) are BOTH enabled, that feed's events route to the detection funnel
     (aggregate→rules→anomaly→batched detection) INSTEAD OF the realtime correlation-window
     read. ALERTS feeds are unchanged. When disabled → the EXISTING realtime path is
     byte-identical (the critical safety property: default OFF = no change).

The invariants under test:
  * with all toggles OFF, startup/shutdown + a poll tick are byte-identical to today (no
    scheduler runs; EVENT feeds still go the realtime path; the poller_manager is
    unaffected);
  * with tuner/campaign/batch enabled the schedulers start and are cancelled cleanly on
    shutdown;
  * with batch + detection enabled an ``events``-role feed routes to the funnel (the
    funnel hook is invoked and the realtime read is SKIPPED for that feed), while an
    ``alerts``-role feed stays on the realtime path;
  * demo mode keeps all real schedulers OFF (the shared gate).

Network-free (the autouse conftest guard blocks non-loopback egress); the funnel hook +
batch submit are patched so nothing touches the network / an LLM.
"""

from __future__ import annotations

import asyncio

import pytest

from app.config import (
    BaselineConfig,
    BatchConfig,
    CampaignConfig,
    CorrelationRule,
    Secrets,
    SourceInstance,
    ThresholdTuningConfig,
)
from app.constants import CorrelationMode, EntityType, SourceType
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

asyncio_mark = pytest.mark.asyncio


# --------------------------------------------------------------------------- #
# helpers
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
    """A PULL Elasticsearch source with explicit per-feed ``index_patterns`` (roles)."""
    return SourceInstance(
        id=sid, source_type=SourceType.ELASTICSEARCH, display_name=sid,
        enabled=True, is_primary=primary,
        config={"index_patterns": feeds},
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
# 1. ALL TOGGLES OFF — byte-identical boot + poll tick + clean shutdown.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_all_toggles_off_boot_is_byte_identical():
    """A fresh boot with every Round-4 feature OFF spawns the schedulers (they start,
    they immediately sleep) but the poller stays the unchanged PollerManager, the funnel
    hook is wired-but-idle, and shutdown cancels everything cleanly."""
    state = _make_state()
    await state.startup(start_poller=True)
    try:
        # The schedulers were started under start_poller...
        assert state._scheduler_running is True
        assert len(state._scheduler_tasks) == 3
        assert all(not t.done() for t in state._scheduler_tasks)
        # ...but every feature is OFF by default, so a tick would NO-OP.
        assert state.prefs.threshold_tuning.enabled is False
        assert state.prefs.campaign.enabled is False
        assert state.prefs.batch.enabled is False
        # The poller is the unchanged PollerManager; the funnel hook is wired (idle).
        from app.engine.poller_manager import PollerManager
        assert isinstance(state.poller, PollerManager)
        assert state.poller._primary._event_funnel is not None
    finally:
        await state.shutdown()
    # Shutdown cancelled + drained the scheduler tasks (clean).
    assert state._scheduler_running is False
    assert state._scheduler_tasks == []


@asyncio_mark
async def test_events_feed_takes_realtime_path_when_detection_off(app_state: AppState):
    """With batch/detection OFF (the default), a ``role=events`` feed's events flow the
    EXISTING realtime correlate path — the funnel is NEVER invoked (byte-identical)."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "ev-logs", "10.9.0.1", n=4)
    await _configure(app_state, [
        _fed_source("s1", [{"pattern": "ev-logs*", "role": "events"}], primary=True),
    ])

    called: list = []

    async def _spy(events, prefs):
        called.append(len(events))

    app_state.poller._primary._event_funnel = _spy

    stats = await app_state.poller.poll_once(app_state.prefs)
    # Realtime path handled the events → a case formed; the funnel was NOT called.
    assert stats["new"] == 4
    assert stats["clusters"] == 1
    assert stats.get("funnel_routed", 0) == 0
    assert called == []
    _cases, total = await app_state.cases.list()
    assert total == 1


# --------------------------------------------------------------------------- #
# 2. SCHEDULERS ENABLED — start + cancel cleanly on shutdown.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_schedulers_start_and_stop_cleanly_when_enabled():
    state = _make_state()
    # Enable all three schedulers BEFORE startup so they are live from the first tick.
    await state.startup(start_poller=False)  # load prefs first
    prefs = state.prefs.model_copy(deep=True)
    prefs.setup_complete = True
    prefs.threshold_tuning = ThresholdTuningConfig(enabled=True)
    prefs.campaign = CampaignConfig(enabled=True)
    prefs.batch = BatchConfig(enabled=True)
    await state.update_prefs(prefs)
    # Start the schedulers explicitly (startup with start_poller=False skipped them).
    await state._run_schedulers()
    try:
        assert state._scheduler_running is True
        tasks = list(state._scheduler_tasks)
        assert len(tasks) == 3
        # Give the loops a moment to run at least one guarded tick (no crash).
        await asyncio.sleep(0)
        assert all(not t.done() for t in tasks)
    finally:
        await state.shutdown()
    # All three were cancelled + drained.
    assert state._scheduler_running is False
    assert all(t.cancelled() or t.done() for t in tasks)


@asyncio_mark
async def test_run_schedulers_is_idempotent():
    state = _make_state()
    await state.startup(start_poller=True)
    try:
        first = list(state._scheduler_tasks)
        await state._run_schedulers()  # second call is a no-op (already running)
        assert state._scheduler_tasks == first
        assert len(state._scheduler_tasks) == 3
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# 3. EVENT-FEED ROUTING — events→funnel, alerts→realtime, cursor still advances.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_events_feed_routes_to_funnel_when_enabled(app_state: AppState):
    """batch + baseline enabled → an ``events``-role feed routes to the funnel hook and
    the realtime correlate read is SKIPPED for that feed (no case from it)."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "ev-logs", "10.8.0.1", n=5)
    await _configure(
        app_state,
        [_fed_source("s1", [{"pattern": "ev-logs*", "role": "events"}], primary=True)],
        batch=BatchConfig(enabled=True),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )

    routed: list = []

    async def _spy(events, prefs):
        routed.append([e.id for e in events])

    app_state.poller._primary._event_funnel = _spy

    stats = await app_state.poller.poll_once(app_state.prefs)
    # The funnel was invoked with the events feed's new events...
    assert len(routed) == 1
    assert len(routed[0]) == 5
    assert stats["funnel_routed"] == 5
    # ...and the realtime read was SKIPPED for that feed → NO case was correlated.
    assert stats["clusters"] == 0
    _cases, total = await app_state.cases.list()
    assert total == 0
    # #4: the feed's durable cursor STILL advanced (never re-read on the next poll).
    stats2 = await app_state.poller.poll_once(app_state.prefs)
    assert stats2["funnel_routed"] == 0  # nothing new to route


@asyncio_mark
async def test_alerts_feed_stays_on_realtime_path_when_detection_on(app_state: AppState):
    """Even with batch + detection ON, an ``alerts``-role feed is UNCHANGED — it stays on
    the realtime path (alerts auto-forward), and the funnel is NOT called for it."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "al-logs", "10.7.0.1", n=4)
    await _configure(
        app_state,
        [_fed_source("s1", [{"pattern": "al-logs*", "role": "alerts"}], primary=True)],
        batch=BatchConfig(enabled=True),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )

    called: list = []

    async def _spy(events, prefs):
        called.append(len(events))

    app_state.poller._primary._event_funnel = _spy

    stats = await app_state.poller.poll_once(app_state.prefs)
    # Alerts feed → realtime path (a case forms); the funnel is untouched.
    assert stats.get("funnel_routed", 0) == 0
    assert called == []
    assert stats["clusters"] == 1


@asyncio_mark
async def test_mixed_feeds_split_events_to_funnel_alerts_to_realtime(app_state: AppState):
    """A source with BOTH an events feed and an alerts feed splits: events → funnel,
    alerts → realtime, in the SAME poll tick."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "mix-events", "10.6.0.1", n=4)
    _seed(app_state, "mix-alerts", "10.6.0.2", n=4)
    await _configure(
        app_state,
        [_fed_source("s1", [
            {"pattern": "mix-events*", "role": "events"},
            {"pattern": "mix-alerts*", "role": "alerts"},
        ], primary=True)],
        batch=BatchConfig(enabled=True),
        baseline=BaselineConfig(enabled=True, seasonality="none", warmup_multiplier=1),
    )

    routed: list = []

    async def _spy(events, prefs):
        routed.extend(e.ip for e in events)

    app_state.poller._primary._event_funnel = _spy

    stats = await app_state.poller.poll_once(app_state.prefs)
    # Only the events-feed IP was routed to the funnel...
    assert set(routed) == {"10.6.0.1"}
    assert stats["funnel_routed"] == 4
    # ...and the alerts feed produced a case on the realtime path.
    assert stats["clusters"] == 1
    cases, total = await app_state.cases.list()
    assert total == 1
    assert cases[0].entity.value == "10.6.0.2"


# --------------------------------------------------------------------------- #
# 4. DEMO MODE keeps every REAL scheduler OFF (the shared gate).
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_demo_mode_gates_all_real_schedulers_off():
    state = _make_state()
    await state.startup(start_poller=False)
    prefs = state.prefs.model_copy(deep=True)
    prefs.setup_complete = True
    prefs.threshold_tuning = ThresholdTuningConfig(enabled=True)
    prefs.campaign = CampaignConfig(enabled=True)
    prefs.batch = BatchConfig(enabled=True)
    await state.update_prefs(prefs)
    try:
        # Engage demo mode: the shared scheduler gate must now return "gated off".
        await state.enable_demo(mode="seeded")
        assert state.demo_active is True
        assert state._schedulers_gated_off() is True
        # And the poller's own event routing never runs against demo (the run loop gates
        # demo before the funnel; the gate helper reflects that here).
    finally:
        await state.shutdown()


@asyncio_mark
async def test_schedulers_gated_off_when_polling_paused_or_kill_switch():
    state = _make_state()
    await state.startup(start_poller=False)
    try:
        # setup incomplete → gated off.
        assert state._schedulers_gated_off() is True
        # setup complete, polling on, no kill-switch → NOT gated.
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.polling_enabled = True
        await state.update_prefs(prefs)
        assert state._schedulers_gated_off() is False
        # kill-switch on → gated off again.
        prefs2 = state.prefs.model_copy(deep=True)
        prefs2.caps = prefs2.caps.model_copy(update={"kill_switch": True})
        await state.update_prefs(prefs2)
        assert state._schedulers_gated_off() is True
    finally:
        await state.shutdown()


# --------------------------------------------------------------------------- #
# 5. poller_manager fan-out is unaffected — routing lives per-Poller.
# --------------------------------------------------------------------------- #
@asyncio_mark
async def test_poller_manager_fanout_unaffected_by_routing_wiring(app_state: AppState):
    """The funnel hook rides the PRIMARY child (state-wired). With detection OFF the
    poller_manager fan-out across multiple sources is byte-identical — both sources still
    form their cases, unaffected by the new wiring."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "a-logs", "10.5.0.1")
    _seed(app_state, "b-logs", "10.5.0.2")
    await _configure(app_state, [
        SourceInstance(id="a", source_type=SourceType.ELASTICSEARCH, display_name="a",
                       enabled=True, is_primary=True, config={"data_view_pattern": "a-logs*"}),
        SourceInstance(id="b", source_type=SourceType.ELASTICSEARCH, display_name="b",
                       enabled=True, config={"data_view_pattern": "b-logs*"}),
    ])
    # The primary child carries the state-wired hook; the fan-out is untouched.
    assert app_state.poller._primary._event_funnel is not None
    stats = await app_state.poller.poll_once(app_state.prefs)
    assert stats["clusters"] >= 2
    _cases, total = await app_state.cases.list()
    assert total == 2
