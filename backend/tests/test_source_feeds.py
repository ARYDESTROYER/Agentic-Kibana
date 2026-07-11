"""Wave 6 — source MULTI-FEED (alerts / events / ignore) customization.

A single source (e.g. one ELK cluster) has SEVERAL feeds, each with its own config:
an alerts feed (every detection triaged), an all-events feed (correlate → allowlist),
and an ignore feed (muted). This suite proves:

* BACK-COMPAT: legacy ``{pattern, role, auto_correlate}`` dicts and bare strings still
  validate and yield IDENTICAL effective ``auto_investigate`` (no migration).
* IGNORE: excludes a sub-index from a broad events pattern (longest-pattern-wins) and
  DROPS its events at ingest — the ONLY role that drops.
* severity_floor: BLOCKS auto-forward but KEEPS the candidate (#4 — never dropped).
* per-feed durable cursor isolation: a fast alerts feed and a slow events feed never
  share/skip a cursor.
* effective field-mapping override precedence (global < source < feed).
* the union poll/search EXCLUDES ignore feeds.

Fully offline (in-memory fake ES, no LLM, no network).
"""

from __future__ import annotations

import pytest

from app.config import (
    CorrelationRule,
    Feed,
    IndexPattern,
    Preferences,
    SourceInstance,
    upgrade_feed,
)
from app.connectors.base import StructuredQuery
from app.connectors.elastic import ElasticConnector, FeedScan
from app.constants import CorrelationMode, EntityType, IndexRole, SourceSurface, SourceType
from app.engine.correlation import correlate
from app.engine.ingest import _is_ignored_cluster, dedup_by_id, handle_clusters
from app.engine.poller import Poller, advance_cursor_to
from app.es.fake import InMemoryESClient
from app.models import Cursor, RawEvent, make_cursor_event_key
from app.ocsf import score_to_severity_id
from app.stores.cursor_store import CursorStore
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

asyncio = pytest.mark.asyncio


# --------------------------------------------------------------------------- #
# 1. BACK-COMPAT — legacy dict + bare string validate + identical behaviour.
# --------------------------------------------------------------------------- #
def test_legacy_dict_and_bare_string_validate_and_match_effective_auto_investigate():
    """A legacy ``{pattern, role, auto_correlate}`` entry and a bare string still
    validate, and yield the SAME effective auto_investigate the engine derives."""
    s = SourceInstance(
        id="s1", source_type=SourceType.ELASTICSEARCH,
        config={"index_patterns": [
            {"pattern": "x-*", "role": "alerts", "auto_correlate": False},
            {"pattern": "y-*", "role": "events", "auto_correlate": False},
            "z-*",  # bare string -> role=events, correlate=True
        ]},
    )
    feeds = s.feeds()
    assert [f.pattern for f in feeds] == ["x-*", "y-*", "z-*"]

    by_pat = {f.pattern: f for f in feeds}
    # Legacy alias still readable.
    assert by_pat["x-*"].auto_correlate is False
    assert by_pat["x-*"].correlate is False
    # Effective auto_investigate matches the documented derivation EXACTLY:
    #   alerts-role -> True even when auto_correlate=False (every detection triaged).
    assert by_pat["x-*"].effective_auto_investigate() is True
    #   events-role + auto_correlate=False -> False (manual triage).
    assert by_pat["y-*"].effective_auto_investigate() is False
    #   bare string -> events + correlate True -> True (today's default).
    assert by_pat["z-*"].effective_auto_investigate() is True

    # Deterministic, derived ids (slug of the pattern) — stable across loads.
    assert {f.id for f in feeds} == {"x", "y", "z"}
    assert s.feeds()[0].id == "x"  # idempotent on re-load


def test_upgrade_feed_is_pure_and_behavior_preserving():
    # bare string
    assert upgrade_feed("all-logs-*") == {
        "id": "all-logs", "pattern": "all-logs-*", "role": "events",
        "enabled": True, "correlate": True, "auto_investigate": True,
    }
    # legacy {pattern, role, auto_correlate} — alerts always auto_investigates.
    assert upgrade_feed({"pattern": "siem-*", "role": "alerts", "auto_correlate": False}) == {
        "id": "siem", "pattern": "siem-*", "role": "alerts",
        "enabled": True, "correlate": False, "auto_investigate": True,
    }
    # legacy events + auto_correlate False -> auto_investigate False.
    assert upgrade_feed({"pattern": "noisy-*", "role": "events", "auto_correlate": False}) == {
        "id": "noisy", "pattern": "noisy-*", "role": "events",
        "enabled": True, "correlate": False, "auto_investigate": False,
    }
    # idempotent on an already-upgraded dict.
    once = upgrade_feed({"pattern": "noisy-*", "role": "events", "auto_correlate": False})
    assert upgrade_feed(once) == once


def test_feed_alias_is_indexpattern_and_back_compat_equality():
    assert Feed is IndexPattern
    a = IndexPattern(pattern="x-*", role=IndexRole.ALERTS)
    b = IndexPattern.model_validate({"pattern": "x-*", "role": "alerts"})
    assert a == b and a.id == "x"


def test_legacy_data_view_fallback_still_works():
    """A source with only ``data_view_pattern`` (no feeds) falls back to a single
    events feed — byte-identical to before."""
    s = SourceInstance(id="s", source_type=SourceType.ELASTICSEARCH,
                       config={"data_view_pattern": "all-logs-*"})
    feeds = s.feeds()
    assert feeds == [IndexPattern(pattern="all-logs-*", role=IndexRole.EVENTS)]
    assert feeds[0].effective_auto_investigate() is True


# --------------------------------------------------------------------------- #
# 2. IGNORE — excludes a sub-index from a broad events pattern + drops events.
# --------------------------------------------------------------------------- #
def _build_es_three_subindices() -> InMemoryESClient:
    es = InMemoryESClient()
    base = to_millis(now_utc()) - 600_000
    # broad events index
    es.add_log("logs-host-app", make_log_event(ip="10.0.0.1", rule="r", severity=6.0,
               ts_millis=base + 1000), doc_id="app1")
    # the sub-index we want IGNORED (carved out of the broad host-* pattern)
    es.add_log("logs-host-noise", make_log_event(ip="10.0.0.2", rule="r", severity=6.0,
               ts_millis=base + 2000), doc_id="noise1")
    es.add_log("logs-host-noise", make_log_event(ip="10.0.0.3", rule="r", severity=6.0,
               ts_millis=base + 3000), doc_id="noise2")
    return es


@asyncio
async def test_union_search_excludes_ignore_feed():
    """The union search reads the live feeds but NOT the ignore feed (longest-pattern
    precedence: the narrow ignore feed beats the broad events feed)."""
    es = _build_es_three_subindices()
    config = {
        "display_name": "Multi",
        "index_patterns": [
            {"pattern": "logs-host-*", "role": "events"},
            {"pattern": "logs-host-noise*", "role": "ignore"},
        ],
    }
    conn = ElasticConnector(es, config=config, connector_id="multi1")
    prefs = Preferences(setup_complete=True)

    # The effective data view is the union of NON-ignore patterns only.
    eff = conn._effective_prefs(prefs)
    assert "logs-host-noise*" not in eff.data_view_pattern
    assert "logs-host-*" in eff.data_view_pattern

    result = await conn.search(prefs, StructuredQuery(size=50, sort_desc=True))
    indices = {ev.index for ev in result.events}
    # The ignored sub-index never appears.
    assert "logs-host-noise" not in indices
    assert "logs-host-app" in indices


@asyncio
async def test_poll_excludes_ignore_feed():
    es = _build_es_three_subindices()
    config = {
        "index_patterns": [
            {"pattern": "logs-host-*", "role": "events"},
            {"pattern": "logs-host-noise*", "role": "ignore"},
        ],
    }
    conn = ElasticConnector(es, config=config, connector_id="multi1")
    events = await conn.poll(Preferences(setup_complete=True), Cursor(), 0)
    ids = {e.id for e in events}
    assert "app1" in ids
    assert "noise1" not in ids and "noise2" not in ids
    # Every polled event is attributed to a feed (the events feed here).
    assert all(e.feed_id for e in events)


def test_ignore_cluster_is_dropped_at_handle(monkeypatch):
    """A cluster whose every member belongs to an ignore feed is muted entirely —
    longest-pattern-wins, and the only role that drops (#4: never drop otherwise)."""
    prefs = Preferences()
    prefs.sources = [SourceInstance(
        id="s1", source_type=SourceType.ELASTICSEARCH,
        config={"index_patterns": [
            {"pattern": "logs-host-*", "role": "events"},
            {"pattern": "logs-host-noise*", "role": "ignore"},
        ]},
    )]
    base = 1_700_000_000_000
    # All members carry the narrow ignore feed id (longest-pattern match).
    members = [
        RawEvent(id=f"n{i}", index="logs-host-noise", source={}, timestamp_millis=base + i * 1000,
                 ip="9.9.9.9", rule="r", rule_name="r", severity=6.0,
                 source_id="s1", source_name="s1", feed_id="logs-host-noise")
        for i in range(6)
    ]
    cluster = correlate(members, prefs)[0]
    assert _is_ignored_cluster(cluster, prefs) is True

    # A mixed cluster (one events-feed member) is NOT dropped.
    mixed = members + [RawEvent(id="app1", index="logs-host-app", source={},
                                timestamp_millis=base, ip="9.9.9.9", rule="r", rule_name="r",
                                severity=6.0, source_id="s1", source_name="s1",
                                feed_id="logs-host")]
    cluster2 = correlate(mixed, prefs)[0]
    assert _is_ignored_cluster(cluster2, prefs) is False


@asyncio
async def test_ignore_cluster_skipped_in_handle_clusters(app_state):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = True
    prefs.auto_forward_allowlist = ["*"]
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=3, window_seconds=600, group_by=EntityType.IP
    )
    prefs.sources = [SourceInstance(
        id="s1", source_type=SourceType.ELASTICSEARCH,
        config={"index_patterns": [{"pattern": "logs-host-noise*", "role": "ignore"}]},
    )]
    base = 1_700_000_000_000
    members = [
        RawEvent(id=f"n{i}", index="logs-host-noise", source={}, timestamp_millis=base + i * 1000,
                 ip="9.9.9.9", rule="r", rule_name="r", severity=6.0,
                 source_id="s1", source_name="s1", feed_id="logs-host-noise")
        for i in range(4)
    ]
    clusters = correlate(members, prefs)
    stats = await handle_clusters(
        clusters, prefs, cases=app_state.cases, pipeline=app_state.pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
    )
    assert stats["ignored"] == 1
    assert stats["investigated"] == 0 and stats["candidates"] == 0
    _cases, total = await app_state.cases.list()
    assert total == 0  # nothing registered — the ignore feed dropped the events


# --------------------------------------------------------------------------- #
# 3. severity_floor — BLOCKS auto-forward but KEEPS the candidate (#4).
# --------------------------------------------------------------------------- #
@asyncio
async def test_severity_floor_blocks_autoforward_keeps_candidate():
    es = InMemoryESClient()
    base = to_millis(now_utc()) - 600_000
    # All events are BELOW a severity_floor of 5 (severity 2).
    for i in range(4):
        es.add_log("logs-events", make_log_event(ip="3.3.3.3", rule="r", severity=2.0,
                   ts_millis=base + i * 1000), doc_id=f"low{i}")
    config = {"index_patterns": [{"pattern": "logs-events*", "role": "events",
                                  "severity_floor": 5}]}
    conn = ElasticConnector(es, config=config, connector_id="s1")
    events = await conn.poll(Preferences(setup_complete=True), Cursor(), 0)
    # NEVER dropped — the events are still returned (candidate + live-tail).
    assert {e.id for e in events} == {"low0", "low1", "low2", "low3"}
    # ...but flagged ineligible for auto-forward.
    assert all(e.auto_investigate_eligible is False for e in events)


@asyncio
async def test_severity_floor_cluster_is_candidate_not_investigated(app_state):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = True
    prefs.auto_forward_allowlist = ["*"]  # everything allowlisted, so only the floor gates
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=3, window_seconds=600, group_by=EntityType.IP
    )
    prefs.sources = [SourceInstance(id="s1", source_type=SourceType.ELASTICSEARCH)]
    base = 1_700_000_000_000
    # All members below floor -> cluster.auto_investigate_eligible False.
    members = [
        RawEvent(id=f"e{i}", index="logs-events", source={}, timestamp_millis=base + i * 1000,
                 ip="3.3.3.3", rule="r", rule_name="r", severity=2.0,
                 source_id="s1", source_name="s1", feed_id="logs-events",
                 auto_investigate_eligible=False)
        for i in range(4)
    ]
    cluster = correlate(members, prefs)[0]
    assert cluster.auto_investigate_eligible is False
    stats = await handle_clusters(
        [cluster], prefs, cases=app_state.cases, pipeline=app_state.pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
    )
    # Candidate, NOT an investigation — and NOT dropped.
    assert stats["investigated"] == 0
    assert stats["candidates"] == 1
    _cases, total = await app_state.cases.list()
    assert total == 1


def test_cluster_eligible_when_any_member_at_or_above_floor():
    """A cluster with one at/above-floor member stays auto-investigate-eligible (we
    never block a cluster that contains a genuinely high-severity event)."""
    prefs = Preferences()
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=2, window_seconds=600, group_by=EntityType.IP
    )
    base = 1_700_000_000_000
    members = [
        RawEvent(id="low", index="logs-events", source={}, timestamp_millis=base,
                 ip="3.3.3.3", rule="r", rule_name="r", severity=2.0,
                 auto_investigate_eligible=False),
        RawEvent(id="high", index="logs-events", source={}, timestamp_millis=base + 1000,
                 ip="3.3.3.3", rule="r", rule_name="r", severity=9.0,
                 auto_investigate_eligible=True),
    ]
    cluster = correlate(members, prefs)[0]
    assert cluster.auto_investigate_eligible is True


# --------------------------------------------------------------------------- #
# 4. Per-feed durable cursor isolation — fast vs slow never share/skip (#4).
# --------------------------------------------------------------------------- #
@asyncio
async def test_per_feed_cursor_isolation(app_state):
    """A fast alerts feed and a slow events feed each advance their OWN cursor — one
    never drags the other forward (so a slow feed never skips its backlog)."""
    es = InMemoryESClient()
    base = to_millis(now_utc()) - 600_000
    # Fast ALERTS feed — recent events.
    for i in range(3):
        es.add_log("logs-alerts", make_log_event(ip="1.1.1.1", rule="a", severity=8.0,
                   ts_millis=base + 500_000 + i * 1000), doc_id=f"al{i}")
    # Slow EVENTS feed — OLDER events (lower timestamps).
    for i in range(3):
        es.add_log("logs-events", make_log_event(ip="2.2.2.2", rule="e", severity=8.0,
                   ts_millis=base + i * 1000), doc_id=f"ev{i}")

    config = {"index_patterns": [
        {"pattern": "logs-alerts*", "role": "alerts"},
        {"pattern": "logs-events*", "role": "events"},
    ]}
    conn = ElasticConnector(es, config=config, connector_id="srcX")
    cursor_store = CursorStore(InMemoryESClient())

    poller = Poller(
        app_state.es, app_state.cases, cursor_store, app_state._real_audit,
        app_state.pipeline, app_state.get_prefs, source=conn,
    )
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.cold_start_lookback_minutes = 60
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=3, window_seconds=3600, group_by=EntityType.IP
    )
    await poller.poll_once(prefs)

    # Each feed advanced its OWN cursor key f"{source.id}:{feed.id}".
    alerts_cursor = await cursor_store.load_keyed("srcX:logs-alerts")
    events_cursor = await cursor_store.load_keyed("srcX:logs-events")
    assert alerts_cursor.is_set() and events_cursor.is_set()
    # The fast feed's cursor is AHEAD of the slow feed's — they are independent.
    assert alerts_cursor.timestamp_millis > events_cursor.timestamp_millis
    # The primary (legacy) cursor is UNTOUCHED — no shared/global advance.
    primary = await cursor_store.load()
    assert not primary.is_set()


@asyncio
async def test_keyed_cursor_roundtrip_and_primary_isolation():
    store = CursorStore(InMemoryESClient())
    await store.save_keyed("srcA:fast", Cursor(timestamp_millis=2000, boundary_ids=["a"]))
    await store.save_keyed("srcA:slow", Cursor(timestamp_millis=1000, boundary_ids=["b"]))
    assert (await store.load_keyed("srcA:fast")).timestamp_millis == 2000
    assert (await store.load_keyed("srcA:slow")).timestamp_millis == 1000
    # The primary cursor is a DISTINCT slot, never shared with a feed cursor.
    assert not (await store.load()).is_set()
    await store.save(Cursor(timestamp_millis=9999))
    assert (await store.load()).timestamp_millis == 9999
    assert (await store.load_keyed("srcA:fast")).timestamp_millis == 2000  # unaffected


# --------------------------------------------------------------------------- #
# 5. Effective field-mapping override precedence (global < source < feed).
# --------------------------------------------------------------------------- #
@asyncio
async def test_effective_field_mapping_precedence():
    """A per-feed ``field_mapping``/``message_field`` overrides the source-level one,
    which overrides the global Preferences."""
    es = InMemoryESClient()
    base = to_millis(now_utc()) - 600_000
    # The IP lives under a NON-default path that the FEED override points at.
    es.add_log("logs-feed", {
        "@timestamp": __import__("datetime").datetime.fromtimestamp(
            (base + 1000) / 1000.0, tz=__import__("datetime").timezone.utc).isoformat(),
        "event": {"module": "r", "severity": 7.0},
        "custom": {"client_ip": "55.55.55.55"},
        "src": {"ip": "11.11.11.11"},
    }, doc_id="f1")

    config = {
        # Source-level override points at src.ip ...
        "source_ip_field": "src.ip",
        "index_patterns": [{
            "pattern": "logs-feed*", "role": "events",
            # ... but the FEED override wins and points at custom.client_ip.
            "field_mapping": {"source_ip_field": "custom.client_ip"},
        }],
    }
    conn = ElasticConnector(es, config=config, connector_id="s1")
    events = await conn.poll(Preferences(setup_complete=True), Cursor(), 0)
    assert len(events) == 1
    # The feed-level mapping won.
    assert events[0].ip == "55.55.55.55"


@asyncio
async def test_source_mapping_used_when_no_feed_override():
    es = InMemoryESClient()
    base = to_millis(now_utc()) - 600_000
    es.add_log("logs-feed", {
        "@timestamp": __import__("datetime").datetime.fromtimestamp(
            (base + 1000) / 1000.0, tz=__import__("datetime").timezone.utc).isoformat(),
        "event": {"module": "r", "severity": 7.0},
        "src": {"ip": "11.11.11.11"},
    }, doc_id="f1")
    config = {
        "source_ip_field": "src.ip",  # source-level, no feed override
        "index_patterns": [{"pattern": "logs-feed*", "role": "events"}],
    }
    conn = ElasticConnector(es, config=config, connector_id="s1")
    events = await conn.poll(Preferences(setup_complete=True), Cursor(), 0)
    assert events[0].ip == "11.11.11.11"


# --------------------------------------------------------------------------- #
# 5b. The /api/sources/{id}/feeds endpoint resolves effective feeds + dv sync.
# --------------------------------------------------------------------------- #
def test_feeds_endpoint_resolves_effective_feeds_and_syncs_data_view(client):
    body = {
        "id": "elk", "source_type": "elasticsearch", "is_primary": True,
        "config": {"index_patterns": [
            {"pattern": "all-logs-*", "role": "events", "auto_correlate": False},  # legacy
            {"pattern": "siem-*", "role": "alerts"},
            {"pattern": "noise-*", "role": "ignore"},
            "extra-*",  # bare string
        ]},
    }
    assert client.post("/api/sources", json=body).status_code == 200

    # config['data_view_pattern'] synced to the non-ignore union (excludes noise-*).
    src = {s["id"]: s for s in client.get("/api/sources").json()["sources"]}["elk"]
    dv = src["config"]["data_view_pattern"]
    assert "noise-*" not in dv
    assert "all-logs-*" in dv and "siem-*" in dv and "extra-*" in dv

    r = client.get("/api/sources/elk/feeds")
    assert r.status_code == 200
    feeds = {f["pattern"]: f for f in r.json()["feeds"]}
    # Legacy events + auto_correlate=False -> NOT auto_investigate.
    assert feeds["all-logs-*"]["role"] == "events"
    assert feeds["all-logs-*"]["correlate"] is False
    assert feeds["all-logs-*"]["auto_investigate"] is False
    # alerts always auto_investigates.
    assert feeds["siem-*"]["auto_investigate"] is True
    # ignore never auto_investigates.
    assert feeds["noise-*"]["role"] == "ignore"
    assert feeds["noise-*"]["auto_investigate"] is False
    # bare string -> events default True.
    assert feeds["extra-*"]["auto_investigate"] is True
    # data_view excludes the ignore feed.
    assert "noise-*" not in r.json()["data_view_pattern"]


def test_feeds_endpoint_404_for_unknown_source(client):
    assert client.get("/api/sources/nope/feeds").status_code == 404


# --------------------------------------------------------------------------- #
# 6. Per-feed query is applied (operator-TRUSTED connector-native filter).
# --------------------------------------------------------------------------- #
@asyncio
async def test_per_feed_query_filters_the_feed():
    es = InMemoryESClient()
    base = to_millis(now_utc()) - 600_000
    es.add_log("logs-feed", make_log_event(ip="1.1.1.1", rule="keep", severity=7.0,
               ts_millis=base + 1000), doc_id="keep1")
    es.add_log("logs-feed", make_log_event(ip="2.2.2.2", rule="drop", severity=7.0,
               ts_millis=base + 2000), doc_id="drop1")
    config = {"index_patterns": [{
        "pattern": "logs-feed*", "role": "events",
        # query_string over the rule field — only 'keep' events pass.
        "query": "event.module:keep",
    }]}
    conn = ElasticConnector(es, config=config, connector_id="s1")
    events = await conn.poll(Preferences(setup_complete=True), Cursor(), 0)
    ids = {e.id for e in events}
    assert "keep1" in ids
    assert "drop1" not in ids


# --------------------------------------------------------------------------- #
# 7. #4 NO-SKIP across overlapping feeds — the broad feed's cursor must advance
#    over EVERY hit it READ (kept + dropped), never passing over a dropped hit's
#    window, while the dropped hits are owned + processed by the narrower feed.
#    Round-2 W6 HIGH (confirmed): ROUND2_AUDIT.md "Broad feed's per-feed cursor".
# --------------------------------------------------------------------------- #
def _overlap_es(base: int) -> InMemoryESClient:
    """Broad events superset (``logs-*``) overlapping a narrow alerts subset
    (``logs-alerts*``). The OLDEST hits live in the alerts subset; the broad feed's
    OWN (events-only) hits are NEWER, sitting *beyond* a full page of alerts hits."""
    es = InMemoryESClient()
    # OLDEST: 3 alerts-subset hits (owned by the narrow alerts feed).
    for i in range(3):
        es.add_log("logs-alerts", make_log_event(ip="1.1.1.1", rule="a", severity=8.0,
                   ts_millis=base + i * 1000), doc_id=f"al{i}")
    # NEWER: 3 events-only hits (owned by the broad feed) — these must NOT be skipped.
    for i in range(3):
        es.add_log("logs-app", make_log_event(ip="2.2.2.2", rule="e", severity=8.0,
                   ts_millis=base + 100_000 + i * 1000), doc_id=f"ev{i}")
    return es


@asyncio
async def test_poll_feed_scan_watermark_covers_dropped_hits():
    """``poll_feed_scan`` for the BROAD feed reports a watermark over EVERY hit it
    READ — including the narrower-feed hits it DROPS — so the cursor can advance past
    that window. Without this, a full page owned by the narrower feed leaves ``kept``
    empty and the broad cursor never advances (#4 skip)."""
    base = to_millis(now_utc()) - 600_000
    es = _overlap_es(base)
    config = {"index_patterns": [
        {"pattern": "logs-*", "role": "events"},        # broad superset
        {"pattern": "logs-alerts*", "role": "alerts"},  # narrow subset
    ]}
    conn = ElasticConnector(es, config=config, connector_id="srcX")
    prefs = Preferences(setup_complete=True, poll_batch_size=3)  # one page = 3 oldest
    broad = next(f for f in conn.feeds() if f.pattern == "logs-*")

    # Pagination drains beyond the first all-dropped page, so the broad feed returns
    # its own newer rows in the same scan and watermarks the complete drained window.
    scan = await conn.poll_feed_scan(prefs, broad, Cursor(), 0)
    assert isinstance(scan, FeedScan)
    assert {event.id for event in scan.events} == {"ev0", "ev1", "ev2"}
    assert scan.scan_max_ts == base + 102_000
    assert set(scan.scan_boundary_ids) == {
        make_cursor_event_key("logs-app", "ev2")
    }


@asyncio
async def test_overlapping_feeds_no_skip_across_cursor_advance(app_state):
    """End-to-end #4 via the REAL poller (``poll_once``): a broad events superset
    overlapping a narrow alerts subset, batch size fitting ONE page → forces a
    multi-tick drain where the broad feed's first page is ENTIRELY alerts-owned
    (dropped). Across ticks every in-window event is covered EXACTLY once with NO gap
    between the two feeds' cursors — proven by replaying each feed against its FINAL
    cursor and asserting every owned hit is now ``should_skip`` (covered, not skipped)
    and nothing was processed twice.

    FAILS without the poller fix: the broad feed's cursor stays at 0 (stuck on the
    all-dropped alerts page) → its own ``ev*`` events are never covered (a real skip)."""
    base = to_millis(now_utc()) - 600_000
    es = _overlap_es(base)
    config = {"index_patterns": [
        {"pattern": "logs-*", "role": "events"},        # broad superset
        {"pattern": "logs-alerts*", "role": "alerts"},  # narrow subset
    ]}
    conn = ElasticConnector(es, config=config, connector_id="srcX")
    cursor_store = CursorStore(InMemoryESClient())
    poller = Poller(
        app_state.es, app_state.cases, cursor_store, app_state._real_audit,
        app_state.pipeline, app_state.get_prefs, source=conn,
    )
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.cold_start_lookback_minutes = 60
    prefs.poll_batch_size = 3   # one page per feed per tick → forces multi-tick drain
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=99, window_seconds=3600, group_by=EntityType.IP
    )

    # Drive the REAL poller until both feeds' cursors stop moving (fully drained).
    prev_keys: tuple = ()
    for _ in range(8):
        await poller.poll_once(prefs)
        keys = (
            (await cursor_store.load_keyed("srcX:logs")).timestamp_millis,
            (await cursor_store.load_keyed("srcX:logs-alerts")).timestamp_millis,
        )
        if keys == prev_keys:
            break
        prev_keys = keys

    # Each feed's cursor reached its OWN newest hit (no skip, no stall).
    broad_cursor = await cursor_store.load_keyed("srcX:logs")
    alerts_cursor = await cursor_store.load_keyed("srcX:logs-alerts")
    assert broad_cursor.timestamp_millis == base + 102_000   # newest ev hit (broad-owned)
    assert alerts_cursor.timestamp_millis == base + 2000     # newest alert hit (narrow-owned)

    # NO GAP: replay each feed from its FINAL cursor — every hit it owns is now covered
    # (``should_skip`` True), so re-polling yields zero fresh events (no skip, no dup).
    for feed in conn.feeds():
        final = await cursor_store.load_keyed(f"srcX:{feed.id}")
        scan = await conn.poll_feed_scan(prefs, feed, final, base)
        fresh = [e for e in scan.events if not final.should_skip(e)]
        assert fresh == [], f"feed {feed.id} would re-yield {[e.id for e in fresh]}"

    # Cross-check: each event is owned by exactly ONE feed (broad owns ev0..ev2, narrow
    # owns al0..al2 — no overlap, no dup). Use a wide batch so the full set is seen.
    prefs_wide = prefs.model_copy(update={"poll_batch_size": 50})
    broad_owned = {e.id for e in (await conn.poll_feed_scan(
        prefs_wide, conn.feeds()[0], Cursor(), base)).events}
    alerts_owned = {e.id for e in (await conn.poll_feed_scan(
        prefs_wide, conn.feeds()[1], Cursor(), base)).events}
    assert broad_owned == {"ev0", "ev1", "ev2"}
    assert alerts_owned == {"al0", "al1", "al2"}
    assert broad_owned.isdisjoint(alerts_owned)              # each event owned by ONE feed
    assert broad_owned | alerts_owned == {"al0", "al1", "al2", "ev0", "ev1", "ev2"}


def test_advance_cursor_to_no_dup_tiebreaker_and_no_rewind():
    """Unit guard for the watermark advance: same-millisecond ids are UNIONED with the
    existing boundary (no re-process of a tie = no dup), and a watermark at/behind the
    cursor never rewinds it (no skip backwards)."""
    # Tie at the same ms → boundary unions, never drops the prior id.
    c = Cursor(timestamp_millis=1000, boundary_ids=["a"])
    out = advance_cursor_to(c, 1000, ["b"])
    assert out.timestamp_millis == 1000
    assert set(out.boundary_ids) == {"a", "b"}
    # Forward watermark replaces the boundary with the new tie set.
    out = advance_cursor_to(c, 2000, ["x", "y"])
    assert out.timestamp_millis == 2000 and out.boundary_ids == ["x", "y"]
    # Behind / empty watermark → unchanged (no rewind, no spurious advance).
    assert advance_cursor_to(c, 500, ["z"]) is c
    assert advance_cursor_to(c, 0, []) is c


@asyncio
async def test_broad_feed_cursor_not_stuck_when_full_page_owned_by_narrower(app_state):
    """Regression for the EXACT confirmed bug: a full first page entirely owned by a
    narrower feed previously left the broad feed's cursor unadvanced (kept empty →
    ``advance_cursor`` no-op), starving its own newer events forever. The watermark
    advance moves the cursor past the alerts page on the FIRST tick."""
    base = to_millis(now_utc()) - 600_000
    es = _overlap_es(base)
    config = {"index_patterns": [
        {"pattern": "logs-*", "role": "events"},
        {"pattern": "logs-alerts*", "role": "alerts"},
    ]}
    conn = ElasticConnector(es, config=config, connector_id="srcX")
    cursor_store = CursorStore(InMemoryESClient())
    poller = Poller(
        app_state.es, app_state.cases, cursor_store, app_state._real_audit,
        app_state.pipeline, app_state.get_prefs, source=conn,
    )
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.cold_start_lookback_minutes = 60
    prefs.poll_batch_size = 3
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=99, window_seconds=3600, group_by=EntityType.IP
    )

    await poller.poll_once(prefs)
    broad_cursor = await cursor_store.load_keyed("srcX:logs")
    # The paginated scan advances through the all-dropped first page and reaches
    # the broad feed's own newest event in the same tick.
    assert broad_cursor.is_set()
    assert broad_cursor.timestamp_millis == base + 102_000

    # Subsequent ticks remain monotonic and do not replay the drained pages.
    prev = broad_cursor.timestamp_millis
    for _ in range(5):
        await poller.poll_once(prefs)
        cur = (await cursor_store.load_keyed("srcX:logs")).timestamp_millis
        assert cur >= prev  # monotonic forward, never rewinds / re-stalls
        prev = cur
    assert prev == base + 102_000  # reached its OWN newest event — nothing skipped


# --------------------------------------------------------------------------- #
# 8. severity_floor compares OCSF severity_id (1-6), NOT the raw source severity.
#    Round-2 W6 LOW (confirmed): ROUND2_AUDIT.md "Per-feed severity_floor units".
# --------------------------------------------------------------------------- #
@asyncio
async def test_severity_floor_compares_ocsf_severity_id_not_raw():
    """The floor is OCSF severity_id (1-6). The DISCRIMINATING case is a raw severity
    on the 0..10 SIEM scale whose numeric value sits at/above the floor but whose OCSF
    severity_id is BELOW it: raw ``5.0`` (0..10) → OCSF id 3 (Medium). Against a floor
    of 4 the OLD raw compare (``5.0 < 4`` → False) wrongly judged it ELIGIBLE, while the
    OCSF compare (``3 < 4`` → True) correctly BLOCKS auto-forward. The event is NEVER
    dropped either way (#4) — only its ``auto_investigate_eligible`` flag differs.

    This test FAILS under the old raw compare (it would see ``high5`` eligible)."""
    es = InMemoryESClient()
    base = to_millis(now_utc()) - 600_000
    # raw 5.0 (0..10 scale) -> OCSF id 3 (Medium) -> BELOW floor 4 -> must be BLOCKED.
    # (old raw compare: 5.0 < 4 is False -> wrongly eligible.)
    es.add_log("logs-sev", make_log_event(ip="1.1.1.1", rule="r", severity=5.0,
               ts_millis=base + 1000), doc_id="mid5")
    # raw 70 (0..100 scale) -> OCSF id 4 (High) -> CLEARS floor 4 -> ELIGIBLE.
    es.add_log("logs-sev", make_log_event(ip="2.2.2.2", rule="r", severity=70.0,
               ts_millis=base + 2000), doc_id="high70")
    config = {"index_patterns": [{"pattern": "logs-sev*", "role": "events",
                                  "severity_floor": 4}]}
    conn = ElasticConnector(es, config=config, connector_id="s1")
    events = await conn.poll(Preferences(setup_complete=True), Cursor(), 0)
    by_id = {e.id: e for e in events}

    # NEVER dropped — both events are returned regardless of the floor (#4).
    assert set(by_id) == {"mid5", "high70"}
    # Sanity: the OCSF mapping is what the floor compares against.
    assert score_to_severity_id(5.0) == 3 and score_to_severity_id(70.0) == 4
    # Medium(3) < floor 4 -> BLOCKED (the bug fix); High(4) >= floor 4 -> ELIGIBLE.
    assert by_id["mid5"].auto_investigate_eligible is False
    assert by_id["high70"].auto_investigate_eligible is True


def test_severity_floor_raw_compare_would_misclassify():
    """Pins the unit the fix corrects: a raw 0..10 severity of ``5.0`` is OCSF
    severity_id 3 (Medium). Against a floor of 4 the OLD raw compare and the OCSF
    compare DISAGREE — the old code would NOT block it (5.0 >= 4), the fix DOES
    (OCSF id 3 < 4). This guards the semantics independent of the poll wiring."""
    floor = 4
    # The fix: compare the OCSF severity_id.
    assert score_to_severity_id(5.0) == 3
    assert score_to_severity_id(5.0) < floor          # OCSF compare -> BLOCKED (correct)
    # The OLD raw compare disagreed (5.0 is numerically >= 4 -> wrongly eligible).
    assert not (5.0 < float(floor))
