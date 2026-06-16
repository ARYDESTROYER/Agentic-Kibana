"""Cursor durability + polling idempotency (Section 6.1 / Non-negotiable #4).

Proves the two subtle correctness points: a restart neither skips events nor
re-processes them, and re-polling never creates duplicate cases.
"""

from __future__ import annotations

from app.config import CorrelationRule
from app.constants import CorrelationMode, EntityType
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event, seed_logs


async def _set_threshold(state: AppState, n: int = 3) -> None:
    p = state.prefs.model_copy(deep=True)
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=n, window_seconds=3600, group_by=EntityType.IP
    )
    await state.update_prefs(p)


async def test_poll_registers_candidate_and_is_idempotent(app_state: AppState):
    await _set_threshold(app_state, 3)
    base = to_millis(now_utc()) - 60_000
    seed_logs(app_state.es, [make_log_event(ip="5.5.5.5", ts_millis=base + i * 1000) for i in range(4)])

    s1 = await app_state.poller.poll_once(app_state.prefs)
    assert s1["new"] == 4
    assert s1["clusters"] == 1
    _cases, total = await app_state.cases.list()
    assert total == 1

    # Re-poll the SAME window: boundary dedup + signature idempotency => no dup case.
    await app_state.poller.poll_once(app_state.prefs)
    _cases2, total2 = await app_state.cases.list()
    assert total2 == 1


async def test_no_event_skipped_after_first_poll(app_state: AppState):
    await _set_threshold(app_state, 3)
    base = to_millis(now_utc()) - 120_000
    seed_logs(app_state.es, [make_log_event(ip="6.6.6.6", ts_millis=base + i * 1000) for i in range(3)])
    await app_state.poller.poll_once(app_state.prefs)

    later = to_millis(now_utc())
    seed_logs(
        app_state.es,
        [make_log_event(ip="7.7.7.7", ts_millis=later + i * 1000) for i in range(3)],
        index="all-logs-2026.06.17",
    )
    s = await app_state.poller.poll_once(app_state.prefs)
    assert s["new"] == 3  # the newer events were NOT skipped
    _cases, total = await app_state.cases.list()
    assert total == 2


async def _set_burst_rule(state: AppState, *, n: int, window_seconds: int, poll_interval: int) -> None:
    """Threshold rule whose window spans MANY poll intervals (the BUG-5 setup)."""
    p = state.prefs.model_copy(deep=True)
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=n, window_seconds=window_seconds,
        group_by=EntityType.IP,
    )
    p.poll_interval_seconds = poll_interval
    await state.update_prefs(p)


async def test_realtime_burst_triggers_across_multiple_polls(app_state: AppState):
    """BUG-5: a burst spread over > poll_interval but < window_seconds must still
    trigger, even though it arrives as several small (below-threshold) batches.

    n=5, window=120s, poll_interval=10s. We seed 6 events ~10s apart (~60s span)
    and poll between each seed, so each poll's INCREMENTAL batch sees only 1 new
    event — never reaching n=5 in a single batch (the old per-batch correlation
    would NEVER fire). The windowed correlation sees the whole burst → one case.
    """
    await _set_burst_rule(app_state, n=5, window_seconds=120, poll_interval=10)
    now = to_millis(now_utc())
    # 6 events at now-60s, now-50s, ... now-10s: all inside the 120s window AND the
    # default 60-min cold-start look-back, but spread over 6 poll intervals.
    burst_ts = [now - (60 - i * 10) * 1000 for i in range(6)]

    max_new_in_any_batch = 0
    for ts in burst_ts:
        seed_logs(app_state.es, [make_log_event(ip="9.9.9.9", ts_millis=ts)])
        s = await app_state.poller.poll_once(app_state.prefs)
        max_new_in_any_batch = max(max_new_in_any_batch, s["new"])

    # Each poll's incremental batch stayed BELOW threshold (proves the old
    # per-batch logic could never have fired) ...
    assert max_new_in_any_batch < 5
    # ... yet the windowed correlation produced exactly one case for the burst.
    cases, total = await app_state.cases.list()
    assert total == 1, f"expected 1 burst case, got {total}"
    assert cases[0].entity.value == "9.9.9.9"
    assert len(cases[0].member_event_ids) == 6  # all 6 burst events attached, none dropped


async def test_realtime_burst_no_duplicate_across_overlapping_windows(app_state: AppState):
    """The wider, OVERLAPPING look-back window must NOT create a 2nd case for the
    same burst, nor re-investigate on every poll: signature idempotency + the
    incremental cursor keep it to exactly one case that only grows when new events
    actually arrive."""
    await _set_burst_rule(app_state, n=5, window_seconds=120, poll_interval=10)
    now = to_millis(now_utc())
    burst_ts = [now - (60 - i * 10) * 1000 for i in range(6)]
    for ts in burst_ts:
        seed_logs(app_state.es, [make_log_event(ip="4.4.4.4", ts_millis=ts)])
        await app_state.poller.poll_once(app_state.prefs)

    _c1, total_after_burst = await app_state.cases.list()
    assert total_after_burst == 1

    # Poll several MORE times with no new events: the overlapping window re-sees the
    # same burst every time but creates no duplicate (find_open_by_signature) and
    # does not re-investigate (attach is a no-op when nothing new).
    for _ in range(4):
        s = await app_state.poller.poll_once(app_state.prefs)
        assert s["new"] == 0           # cursor: nothing new is re-processed
        assert s["investigated"] == 0  # no re-investigation on a stale window
    _c2, total_after_idle = await app_state.cases.list()
    assert total_after_idle == 1, "overlapping windows must not duplicate the case"

    # A genuinely NEW event for the same entity attaches to the SAME case (no dup),
    # and the cursor still advances (the new event is counted as new exactly once).
    seed_logs(app_state.es, [make_log_event(ip="4.4.4.4", ts_millis=now)])
    s_new = await app_state.poller.poll_once(app_state.prefs)
    assert s_new["new"] == 1
    cases, total = await app_state.cases.list()
    assert total == 1
    assert len(cases[0].member_event_ids) == 7  # 6 + 1, attached not duplicated


async def test_cursor_durable_across_restart(app_state: AppState, secrets, mock_provider):
    await _set_threshold(app_state, 3)
    base = to_millis(now_utc()) - 60_000
    seed_logs(app_state.es, [make_log_event(ip="8.8.8.8", ts_millis=base + i * 1000) for i in range(3)])
    await app_state.poller.poll_once(app_state.prefs)
    _cases, total = await app_state.cases.list()
    assert total == 1

    # "Restart": a fresh AppState over the SAME in-memory ES (cursor persisted there).
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}
    state2 = AppState.create(secrets=secrets, es=app_state.es, provider_overrides=overrides)
    await state2.startup(start_poller=False)
    try:
        s = await state2.poller.poll_once(state2.prefs)
        assert s["new"] == 0  # durable cursor => nothing re-processed
        _c2, total2 = await state2.cases.list()
        assert total2 == 1
    finally:
        await state2.shutdown()
