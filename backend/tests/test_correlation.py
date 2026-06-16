"""Correlation is deterministic, windowed, and entity-centric (Section 6.2)."""

from __future__ import annotations

from app.config import CorrelationRule, Preferences
from app.constants import CorrelationMode, EntityType
from app.engine.correlation import correlate
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
