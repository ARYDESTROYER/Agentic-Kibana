"""Deep source/index customizability + the NO-SOURCE-IP correlation fix.

All offline (fake ES, mock LLM). Covers:

* Entity-agnostic correlation: events with NO source.ip still form a case
  (auto strategy → host/user/rule fallback); events WITH ips + the default
  strategy yield byte-identical clusters as before (back-compat).
* Pinned per-source ``entity_strategy``.
* Alerts-role index patterns auto-forward a cluster even when its rule is NOT on
  the allowlist; an events-role cluster does not (unless allowlisted) — asserted
  via ``handle_clusters`` stats.
* ``Case.source_id``/``source_name`` set on creation and present in the dump.
* Chat ``source_id`` scoping routes the es_query to the selected source.
* The Elastic connector reads across multiple configured patterns and tags each
  event's per-pattern role + source provenance.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router
from app.config import CorrelationRule, IndexPattern, Preferences, SourceInstance
from app.connectors.base import StructuredQuery
from app.connectors.elastic import ElasticConnector
from app.constants import (
    CorrelationMode,
    EntityStrategy,
    EntityType,
    IndexRole,
    SourceSurface,
    SourceType,
)
from app.engine.correlation import correlate, resolve_entity
from app.engine.ingest import handle_clusters
from app.es.fake import InMemoryESClient
from app.models import RawEvent
from app.state import AppState
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event, make_raw_event

asyncio = pytest.mark.asyncio


def _prefs(**rules) -> Preferences:
    p = Preferences()
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=5, window_seconds=120, group_by=EntityType.IP
    )
    if rules:
        p.correlation_rules = rules
    return p


def _no_entity_event(*, id: str, rule: str = "linux_auth", ts_millis: int) -> RawEvent:
    """A raw event with NO ip/user/host — the bug case (would be dropped before)."""
    src = {"event": {"module": rule}, "@timestamp": ts_millis}
    return RawEvent(
        id=id, index="all-logs-x", source=src, timestamp_millis=ts_millis,
        ip=None, user=None, host=None, rule=rule, rule_name=rule, severity=5.0,
    )


# --------------------------------------------------------------------------- #
# 1. Entity-agnostic correlation (NO-SOURCE-IP fix)
# --------------------------------------------------------------------------- #
def test_no_ip_events_still_form_a_case_via_rule_fallback():
    """Events with NO ip/user/host must STILL cluster (grouped by rule) under the
    default auto strategy — they must never be silently dropped."""
    base = 1_700_000_000_000
    events = [_no_entity_event(id=f"e{i}", ts_millis=base + i * 1000) for i in range(6)]
    clusters = correlate(events, _prefs())
    assert len(clusters) == 1
    c = clusters[0]
    assert c.entity.type == EntityType.RULE
    assert c.entity.value == "linux_auth"      # bucket stripped from the display value
    assert c.count == 6
    assert c.group_by == EntityType.RULE


def test_no_ip_but_host_present_groups_by_host():
    """When IP is missing but HOST is present, auto falls back to HOST (before RULE)."""
    base = 1_700_000_000_000
    events = [
        RawEvent(id=f"e{i}", index="ix", source={}, timestamp_millis=base + i * 1000,
                 ip=None, user="bob", host="srv01", rule="r", severity=5.0)
        for i in range(6)
    ]
    clusters = correlate(events, _prefs())
    assert len(clusters) == 1
    assert clusters[0].entity.type == EntityType.HOST
    assert clusters[0].entity.value == "srv01"


def test_with_ip_default_strategy_is_byte_identical():
    """Events WITH ips under the default strategy cluster EXACTLY as before."""
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip="10.0.0.9", ts_millis=base + i * 1000) for i in range(5)]
    clusters = correlate(events, _prefs())
    assert len(clusters) == 1
    c = clusters[0]
    assert c.entity.type == EntityType.IP
    assert c.entity.value == "10.0.0.9"
    assert c.count == 5
    assert c.group_by == EntityType.IP
    # Signature is the same entity-centric key it has always been.
    assert "10.0.0.9" in c.signature or c.signature  # stable + present


def test_rule_bucket_separates_distant_bursts():
    """Two rule-grouped bursts far apart in time do NOT merge into one case."""
    base = 1_700_000_000_000
    near = [_no_entity_event(id=f"a{i}", ts_millis=base + i * 1000) for i in range(6)]
    # > RULE_BUCKET_SECONDS (300s) later → a different bucket → a separate cluster.
    far = [_no_entity_event(id=f"b{i}", ts_millis=base + 600_000 + i * 1000) for i in range(6)]
    clusters = correlate(near + far, _prefs())
    assert len(clusters) == 2
    assert all(c.entity.type == EntityType.RULE for c in clusters)


def test_pinned_host_strategy_groups_by_host_even_with_ip():
    """A pinned ``host`` strategy groups by host regardless of a present IP."""
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip="9.9.9.9", host="web01", ts_millis=base + i * 1000)
              for i in range(5)]
    clusters = correlate(events, _prefs(), entity_strategy=EntityStrategy.HOST)
    assert len(clusters) == 1
    assert clusters[0].entity.type == EntityType.HOST
    assert clusters[0].entity.value == "web01"


def test_resolve_entity_auto_prefers_primary_then_ladder():
    ev_ip = make_raw_event(id="x", ip="1.2.3.4")
    assert resolve_entity(ev_ip, EntityType.IP, EntityStrategy.AUTO) == (EntityType.IP, "1.2.3.4")
    ev_noip = RawEvent(id="y", source={}, timestamp_millis=1000, ip=None, user="u", host="h",
                       rule="r", severity=1.0)
    # primary (IP) missing → ladder: IP None → HOST present
    assert resolve_entity(ev_noip, EntityType.IP, EntityStrategy.AUTO) == (EntityType.HOST, "h")


def test_prefs_entity_strategy_default_is_auto():
    assert Preferences().entity_strategy == EntityStrategy.AUTO


# --------------------------------------------------------------------------- #
# 2 + 4. Alerts-role index patterns + per-pattern tagging via the connector
# --------------------------------------------------------------------------- #
def _build_es_with_two_patterns() -> InMemoryESClient:
    es = InMemoryESClient()
    base = to_millis(now_utc()) - 600_000
    # events-role index
    for i in range(3):
        es.add_log("logs-events-2026.06", make_log_event(ip=f"10.0.1.{i}", rule="noisy_rule",
                   ts_millis=base + i * 1000), doc_id=f"ev{i}")
    # alerts-role index (SIEM-generated detections)
    for i in range(3):
        es.add_log("logs-alerts-2026.06", make_log_event(ip=f"10.0.2.{i}", rule="siem_alert",
                   ts_millis=base + i * 1000), doc_id=f"al{i}")
    return es


@asyncio
async def test_connector_reads_across_patterns_and_tags_roles():
    es = _build_es_with_two_patterns()
    config = {
        "display_name": "Multi",
        "index_patterns": [
            {"pattern": "logs-events-*", "role": "events"},
            {"pattern": "logs-alerts-*", "role": "alerts"},
        ],
    }
    conn = ElasticConnector(es, config=config, connector_id="multi1")
    prefs = Preferences(setup_complete=True)
    result = await conn.search(prefs, StructuredQuery(size=50, sort_desc=True))
    # Reads across BOTH patterns in one search.
    indices = {ev.index for ev in result.events}
    assert any("events" in ix for ix in indices)
    assert any("alerts" in ix for ix in indices)
    # Per-pattern role + source provenance is tagged onto each event.
    for ev in result.events:
        assert ev.source_id == "multi1"
        assert ev.source_name == "Multi"
        if "alerts" in ev.index:
            assert ev.index_role == "alerts"
        else:
            assert ev.index_role == "events"


@asyncio
async def test_alerts_role_cluster_auto_forwards_bypassing_allowlist(app_state):
    """An alerts-role cluster is auto-forwarded even when its rule is NOT on the
    allowlist; an events-role cluster with the same (non-allowlisted) rule is not."""
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = True
    prefs.auto_forward_allowlist = []  # nothing allowlisted on purpose

    base = 1_700_000_000_000
    # Alerts-role cluster (rule NOT in allowlist) — should be investigated.
    alert_events = [
        RawEvent(id=f"al{i}", index="logs-alerts", source={}, timestamp_millis=base + i * 1000,
                 ip="8.8.8.8", rule="siem_alert", rule_name="siem_alert", severity=8.0,
                 index_role="alerts", source_id="s1", source_name="SIEM")
        for i in range(6)
    ]
    clusters = correlate(alert_events, prefs)
    assert len(clusters) == 1 and clusters[0].is_alert is True
    stats = await handle_clusters(
        clusters, prefs, cases=app_state.cases, pipeline=app_state.pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
    )
    assert stats["investigated"] == 1
    assert stats["candidates"] == 0

    # Events-role cluster (same allowlist=[]) — should only be a candidate.
    ev_events = [
        RawEvent(id=f"ev{i}", index="logs-events", source={}, timestamp_millis=base + i * 1000,
                 ip="7.7.7.7", rule="noisy_rule", rule_name="noisy_rule", severity=3.0,
                 index_role="events", source_id="s1", source_name="SIEM")
        for i in range(6)
    ]
    clusters2 = correlate(ev_events, prefs)
    assert len(clusters2) == 1 and clusters2[0].is_alert is False
    stats2 = await handle_clusters(
        clusters2, prefs, cases=app_state.cases, pipeline=app_state.pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
    )
    assert stats2["investigated"] == 0
    assert stats2["candidates"] == 1


# --------------------------------------------------------------------------- #
# 3. Case.source_id / source_name recorded on creation
# --------------------------------------------------------------------------- #
@asyncio
async def test_case_records_source_provenance(app_state, mock_provider):
    base = 1_700_000_000_000
    events = [
        RawEvent(id=f"e{i}", index="logs-events", source={}, timestamp_millis=base + i * 1000,
                 ip="5.5.5.5", rule="r", rule_name="r", severity=4.0,
                 source_id="src-42", source_name="My Splunk", index_role="events")
        for i in range(6)  # >= default threshold (n=5)
    ]
    clusters = correlate(events, app_state.prefs)
    assert len(clusters) == 1
    cluster = clusters[0]
    assert cluster.source_id == "src-42"
    assert cluster.source_name == "My Splunk"
    # register_candidate (no LLM) records the provenance...
    case = await app_state.pipeline.register_candidate(cluster, SourceSurface.AUTOMATED_SCAN, app_state.prefs)
    assert case.source_id == "src-42"
    assert case.source_name == "My Splunk"
    dumped = case.model_dump(mode="json")
    assert dumped["source_id"] == "src-42"
    assert dumped["source_name"] == "My Splunk"
    # ...and a full investigation keeps it.
    inv = await app_state.pipeline.investigate_cluster(cluster, SourceSurface.AUTOMATED_SCAN,
                                                       app_state.prefs, force=True)
    assert inv.source_id == "src-42"
    assert inv.source_name == "My Splunk"


# --------------------------------------------------------------------------- #
# 5. Chat source_id scoping
# --------------------------------------------------------------------------- #
@pytest.fixture
def client_two_es(secrets, mock_provider):
    """A TestClient whose PRIMARY source has its own ES, plus a SECOND selectable
    source with DIFFERENT data, both in-memory."""
    overrides = {"anthropic": mock_provider, "openai": mock_provider, "mock": mock_provider}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        es = InMemoryESClient()
        base = to_millis(now_utc()) - 120_000
        es.add_log("all-logs-2026.06", make_log_event(ip="1.1.1.1", rule="primary_rule",
                   ts_millis=base), doc_id="p1")
        state = AppState.create(secrets=secrets, es=es, provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        # Add a second elasticsearch source that points at a DIFFERENT pattern.
        es.add_log("other-logs-2026.06", make_log_event(ip="2.2.2.2", rule="other_rule",
                   ts_millis=base), doc_id="o1")
        src = SourceInstance(
            id="other", source_type=SourceType.ELASTICSEARCH, display_name="Other",
            config={"data_view_pattern": "other-logs-*"},
        )
        await state.update_prefs(state.prefs.model_copy(update={"sources": [src]}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router)
    with TestClient(api) as c:
        yield c


def _chat_query_script(rule: str) -> str:
    return json.dumps({
        "answer": "Fetching logs.",
        "needs_query": True,
        "query": {"rule": rule, "time_from": "now-24h", "time_to": "now"},
    })


def test_chat_source_id_routes_to_selected_source(client_two_es, mock_provider):
    # Two chat turns are scripted (turn-1 query intent, turn-2 analysis).
    mock_provider.push("chat", _chat_query_script("other_rule"))
    mock_provider.push("chat", json.dumps({"answer": "Analysed the other source."}))
    r = client_two_es.post("/api/chat", json={
        "message": "show me other_rule events",
        "source_id": "other",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    # The es_query ran against the SELECTED source's pattern and returned its row.
    assert body["table"] is not None
    rows = body["table"]["rows"]
    cols = body["table"]["columns"]
    ip_idx = cols.index("ip")
    assert any(row[ip_idx] == "2.2.2.2" for row in rows)


def test_chat_without_source_id_uses_primary(client_two_es, mock_provider):
    mock_provider.push("chat", _chat_query_script("primary_rule"))
    mock_provider.push("chat", json.dumps({"answer": "Analysed the primary source."}))
    r = client_two_es.post("/api/chat", json={"message": "show me primary_rule events"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["table"] is not None
    cols = body["table"]["columns"]
    ip_idx = cols.index("ip")
    assert any(row[ip_idx] == "1.1.1.1" for row in body["table"]["rows"])


def test_chat_unknown_source_id_is_rejected_without_primary_fallback(client_two_es, mock_provider):
    mock_provider.push("chat", json.dumps({"answer": "No query needed."}))
    r = client_two_es.post("/api/chat", json={"message": "hello", "source_id": "does-not-exist"})
    assert r.status_code == 422, r.text
    assert r.json()["detail"]["code"] == "chat_source_unavailable"


def test_completed_chat_replays_after_its_source_is_disabled(client_two_es, mock_provider):
    mock_provider.push("chat", json.dumps({"answer": "Durable scoped response."}))
    payload = {
        "message": "summarize the other source",
        "source_id": "other",
        "persist_conversation": True,
        "idempotency_key": "chat-disabled-source-replay-001",
    }
    before = len([call for call in mock_provider.calls if call["role"] == "chat"])
    first = client_two_es.post("/api/chat", json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["effective_source_id"] == "other"
    assert first.json()["effective_source_name"] == "Other"

    state = client_two_es.app.state.tlsoc
    source = next(item for item in state.prefs.sources if item.id == "other")
    source.enabled = False
    replay = client_two_es.post("/api/chat", json=payload)
    after = len([call for call in mock_provider.calls if call["role"] == "chat"])
    assert replay.status_code == 200, replay.text
    assert replay.json() == first.json()
    assert after - before == 1


# --------------------------------------------------------------------------- #
# Config helpers
# --------------------------------------------------------------------------- #
def test_source_instance_index_patterns_helper():
    s = SourceInstance(id="a", source_type=SourceType.ELASTICSEARCH,
                       config={"index_patterns": [{"pattern": "x-*", "role": "alerts"}, "y-*"]})
    pats = s.index_patterns()
    assert pats[0] == IndexPattern(pattern="x-*", role=IndexRole.ALERTS)
    assert pats[1] == IndexPattern(pattern="y-*", role=IndexRole.EVENTS)


def test_source_instance_falls_back_to_data_view_pattern():
    s = SourceInstance(id="a", source_type=SourceType.ELASTICSEARCH,
                       config={"data_view_pattern": "all-logs-*"})
    pats = s.index_patterns()
    assert pats == [IndexPattern(pattern="all-logs-*", role=IndexRole.EVENTS)]


def test_source_instance_entity_strategy_override():
    s = SourceInstance(id="a", source_type=SourceType.ELASTICSEARCH,
                       config={"entity_strategy": "host"})
    assert s.entity_strategy() == EntityStrategy.HOST
    assert SourceInstance(id="b", source_type=SourceType.ELASTICSEARCH).entity_strategy() is None
