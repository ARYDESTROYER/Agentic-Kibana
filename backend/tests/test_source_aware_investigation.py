"""Investigations use the log connector that produced the cluster."""

from __future__ import annotations

import contextlib

import pytest

from app.api.routes import _cluster_for_case
from app.config import Preferences
from app.config import SourceInstance
from app.constants import EntityType, SourceSurface, SourceType
from app.engine.ingest import handle_clusters
from app.engine.signatures import cluster_signature
from app.models import Case, Cluster, Entity, RawEvent
from tests.conftest import make_log_event


def _alert_cluster() -> Cluster:
    event = RawEvent(
        id="source-b:event-1",
        index="alerts-b",
        source={},
        timestamp_millis=1_700_000_000_000,
        ip="198.51.100.8",
        rule="vendor_alert",
        rule_name="Vendor alert",
        severity=9.0,
        source_id="source-b",
        index_role="alerts",
    )
    return Cluster(
        signature="source-b-cluster",
        entity=Entity(type=EntityType.IP, value=event.ip),
        group_by=EntityType.IP,
        rule_values=[event.rule],
        member_event_ids=[event.id],
        member_events=[event],
        first_seen_millis=event.timestamp_millis,
        last_seen_millis=event.timestamp_millis,
        count=1,
        source_id="source-b",
        source_ids=["source-b"],
        is_alert=True,
    )


def test_pipeline_builds_es_query_tool_from_explicit_source(app_state):
    source_b = object()

    investigator, _enrich = app_state.pipeline._build_investigator(
        app_state.prefs, query_source=source_b
    )

    assert investigator._tools.get("es_query")._source is source_b


def test_push_only_pipeline_has_no_cross_source_query_tool(app_state):
    investigator, _enrich = app_state.pipeline._build_investigator(
        app_state.prefs, query_source=None
    )

    assert "es_query" not in investigator._tools.names()


@pytest.mark.asyncio
async def test_handle_clusters_forwards_originating_source_to_pipeline():
    source_b = object()

    class Cases:
        async def find_open_by_signature(self, _signature):
            return None

    class Pipeline:
        def __init__(self):
            self.received_source = None

        def signature_lock(self, _signature):
            return contextlib.nullcontext()

        async def _investigate_cluster_locked(
            self, _cluster, _surface, _prefs, *, query_source=None
        ):
            self.received_source = query_source

    pipeline = Pipeline()
    prefs = Preferences(background_scan_enabled=True)
    stats = await handle_clusters(
        [_alert_cluster()],
        prefs,
        cases=Cases(),
        pipeline=pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
        query_source=source_b,
    )

    assert stats["investigated"] == 1
    assert pipeline.received_source is source_b


def test_manual_investigate_reads_only_selected_source(client):
    for source_id, pattern, primary in (
        ("source-a", "source-a-*", True),
        ("source-b", "source-b-*", False),
    ):
        response = client.post(
            "/api/sources",
            json={
                "id": source_id,
                "source_type": "elasticsearch",
                "is_primary": primary,
                "config": {"data_view_pattern": pattern},
            },
        )
        assert response.status_code == 200

    ip = "198.51.100.44"
    source_a_event = make_log_event(ip=ip, rule="source_a_rule")
    source_b_event = make_log_event(ip=ip, rule="source_b_rule")
    es = client.app.state.tlsoc.es
    es.add_log("source-a-events", source_a_event, "a-1")
    es.add_log("source-b-events", source_b_event, "b-1")

    response = client.post(
        "/api/investigate",
        json={"source_id": "source-b", "entity": {"type": "ip", "value": ip}},
    )

    assert response.status_code == 200, response.text
    case = response.json()
    assert case["source_id"] == "source-b"
    assert "source_b_rule" in case["rule_ids"]
    assert "source_a_rule" not in case["rule_ids"]


def test_manual_investigate_rejects_push_source_as_query_surface(client):
    created = client.post(
        "/api/sources",
        json={"id": "push-only", "source_type": "webhook", "config": {}},
    )
    assert created.status_code == 200

    response = client.post(
        "/api/investigate",
        json={"source_id": "push-only", "event_ids": ["event-1"]},
    )

    assert response.status_code == 400
    assert "queryable pull source" in response.json()["detail"]


def test_push_first_source_cannot_become_legacy_elastic_query_surface(client):
    state = client.app.state.tlsoc
    state.es.add_log(
        "all-logs-hidden",
        make_log_event(ip="203.0.113.90", rule="must_not_leak"),
        "hidden-1",
    )
    created = client.post(
        "/api/sources",
        json={
            "id": "push-first",
            "source_type": "webhook",
            "is_primary": True,
            "config": {},
        },
    )
    assert created.status_code == 200
    saved = next(s for s in created.json()["sources"] if s["id"] == "push-first")
    assert saved["is_primary"] is False
    assert state.prefs.primary_source() is None
    assert state.log_source.connector_id == "no-pull-source"

    response = client.post(
        "/api/investigate",
        json={"entity": {"type": "ip", "value": "203.0.113.90"}},
    )
    assert response.status_code == 400


def test_primary_source_ignores_legacy_receiver_with_pull_default():
    prefs = Preferences(sources=[
        SourceInstance(
            id="legacy-webhook",
            source_type=SourceType.WEBHOOK,
            is_primary=True,
        ),
        SourceInstance(
            id="real-pull",
            source_type=SourceType.ELASTICSEARCH,
        ),
    ])
    assert prefs.primary_source().id == "real-pull"


@pytest.mark.asyncio
async def test_push_case_reconstruction_never_queries_primary_es(app_state, monkeypatch):
    case = Case(
        case_id="case-push",
        cluster_signature="push-signature",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.120"),
        source_id="push-only",
        member_event_ids=["push-event-1"],
        rule_ids=["push-rule"],
    )

    async def forbidden(*args, **kwargs):
        raise AssertionError("primary Elasticsearch must not be queried")

    monkeypatch.setattr(app_state.es, "search_logs", forbidden)
    cluster = await _cluster_for_case(
        app_state,
        case,
        allow_stored_reconstruction=True,
        query_source=None,
    )
    assert cluster is not None
    assert cluster.signature == case.cluster_signature
    assert cluster.source_id == "push-only"
    assert cluster.rule_values == ["push-rule"]


@pytest.mark.asyncio
async def test_source_scoping_migrates_open_legacy_case_in_place(app_state):
    cluster = _alert_cluster()
    cluster.is_alert = False
    cluster.signature = cluster_signature(
        cluster.entity.type, cluster.entity.value, source_id=cluster.source_id
    )
    cluster.legacy_signature = cluster_signature(cluster.entity.type, cluster.entity.value)
    legacy = Case(
        case_id="case-legacy",
        cluster_signature=cluster.legacy_signature,
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=cluster.entity,
        member_event_ids=["older-event"],
    )
    await app_state.cases.save(legacy)
    prefs = app_state.prefs.model_copy(update={"background_scan_enabled": False})

    stats = await handle_clusters(
        [cluster],
        prefs,
        cases=app_state.cases,
        pipeline=app_state.pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
    )

    cases, total = await app_state.cases.list()
    assert stats["attached"] == 1
    assert total == 1
    assert cases[0].case_id == "case-legacy"
    assert cases[0].cluster_signature == cluster.signature
    assert cases[0].source_id == "source-b"
