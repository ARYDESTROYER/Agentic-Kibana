"""Pull pagination/cursor regressions for the Bleeding Edge ingest spine.

These tests are deliberately offline.  They exercise the shared Elastic connector
used by Elasticsearch, OpenSearch and Wazuh, including the no-PIT compatibility
path.  The guarantees are at-least-once source reads plus durable idempotency, not
distributed exactly-once delivery.
"""

from __future__ import annotations

from app.config import CorrelationRule
from app.connectors.elastic import ElasticConnector
from app.constants import CorrelationMode, EntityType
from app.engine.poller import Poller
from app.es.fake import InMemoryESClient
from app.models import Cursor, make_cursor_event_key
from app.stores.cursor_store import CursorStore
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event


class TrackingES(InMemoryESClient):
    def __init__(self, *, pit: bool = True) -> None:
        super().__init__()
        self.pit = pit
        self.log_search_bodies: list[dict] = []
        self.opened = 0
        self.closed = 0

    async def open_log_pit(self, index: str, keep_alive: str = "1m") -> str | None:
        if not self.pit:
            return None
        self.opened += 1
        return await super().open_log_pit(index, keep_alive)

    async def close_log_pit(self, pit_id: str) -> None:
        self.closed += 1

    async def search_logs(self, index: str, body: dict) -> dict:
        self.log_search_bodies.append(dict(body))
        return await super().search_logs(index, body)


def _prefs(app_state, *, batch_size: int = 2):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.poll_batch_size = batch_size
    prefs.cold_start_lookback_minutes = 60
    prefs.background_scan_enabled = False
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD,
        n=3,
        window_seconds=3600,
        group_by=EntityType.IP,
    )
    return prefs


def _poller(app_state, source: ElasticConnector) -> tuple[Poller, CursorStore]:
    store = CursorStore(InMemoryESClient())
    return (
        Poller(
            app_state.es,
            app_state.cases,
            store,
            app_state._real_audit,
            app_state.pipeline,
            app_state.get_prefs,
            source=source,
        ),
        store,
    )


async def test_pit_search_after_drains_more_than_two_pages_with_one_timestamp(app_state):
    es = TrackingES()
    timestamp = to_millis(now_utc()) - 60_000
    for i in reversed(range(7)):
        es.add_log(
            "all-logs-a",
            make_log_event(ip="10.0.0.7", rule="burst", severity=8, ts_millis=timestamp),
            doc_id=f"event-{i}",
        )

    events = await ElasticConnector(es).poll(_prefs(app_state), Cursor(), timestamp - 1)

    assert [event.id for event in events] == [f"event-{i}" for i in range(7)]
    assert es.opened == es.closed == 1
    assert sum("search_after" in body for body in es.log_search_bodies) >= 2


async def test_no_pit_compatibility_path_also_drains_multiple_pages(app_state):
    es = TrackingES(pit=False)
    timestamp = to_millis(now_utc()) - 60_000
    for i in range(7):
        es.add_log(
            "all-logs-a",
            make_log_event(ip="10.0.0.8", rule="burst", severity=8, ts_millis=timestamp),
            doc_id=f"compat-{i}",
        )

    events = await ElasticConnector(es).poll(_prefs(app_state), Cursor(), timestamp - 1)

    assert len(events) == 7
    assert {event.id for event in events} == {f"compat-{i}" for i in range(7)}
    assert any(int(body.get("from", 0)) >= 4 for body in es.log_search_bodies)


async def test_boundary_retry_is_empty_then_same_timestamp_new_id_is_seen(app_state):
    es = TrackingES()
    timestamp = to_millis(now_utc()) - 60_000
    for i in range(7):
        es.add_log(
            "all-logs-a",
            make_log_event(ip="10.0.0.9", rule="same-ms", severity=8, ts_millis=timestamp),
            doc_id=f"tie-{i}",
        )
    source = ElasticConnector(es, connector_id="pull-a")
    poller, cursor_store = _poller(app_state, source)
    prefs = _prefs(app_state)

    first = await poller.poll_once(prefs)
    retry = await poller.poll_once(prefs)
    assert first["new"] == 7
    assert retry["new"] == 0

    cursor = await cursor_store.load()
    assert cursor.timestamp_millis == timestamp
    assert set(cursor.boundary_ids) == {
        make_cursor_event_key("all-logs-a", f"tie-{i}") for i in range(7)
    }

    es.add_log(
        "all-logs-a",
        make_log_event(ip="10.0.0.9", rule="same-ms", severity=8, ts_millis=timestamp),
        doc_id="tie-late",
    )
    added = await poller.poll_once(prefs)
    repeated = await poller.poll_once(prefs)
    assert added["new"] == 1
    assert repeated["new"] == 0

    cases, total = await app_state.cases.list()
    assert total == 1
    assert set(cases[0].member_event_ids) == {
        *(f"tie-{i}" for i in range(7)),
        "tie-late",
    }


async def test_index_qualified_boundary_does_not_hide_same_id_in_rollover(app_state):
    es = TrackingES()
    timestamp = to_millis(now_utc()) - 60_000
    source = ElasticConnector(es, connector_id="pull-a")
    poller, _cursor_store = _poller(app_state, source)
    prefs = _prefs(app_state)
    prefs.default_correlation.n = 2
    es.add_log(
        "all-logs-a",
        make_log_event(ip="10.0.0.10", rule="rollover", severity=8, ts_millis=timestamp),
        doc_id="shared-id",
    )
    assert (await poller.poll_once(prefs))["new"] == 1

    es.add_log(
        "all-logs-b",
        make_log_event(ip="10.0.0.10", rule="rollover", severity=8, ts_millis=timestamp),
        doc_id="shared-id",
    )
    assert (await poller.poll_once(prefs))["new"] == 1
    assert (await poller.poll_once(prefs))["new"] == 0

    cases, total = await app_state.cases.list()
    assert total == 1
    # Native ids remain query-compatible, while qualified keys preserve both
    # physical documents for count/dedup semantics.
    assert cases[0].member_event_ids == ["shared-id"]
    assert len(cases[0].member_event_keys) == 2
    assert len(set(cases[0].member_event_keys)) == 2


async def test_bounded_overlap_accepts_late_record_once_without_duplicate_case(app_state):
    es = TrackingES()
    base = to_millis(now_utc()) - 120_000
    source = ElasticConnector(es, connector_id="pull-a")
    poller, cursor_store = _poller(app_state, source)
    prefs = _prefs(app_state)
    for i in range(3):
        es.add_log(
            "all-logs-a",
            make_log_event(
                ip="10.0.0.11", rule="late-window", severity=8, ts_millis=base + i * 1000
            ),
            doc_id=f"on-time-{i}",
        )
    assert (await poller.poll_once(prefs))["new"] == 3
    assert (await cursor_store.load()).overlap_initialized is True

    # Indexed later, but event-time falls behind the durable frontier and remains
    # inside the fixed five-minute overlap.
    es.add_log(
        "all-logs-a",
        make_log_event(
            ip="10.0.0.11", rule="late-window", severity=8, ts_millis=base + 500
        ),
        doc_id="arrived-late",
    )
    late = await poller.poll_once(prefs)
    retry = await poller.poll_once(prefs)
    assert late["new"] == 1
    assert retry["new"] == 0

    cases, total = await app_state.cases.list()
    assert total == 1
    assert set(cases[0].member_event_ids) == {
        "on-time-0",
        "on-time-1",
        "on-time-2",
        "arrived-late",
    }
