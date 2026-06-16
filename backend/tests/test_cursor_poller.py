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
