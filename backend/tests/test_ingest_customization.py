"""Wave 5 / F6 + F9 — ingestion customization, Auto-Correlate toggles, connector help.

All offline (fake ES, mock LLM). Covers:

* The per-SOURCE "Auto-Correlate" toggle (config["auto_correlate"]=False) suppresses
  auto-forward (the cluster becomes a candidate, not an investigation) — and the
  default (True / absent) is byte-identical to today.
* The per-SUB-SOURCE (index pattern) toggle (IndexPattern.auto_correlate=False)
  suppresses auto-forward for a cluster touching that pattern.
* Per-source field_mappings_extra is applied in the Elastic read path, and falls
  back to global Preferences when unset.
* Connector manifests expose the new help fields (help/help_link/help_code) +
  setup_help (every connector, via the registry fallback).
* /api/sources/{id}/analyze-sample suggests mappings and NEVER persists the sample.

Cross-source linking end-to-end (set related_case_ids/cross_source_cluster_id/
source_breakdown via ingest) is exercised here too.
"""

from __future__ import annotations

import pytest

from app.config import (
    CorrelationRule,
    IndexPattern,
    Preferences,
    SourceInstance,
)
from app.connectors.base import StructuredQuery
from app.connectors.elastic import ElasticConnector
from app.connectors.registry import get_registry
from app.constants import (
    CorrelationMode,
    EntityType,
    IndexRole,
    SourceSurface,
    SourceType,
)
from app.engine.correlation import correlate
from app.engine.ingest import _auto_correlate_allowed, handle_clusters, link_cross_source
from app.es.fake import InMemoryESClient
from app.models import RawEvent
from tests.conftest import make_log_event

asyncio = pytest.mark.asyncio


def _prefs() -> Preferences:
    p = Preferences()
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=5, window_seconds=120, group_by=EntityType.IP
    )
    p.background_scan_enabled = True
    p.auto_forward_allowlist = ["*"]  # everything allowlisted, so only toggles gate
    return p


def _events(source_id: str, index: str = "logs-events", n: int = 6) -> list[RawEvent]:
    base = 1_700_000_000_000
    return [
        RawEvent(id=f"{source_id}-e{i}", index=index, source={}, timestamp_millis=base + i * 1000,
                 ip="5.5.5.5", rule="r", rule_name="r", severity=4.0,
                 source_id=source_id, source_name=source_id, index_role="events")
        for i in range(n)
    ]


# --------------------------------------------------------------------------- #
# Auto-Correlate defaults — byte-identical out of the box (#4).
# --------------------------------------------------------------------------- #
def test_source_auto_correlate_defaults_true():
    s = SourceInstance(id="s1", source_type=SourceType.ELASTICSEARCH)
    assert s.auto_correlate() is True
    # Explicit truthy/falsey values resolve as expected.
    assert SourceInstance(id="s2", source_type=SourceType.ELASTICSEARCH,
                          config={"auto_correlate": False}).auto_correlate() is False
    assert SourceInstance(id="s3", source_type=SourceType.ELASTICSEARCH,
                          config={"auto_correlate": "false"}).auto_correlate() is False
    assert SourceInstance(id="s4", source_type=SourceType.ELASTICSEARCH,
                          config={"auto_correlate": True}).auto_correlate() is True


def test_index_pattern_auto_correlate_defaults_true():
    assert IndexPattern(pattern="x-*").auto_correlate is True
    s = SourceInstance(
        id="s", source_type=SourceType.ELASTICSEARCH,
        config={"index_patterns": [
            {"pattern": "a-*", "role": "events", "auto_correlate": False},
            {"pattern": "b-*", "role": "alerts"},
        ]},
    )
    assert s.pattern_auto_correlate("a-*") is False
    assert s.pattern_auto_correlate("b-*") is True
    assert s.pattern_auto_correlate("unconfigured-*") is True  # back-compat


def test_no_source_cluster_always_auto_correlates():
    """A cluster with no resolvable source (legacy implicit source) is unchanged."""
    cluster = correlate(_events(""), _prefs())[0]
    cluster.source_id = None
    assert _auto_correlate_allowed(cluster, _prefs()) is True


# --------------------------------------------------------------------------- #
# Per-source Auto-Correlate False suppresses auto-forward.
# --------------------------------------------------------------------------- #
@asyncio
async def test_source_auto_correlate_false_suppresses_auto_forward(app_state):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = True
    prefs.auto_forward_allowlist = ["*"]
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=5, window_seconds=120, group_by=EntityType.IP
    )
    # Source with Auto-Correlate OFF.
    prefs.sources = [SourceInstance(id="s1", source_type=SourceType.ELASTICSEARCH,
                                    config={"auto_correlate": False})]
    clusters = correlate(_events("s1"), prefs)
    assert len(clusters) == 1 and clusters[0].source_id == "s1"
    stats = await handle_clusters(
        clusters, prefs, cases=app_state.cases, pipeline=app_state.pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
    )
    # Manual triage only: a candidate, NOT an investigation.
    assert stats["investigated"] == 0
    assert stats["candidates"] == 1


@asyncio
async def test_source_auto_correlate_true_still_auto_forwards(app_state):
    """The default (True) keeps today's auto-forward behaviour (regression)."""
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = True
    prefs.auto_forward_allowlist = ["*"]
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=5, window_seconds=120, group_by=EntityType.IP
    )
    prefs.sources = [SourceInstance(id="s1", source_type=SourceType.ELASTICSEARCH)]  # default True
    clusters = correlate(_events("s1"), prefs)
    stats = await handle_clusters(
        clusters, prefs, cases=app_state.cases, pipeline=app_state.pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
    )
    assert stats["investigated"] == 1
    assert stats["candidates"] == 0


# --------------------------------------------------------------------------- #
# Per-SUB-SOURCE (index pattern) toggle suppresses auto-forward.
# --------------------------------------------------------------------------- #
@asyncio
async def test_sub_source_pattern_toggle_suppresses_auto_forward(app_state):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = True
    prefs.auto_forward_allowlist = ["*"]
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=5, window_seconds=120, group_by=EntityType.IP
    )
    # Source auto-correlate ON, but the events' index pattern has auto_correlate OFF.
    prefs.sources = [SourceInstance(
        id="s1", source_type=SourceType.ELASTICSEARCH,
        config={"index_patterns": [
            {"pattern": "logs-events*", "role": "events", "auto_correlate": False},
        ]},
    )]
    clusters = correlate(_events("s1", index="logs-events-2026.06"), prefs)
    assert clusters[0].source_id == "s1"
    stats = await handle_clusters(
        clusters, prefs, cases=app_state.cases, pipeline=app_state.pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
    )
    assert stats["investigated"] == 0
    assert stats["candidates"] == 1


@asyncio
async def test_sub_source_other_pattern_unaffected(app_state):
    """A disabled sub-source pattern does NOT block clusters from a DIFFERENT enabled
    pattern on the same source."""
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = True
    prefs.auto_forward_allowlist = ["*"]
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=5, window_seconds=120, group_by=EntityType.IP
    )
    prefs.sources = [SourceInstance(
        id="s1", source_type=SourceType.ELASTICSEARCH,
        config={"index_patterns": [
            {"pattern": "logs-quiet*", "role": "events", "auto_correlate": False},
            {"pattern": "logs-live*", "role": "events", "auto_correlate": True},
        ]},
    )]
    clusters = correlate(_events("s1", index="logs-live-2026.06"), prefs)
    stats = await handle_clusters(
        clusters, prefs, cases=app_state.cases, pipeline=app_state.pipeline,
        source_surface=SourceSurface.AUTOMATED_SCAN,
    )
    assert stats["investigated"] == 1
    assert stats["candidates"] == 0


# --------------------------------------------------------------------------- #
# F9 — per-source field_mappings_extra in the Elastic read path.
# --------------------------------------------------------------------------- #
@asyncio
async def test_field_mappings_extra_applied_in_read_path():
    """A source with field_mappings_extra reads non-ECS fields; the extracted
    RawEvent reflects the overridden mapping."""
    es = InMemoryESClient()
    base = 1_700_000_000_000
    # A NON-ECS document: the ip lives at data.srcip, the user at data.srcuser.
    doc = {
        "@timestamp": "2026-06-29T00:00:00Z",
        "data": {"srcip": "203.0.113.7", "srcuser": "attacker"},
        "event": {"module": "custom_rule"},
        "log": {"message": "custom message"},
    }
    es.add_log("custom-logs-2026.06", doc, doc_id="x1")
    config = {
        "data_view_pattern": "custom-logs-*",
        "field_mappings_extra": {
            "source_ip_field": "data.srcip",
            "user_field": "data.srcuser",
            "message_field": "log.message",
        },
    }
    conn = ElasticConnector(es, config=config, connector_id="custom1")
    res = await conn.fetch_by_ids(Preferences(setup_complete=True), ["x1"], size=1)
    assert len(res.events) == 1
    ev = res.events[0]
    assert ev.ip == "203.0.113.7"
    assert ev.user == "attacker"


@asyncio
async def test_field_mappings_extra_falls_back_to_global_prefs():
    """With NO field_mappings_extra, the connector uses the global ECS prefs (the ip
    at source.ip is read), proving the fallback."""
    es = InMemoryESClient()
    es.add_log("all-logs-2026.06", make_log_event(ip="10.0.0.42", user="alice"), doc_id="e1")
    conn = ElasticConnector(es, config={"data_view_pattern": "all-logs-*"}, connector_id="c1")
    res = await conn.fetch_by_ids(Preferences(setup_complete=True), ["e1"], size=1)
    ev = res.events[0]
    assert ev.ip == "10.0.0.42"   # read via global source.ip mapping
    assert ev.user == "alice"


def test_field_mappings_extra_precedence_over_top_level_config():
    """field_mappings_extra wins over a top-level config key for the same field."""
    config = {
        "source_ip_field": "top.level.ip",
        "field_mappings_extra": {"source_ip_field": "extra.ip"},
    }
    conn = ElasticConnector(InMemoryESClient(), config=config, connector_id="c1")
    eff = conn._effective_prefs(Preferences())
    assert eff.source_ip_field == "extra.ip"


# --------------------------------------------------------------------------- #
# F9 — connector contextual help + setup_help on the manifests.
# --------------------------------------------------------------------------- #
def test_elastic_manifest_exposes_help_and_setup_help():
    m = ElasticConnector.manifest()
    assert m.setup_help and "read-only" in m.setup_help.lower()
    api_key = next(f for f in m.auth_fields if f.key == "es_api_key")
    assert api_key.help_link  # a doc link
    assert api_key.help_code and "_security/api_key" in api_key.help_code
    assert api_key.help_code_language == "json"


def test_every_connector_manifest_has_setup_help():
    """The registry guarantees a non-empty setup_help on EVERY connector (curated or
    synthesised) so the wizard's contextual-help affordance is always present."""
    reg = get_registry()
    manifests = reg.manifests()
    assert manifests
    for m in manifests:
        assert (m.setup_help or "").strip(), f"{m.source_type} missing setup_help"


def test_webhook_and_syslog_have_curated_setup_help():
    reg = get_registry()
    webhook = reg.manifest(SourceType.WEBHOOK)
    syslog = reg.manifest(SourceType.SYSLOG)
    assert "ingest" in webhook.setup_help.lower()
    assert "syslog" in syslog.setup_help.lower()


def test_authfield_help_fields_default_empty_back_compat():
    """The new AuthField help fields are additive + default empty (older manifests
    without them deserialize/serialize unchanged)."""
    from app.connectors.base import AuthField

    f = AuthField(key="k", label="L")
    assert f.help_link == "" and f.help_code == "" and f.help_code_language == "yaml"


# --------------------------------------------------------------------------- #
# F9 — analyze-sample: suggests mappings, sanitized, NEVER persisted.
# --------------------------------------------------------------------------- #
def test_analyze_sample_pure_helper_suggests_and_flattens():
    from app.engine.sample_analysis import analyze_sample

    sample = {
        "@timestamp": "2026-06-29T00:00:00Z",
        "data": {"srcip": "1.2.3.4", "srcuser": "bob"},
        "agent": {"name": "host-7"},
        "rule": {"id": "5710", "description": "sshd auth failure", "level": 5},
        "full_log": "raw line",
    }
    out = analyze_sample(sample)
    sm = out["suggested_mappings"]
    assert sm["source_ip_field"] == "data.srcip"
    assert sm["user_field"] == "data.srcuser"
    assert sm["host_field"] == "agent.name"
    assert sm["rule_field"] == "rule.id"
    assert sm["severity_field"] == "rule.level"
    assert sm["time_field"] == "@timestamp"
    # The flattened path inventory is present (paths only — never the values).
    assert "data.srcip" in out["fields"]
    assert "rule.description" in out["fields"]


def test_analyze_sample_route_does_not_persist(client):
    """POST /sources/{id}/analyze-sample returns suggestions but writes NOTHING to the
    config doc / sources (#9 — the sample is sanitized, never persisted)."""
    before = client.get("/api/settings").json()["prefs"]
    sample = {"source": {"ip": "9.9.9.9"}, "user": {"name": "carol"}, "message": "hi"}
    r = client.post("/api/sources/any-id/analyze-sample", json={"sample": sample})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["suggested_mappings"]["source_ip_field"] == "source.ip"
    assert body["suggested_mappings"]["user_field"] == "user.name"
    # Nothing was persisted: sources unchanged, the sample IP never appears in prefs.
    after = client.get("/api/settings").json()["prefs"]
    assert after["sources"] == before["sources"]
    import json as _json
    assert "9.9.9.9" not in _json.dumps(after)


def test_analyze_sample_route_rejects_empty(client):
    r = client.post("/api/sources/any-id/analyze-sample", json={"sample": {}})
    assert r.status_code == 400


def test_connectors_route_returns_help_and_setup_help(client):
    """GET /connectors and /connectors/{type} surface the new help + setup_help."""
    r = client.get("/api/connectors")
    assert r.status_code == 200
    manifests = r.json()["connectors"]
    assert manifests and all(m.get("setup_help") for m in manifests)
    r2 = client.get("/api/connectors/elasticsearch")
    assert r2.status_code == 200
    m = r2.json()
    assert m["setup_help"]
    api_key = next(f for f in m["auth_fields"] if f["key"] == "es_api_key")
    assert api_key["help_link"] and api_key["help_code"]


# --------------------------------------------------------------------------- #
# F6 — cross-source linking end-to-end via the ingest service.
# --------------------------------------------------------------------------- #
@asyncio
async def test_cross_source_linking_sets_related_fields(app_state):
    """With cross-source ENABLED, two open cases from different sources that have
    DISTINCT primary entities (different IPs → distinct 1:1 signatures) but share a
    secondary entity (a domain) within the window get linked as RELATED
    (related_case_ids + cross_source_cluster_id + source_breakdown) — NEVER merged."""
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = False  # candidates only — keep them OPEN
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.EVERY, window_seconds=120, group_by=EntityType.IP
    )
    prefs.cross_source_correlation.enabled = True
    prefs.cross_source_correlation.time_window_seconds = 300
    prefs.cross_source_correlation.min_sources = 2
    prefs.sources = [
        SourceInstance(id="srcA", source_type=SourceType.ELASTICSEARCH),
        SourceInstance(id="srcB", source_type=SourceType.ELASTICSEARCH),
    ]
    await app_state.update_prefs(prefs)

    base = 1_700_000_000_000
    # Distinct IPs → two distinct cases; the SHARED key is the domain "evil.test".
    # A combined multi-source feed (one batch) carries BOTH sources' events, so both
    # clusters (with full member events) participate in the cross-source pass.
    batch = [
        RawEvent(id="a1", index="ix", source={"url": {"domain": "evil.test"}},
                 timestamp_millis=base, ip="1.1.1.1", rule="r", rule_name="r", severity=4.0,
                 source_id="srcA", source_name="A", index_role="events"),
        RawEvent(id="b1", index="ix", source={"url": {"domain": "evil.test"}},
                 timestamp_millis=base + 60_000, ip="2.2.2.2", rule="r", rule_name="r",
                 severity=4.0, source_id="srcB", source_name="B", index_role="events"),
    ]
    await app_state.ingest_service.ingest(batch, prefs)

    cases, _ = await app_state.cases.list(limit=50)
    by_source = {c.source_id: c for c in cases if c.source_id in ("srcA", "srcB")}
    assert set(by_source) == {"srcA", "srcB"}
    a, b = by_source["srcA"], by_source["srcB"]
    # Distinct per-cluster signatures (NEVER merged, #4) but a SHARED cross-source id.
    assert a.cluster_signature != b.cluster_signature
    assert a.cross_source_cluster_id and a.cross_source_cluster_id == b.cross_source_cluster_id
    # Each links to the OTHER as related.
    assert b.case_id in a.related_case_ids
    assert a.case_id in b.related_case_ids
    # Source breakdown reflects both contributing sources.
    assert set(a.source_breakdown) == {"srcA", "srcB"}


@asyncio
async def test_cross_source_links_across_separate_ingests_via_store_pool(app_state):
    """Cross-ingest linking via the store pool: source A opens a case whose PRIMARY
    entity is a host; a LATER source-B cluster (primary IP) whose events reference
    that SAME host links to A across separate ingest batches (A is pooled from the
    store by its primary host key, B contributes the host from its member events)."""
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = False
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.EVERY, window_seconds=600, group_by=EntityType.HOST
    )
    prefs.cross_source_correlation.enabled = True
    prefs.cross_source_correlation.time_window_seconds = 600
    prefs.cross_source_correlation.min_sources = 2
    prefs.sources = [
        SourceInstance(id="srcA", source_type=SourceType.ELASTICSEARCH,
                       config={"entity_strategy": "host"}),
        SourceInstance(id="srcB", source_type=SourceType.ELASTICSEARCH,
                       config={"entity_strategy": "host"}),
    ]
    await app_state.update_prefs(prefs)

    base = 1_700_000_000_000
    # Source A: a case keyed on host "web01".
    await app_state.ingest_service.ingest(
        [RawEvent(id="a1", index="ix", source={}, timestamp_millis=base, ip="1.1.1.1",
                  host="web01", rule="r", rule_name="r", severity=4.0,
                  source_id="srcA", source_name="A")],
        prefs, source_id="srcA")
    # Source B (later, separate batch) reports the same host. Source-scoped incident
    # identity keeps it distinct; the cross-source pass links the two cases instead of
    # merging provenance/evidence.
    await app_state.ingest_service.ingest(
        [RawEvent(id="b1", index="ix", source={}, timestamp_millis=base + 30_000, ip="2.2.2.2",
                  host="web01", rule="r", rule_name="r", severity=4.0,
                  source_id="srcB", source_name="B")],
        prefs, source_id="srcB")
    cases, _ = await app_state.cases.list(limit=50)
    web01 = [c for c in cases if c.entity.value == "web01"]
    assert len(web01) == 2
    assert {c.source_id for c in web01} == {"srcA", "srcB"}
    assert web01[0].cluster_signature != web01[1].cluster_signature
    assert web01[0].cross_source_cluster_id == web01[1].cross_source_cluster_id


@asyncio
async def test_cross_source_component_absorbs_preseeded_overlap_symmetrically(app_state):
    """A persisted A↔B component plus current B↔C↔D overlaps becomes A↔B↔C↔D.

    Only resolved prior links inside the existing bounded candidate pool may seed the
    component.  An unrelated open case and a dangling related id must stay isolated.
    """
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = False
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.EVERY, window_seconds=600, group_by=EntityType.IP
    )
    prefs.cross_source_correlation.enabled = True
    prefs.cross_source_correlation.time_window_seconds = 600
    prefs.cross_source_correlation.min_sources = 2
    await app_state.update_prefs(prefs)

    base = 1_700_000_000_000
    prior = [
        RawEvent(
            id="splunk-prior", index="splunk-main", source={}, user="svc-checkout",
            timestamp_millis=base, ip="203.0.113.10", rule="splunk-risk", rule_name="splunk-risk",
            severity=75.0, source_id="demo-splunk", source_name="Splunk",
        ),
        RawEvent(
            id="qradar-prior", index="qradar-offenses", source={}, user="svc-checkout",
            timestamp_millis=base + 1_000, ip="203.0.113.20", rule="qradar-offense",
            rule_name="qradar-offense", severity=80.0,
            source_id="demo-qradar", source_name="QRadar",
        ),
        RawEvent(
            id="unrelated-prior", index="other", source={}, timestamp_millis=base + 2_000,
            ip="198.51.100.90", rule="unrelated", rule_name="unrelated", severity=20.0,
            source_id="demo-unrelated", source_name="Unrelated",
        ),
    ]
    await app_state.ingest_service.ingest(prior, prefs)

    cases, _ = await app_state.cases.list(limit=50)
    by_source = {case.source_id: case for case in cases}
    splunk = by_source["demo-splunk"]
    qradar = by_source["demo-qradar"]
    assert splunk.related_case_ids == [qradar.case_id]
    assert qradar.related_case_ids == [splunk.case_id]
    prior_component_id = splunk.cross_source_cluster_id
    assert prior_component_id and qradar.cross_source_cluster_id == prior_component_id
    # A dangling persisted id is ignored rather than expanding the candidate pool.
    splunk.related_case_ids.append("case-does-not-exist")
    await app_state.cases.save(splunk)

    current = [
        RawEvent(
            id="qradar-current", index="qradar-events", source={},
            timestamp_millis=base + 30_000, ip="203.0.113.20", host="checkout-web-01",
            rule="qradar-followup", rule_name="qradar-followup", severity=82.0,
            source_id="demo-qradar", source_name="QRadar",
        ),
        RawEvent(
            id="wazuh-current", index="wazuh-alerts",
            source={"file": {"hash": {"sha256": "a" * 64}}},
            timestamp_millis=base + 31_000, ip="203.0.113.30", host="checkout-web-01",
            rule="wazuh-webshell", rule_name="wazuh-webshell", severity=90.0,
            source_id="demo-wazuh", source_name="Wazuh",
        ),
        RawEvent(
            id="syslog-current", index="syslog",
            source={"file": {"hash": {"sha256": "a" * 64}}},
            timestamp_millis=base + 32_000, ip="203.0.113.40",
            rule="syslog-egress", rule_name="syslog-egress", severity=85.0,
            source_id="demo-syslog", source_name="Syslog",
        ),
    ]
    current_clusters = correlate(current, prefs)
    await app_state.ingest_service.ingest(current, prefs)

    cases, _ = await app_state.cases.list(limit=50)
    by_source = {case.source_id: case for case in cases}
    component = [by_source[source_id] for source_id in (
        "demo-splunk", "demo-qradar", "demo-wazuh", "demo-syslog"
    )]
    component_ids = {case.case_id for case in component}
    assert {case.cross_source_cluster_id for case in component} == {prior_component_id}
    for case in component:
        assert set(case.related_case_ids) == component_ids - {case.case_id}
        assert set(case.source_breakdown) == {
            "demo-splunk", "demo-qradar", "demo-wazuh", "demo-syslog"
        }

    unrelated = by_source["demo-unrelated"]
    assert unrelated.cross_source_cluster_id == ""
    assert unrelated.related_case_ids == []
    assert "case-does-not-exist" not in by_source["demo-splunk"].related_case_ids

    before = {
        case.case_id: (
            case.cross_source_cluster_id,
            tuple(case.related_case_ids),
            tuple(sorted(case.source_breakdown.items())),
        )
        for case in component
    }
    # Same logical batch, in another order, produces no writes or metadata drift.
    assert await link_cross_source(
        list(reversed(current_clusters)), prefs, cases=app_state.cases
    ) == 0
    cases, _ = await app_state.cases.list(limit=50)
    after = {
        case.case_id: (
            case.cross_source_cluster_id,
            tuple(case.related_case_ids),
            tuple(sorted(case.source_breakdown.items())),
        )
        for case in cases if case.case_id in component_ids
    }
    assert after == before


@asyncio
async def test_cross_source_disabled_leaves_cases_unlinked(app_state):
    """Cross-source OFF → cases are NOT linked (single-source path).

    (Autopilot overhaul flipped the DEFAULT to ON; pin it OFF for this scenario.)"""
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.background_scan_enabled = False
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.EVERY, window_seconds=120, group_by=EntityType.IP
    )
    prefs.cross_source_correlation.enabled = False
    assert prefs.cross_source_correlation.enabled is False
    prefs.sources = [
        SourceInstance(id="srcA", source_type=SourceType.ELASTICSEARCH),
        SourceInstance(id="srcB", source_type=SourceType.ELASTICSEARCH),
    ]
    await app_state.update_prefs(prefs)
    base = 1_700_000_000_000
    await app_state.ingest_service.ingest(
        [RawEvent(id="a1", index="ix", source={}, timestamp_millis=base, ip="9.9.9.9",
                  rule="r", rule_name="r", severity=4.0, source_id="srcA", source_name="A")],
        prefs, source_id="srcA")
    await app_state.ingest_service.ingest(
        [RawEvent(id="b1", index="ix", source={}, timestamp_millis=base + 1000, ip="9.9.9.9",
                  rule="r", rule_name="r", severity=4.0, source_id="srcB", source_name="B")],
        prefs, source_id="srcB")
    cases, _ = await app_state.cases.list(limit=50)
    matching = [c for c in cases if c.entity.value == "9.9.9.9"]
    assert len(matching) == 2
    assert {c.source_id for c in matching} == {"srcA", "srcB"}
    assert len({c.cluster_signature for c in matching}) == 2
    for c in cases:
        assert c.cross_source_cluster_id == ""
        assert c.related_case_ids == []
