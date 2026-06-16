"""Deterministic risk scoring (Section 6.2)."""

from __future__ import annotations

from app.config import Preferences
from app.constants import EntityType
from app.engine.correlation import cluster_from_events
from app.engine.risk import compute_risk
from tests.conftest import make_raw_event


def _cluster(n: int, rules: list[str] | None = None, span_ms: int = 10_000):
    base = 1_700_000_000_000
    rules = rules or ["linux_auth"]
    events = []
    for i in range(n):
        events.append(make_raw_event(
            id=f"e{i}", ip="9.9.9.9", rule=rules[i % len(rules)],
            ts_millis=base + int(i * span_ms / max(1, n)),
        ))
    return cluster_from_events(EntityType.IP, "9.9.9.9", events)


def test_risk_in_range_and_deterministic():
    p = Preferences()
    c = _cluster(10)
    r1 = compute_risk(c, p, reputation=0.0)
    r2 = compute_risk(c, p, reputation=0.0)
    assert r1 == r2
    assert 0.0 <= r1.total <= 100.0


def test_more_volume_increases_score():
    p = Preferences()
    low = compute_risk(_cluster(3), p, 0.0).total
    high = compute_risk(_cluster(40), p, 0.0).total
    assert high > low


def test_reputation_raises_score():
    p = Preferences()
    clean = compute_risk(_cluster(5), p, reputation=0.0).total
    dirty = compute_risk(_cluster(5), p, reputation=95.0).total
    assert dirty > clean


def test_rule_diversity_raises_score():
    p = Preferences()
    one = compute_risk(_cluster(6, rules=["r1"]), p, 0.0)
    many = compute_risk(_cluster(6, rules=["r1", "r2", "r3", "r4"]), p, 0.0)
    assert many.diversity > one.diversity


def test_asset_criticality_applied():
    p = Preferences()
    p.asset_criticality = {"9.9.9.9": 100.0}
    r = compute_risk(_cluster(5), p, 0.0)
    assert r.asset_criticality == 100.0
