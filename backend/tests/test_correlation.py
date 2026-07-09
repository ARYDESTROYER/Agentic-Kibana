"""Correlation is deterministic, windowed, and entity-centric (Section 6.2)."""

from __future__ import annotations

from app.config import (
    CorrelationRule,
    CrossSourceCorrelationConfig,
    Preferences,
)
from app.constants import CorrelationMode, EntityType
from app.engine.correlation import (
    CrossSourceItem,
    cluster_cross_source_entities,
    correlate,
    cross_source_correlate,
)
from app.engine.signatures import cross_source_signature
from app.models import RawEvent
from tests.conftest import make_raw_event


def _prefs(**rules) -> Preferences:
    p = Preferences()
    p.default_correlation = CorrelationRule(mode=CorrelationMode.THRESHOLD, n=5, window_seconds=120,
                                            group_by=EntityType.IP)
    if rules:
        p.correlation_rules = rules
    return p


def test_threshold_breach_creates_one_cluster():
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip="10.0.0.9", ts_millis=base + i * 1000) for i in range(5)]
    clusters = correlate(events, _prefs())
    assert len(clusters) == 1
    c = clusters[0]
    assert c.entity.value == "10.0.0.9"
    assert c.entity.type == EntityType.IP
    assert c.count == 5


def test_below_threshold_no_cluster():
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip="10.0.0.9", ts_millis=base + i * 1000) for i in range(4)]
    assert correlate(events, _prefs()) == []


def test_window_not_breached_when_events_too_spread():
    base = 1_700_000_000_000
    # 5 events but spaced 60s apart -> spans 240s > 120s window, never 5-in-window.
    events = [make_raw_event(id=f"e{i}", ip="10.0.0.9", ts_millis=base + i * 60_000) for i in range(5)]
    assert correlate(events, _prefs()) == []


def test_every_mode_triggers_on_single_event():
    prefs = _prefs(rare_rule=CorrelationRule(mode=CorrelationMode.EVERY, group_by=EntityType.IP))
    events = [make_raw_event(id="e1", ip="10.0.0.1", rule="rare_rule")]
    clusters = correlate(events, prefs)
    assert len(clusters) == 1


def test_never_mode_skips():
    prefs = _prefs(noisy=CorrelationRule(mode=CorrelationMode.NEVER))
    events = [make_raw_event(id=f"e{i}", ip="10.0.0.1", rule="noisy", ts_millis=1 + i) for i in range(20)]
    assert correlate(events, prefs) == []


def test_cluster_is_entity_centric_and_multi_rule():
    """A triggered entity gathers ALL its events across rules (diversity input)."""
    base = 1_700_000_000_000
    prefs = _prefs(authfail=CorrelationRule(mode=CorrelationMode.EVERY, group_by=EntityType.IP))
    events = [
        make_raw_event(id="a1", ip="10.0.0.5", rule="authfail", ts_millis=base),
        make_raw_event(id="a2", ip="10.0.0.5", rule="web_attack", ts_millis=base + 1000),
        make_raw_event(id="a3", ip="10.0.0.5", rule="portscan", ts_millis=base + 2000),
    ]
    clusters = correlate(events, prefs)
    assert len(clusters) == 1
    c = clusters[0]
    assert set(c.rule_values) == {"authfail", "web_attack", "portscan"}
    assert c.count == 3


def test_signature_is_stable_for_same_entity():
    prefs = _prefs(r=CorrelationRule(mode=CorrelationMode.EVERY, group_by=EntityType.IP))
    e1 = correlate([make_raw_event(id="x", ip="1.2.3.4", rule="r")], prefs)[0]
    e2 = correlate([make_raw_event(id="y", ip="1.2.3.4", rule="r")], prefs)[0]
    assert e1.signature == e2.signature  # idempotency key is entity-centric


# --------------------------------------------------------------------------- #
# Wave 5 / F6 — cross-source correlation (opt-in; NEVER merges).
# --------------------------------------------------------------------------- #
def _xsrc_prefs(**cfg) -> Preferences:
    p = _prefs()
    p.cross_source_correlation = CrossSourceCorrelationConfig(**cfg)
    return p


def _item(case_id: str, source_id: str, ts: int, et: EntityType, value: str) -> CrossSourceItem:
    return CrossSourceItem(
        id=case_id, source_id=source_id, ts=ts,
        entities=frozenset({(et, value)}),
    )


def test_cross_source_disabled_is_noop():
    """When cross_source_correlation is disabled → no groups (the off-path).

    (Autopilot overhaul flipped the DEFAULT to ON; here we pin it OFF to exercise the
    disabled no-op.)"""
    prefs = _prefs()
    prefs.cross_source_correlation.enabled = False
    assert prefs.cross_source_correlation.enabled is False
    items = [
        _item("c1", "srcA", 1_000_000, EntityType.IP, "9.9.9.9"),
        _item("c2", "srcB", 1_000_500, EntityType.IP, "9.9.9.9"),
    ]
    assert cross_source_correlate(items, prefs) == []


def test_cross_source_links_shared_ip_across_two_sources():
    """Two open cases from DIFFERENT sources sharing an IP inside the window group."""
    prefs = _xsrc_prefs(enabled=True, time_window_seconds=300, min_sources=2)
    base = 1_700_000_000_000
    items = [
        _item("c1", "srcA", base, EntityType.IP, "9.9.9.9"),
        _item("c2", "srcB", base + 60_000, EntityType.IP, "9.9.9.9"),
    ]
    groups = cross_source_correlate(items, prefs)
    assert len(groups) == 1
    g = groups[0]
    assert set(g["members"]) == {"c1", "c2"}
    assert g["entity_type"] == "ip"
    assert g["entity_value"] == "9.9.9.9"
    assert g["cross_source_cluster_id"]


def test_cross_source_ignores_different_entities():
    """Cases that DON'T share an entity are never grouped."""
    prefs = _xsrc_prefs(enabled=True, time_window_seconds=300, min_sources=2)
    base = 1_700_000_000_000
    items = [
        _item("c1", "srcA", base, EntityType.IP, "1.1.1.1"),
        _item("c2", "srcB", base, EntityType.IP, "2.2.2.2"),
    ]
    assert cross_source_correlate(items, prefs) == []


def test_cross_source_respects_min_sources():
    """A shared entity within ONE source does not self-link (min_sources=2)."""
    prefs = _xsrc_prefs(enabled=True, time_window_seconds=300, min_sources=2)
    base = 1_700_000_000_000
    items = [
        _item("c1", "srcA", base, EntityType.IP, "9.9.9.9"),
        _item("c2", "srcA", base + 1000, EntityType.IP, "9.9.9.9"),
    ]
    assert cross_source_correlate(items, prefs) == []
    # Raising min_sources to 3 suppresses a 2-source group too.
    prefs3 = _xsrc_prefs(enabled=True, time_window_seconds=300, min_sources=3)
    items3 = [
        _item("c1", "srcA", base, EntityType.IP, "9.9.9.9"),
        _item("c2", "srcB", base + 1000, EntityType.IP, "9.9.9.9"),
    ]
    assert cross_source_correlate(items3, prefs3) == []


def test_cross_source_respects_time_window():
    """Activity in different time buckets (far apart) does not cross-link."""
    prefs = _xsrc_prefs(enabled=True, time_window_seconds=300, min_sources=2)
    base = 1_700_000_000_000
    items = [
        _item("c1", "srcA", base, EntityType.IP, "9.9.9.9"),
        # 10 minutes later → a different 300s bucket → no group.
        _item("c2", "srcB", base + 600_000, EntityType.IP, "9.9.9.9"),
    ]
    assert cross_source_correlate(items, prefs) == []


def test_cross_source_signature_is_source_agnostic_and_idempotent():
    """The group id ignores source, is stable for the same (entity, bucket), and
    differs across distinct entities/buckets."""
    base = 1_700_000_000_000
    a = cross_source_signature(EntityType.IP, "9.9.9.9", base, 300)
    b = cross_source_signature(EntityType.IP, "9.9.9.9", base + 1000, 300)  # same bucket
    assert a == b  # idempotent within a window bucket (source-agnostic by construction)
    # A different entity yields a different id.
    assert cross_source_signature(EntityType.IP, "8.8.8.8", base, 300) != a
    # A different time bucket yields a different id.
    far = cross_source_signature(EntityType.IP, "9.9.9.9", base + 600_000, 300)
    assert far != a
    # Accepts a plain string entity type too.
    assert cross_source_signature("ip", "9.9.9.9", base, 300) == a


def test_cluster_cross_source_entities_includes_primary_and_member_keys():
    """A cluster grouped by IP still contributes its member events' file_hash/domain
    to the cross-source pass (richer keys than the primary entity alone)."""
    base = 1_700_000_000_000
    members = [
        RawEvent(
            id=f"e{i}", index="ix",
            source={"file": {"hash": {"sha256": "ABCDEF"}}, "url": {"domain": "evil.test"}},
            timestamp_millis=base + i, ip="9.9.9.9", rule="r", severity=5.0,
        )
        for i in range(2)
    ]
    cluster = correlate(
        members, _prefs(r=CorrelationRule(mode=CorrelationMode.EVERY, group_by=EntityType.IP))
    )[0]
    keys = cluster_cross_source_entities(
        cluster, [EntityType.IP, EntityType.FILE_HASH, EntityType.DOMAIN]
    )
    assert (EntityType.IP, "9.9.9.9") in keys
    assert (EntityType.FILE_HASH, "abcdef") in keys  # lowercased
    assert (EntityType.DOMAIN, "evil.test") in keys


def test_default_single_source_correlation_is_byte_identical():
    """REGRESSION: with the default config (cross-source OFF), the single-source
    correlate path is unchanged — same cluster count, entity, signature and the new
    cross-source fields are empty/defaulted."""
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip="10.0.0.9", ts_millis=base + i * 1000) for i in range(5)]
    clusters = correlate(events, _prefs())
    assert len(clusters) == 1
    c = clusters[0]
    assert c.entity.type == EntityType.IP and c.entity.value == "10.0.0.9"
    assert c.count == 5
    # New additive cross-source fields default to empty — no behaviour change.
    assert c.cross_source_cluster_id == ""
    assert c.source_ids == []  # no source_id on these events
