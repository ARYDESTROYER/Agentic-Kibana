"""Offline tests for DETERMINISTIC playbook selection.

Builds clusters via ``cluster_from_events`` + ``make_raw_event`` (no ES/LLM) and
constructs ``Playbook`` objects directly from manifests (no files needed).
"""

from __future__ import annotations

from pathlib import Path

from app.constants import EntityType
from app.engine.correlation import cluster_from_events
from app.playbooks import (
    Playbook,
    PlaybookManifest,
    PlaybookMatch,
    load_playbooks,
    select_playbook,
)
from tests.conftest import make_raw_event


def _cluster(rule: str = "mail_auth", n: int = 5, entity_type: EntityType = EntityType.IP,
             value: str = "203.0.113.10"):
    base = 1_700_000_000_000
    events = [
        make_raw_event(id=f"e{i}", ip=value, rule=rule, ts_millis=base + i * 1000)
        for i in range(n)
    ]
    return cluster_from_events(entity_type, value, events)


def _pb(id_: str, *, rule_ids=None, entity_types=None, min_event_count=None,
        priority=0, version=1, mitre=None, any_tags=None) -> Playbook:
    return Playbook(
        manifest=PlaybookManifest(
            id=id_,
            name=id_,
            priority=priority,
            version=version,
            match=PlaybookMatch(
                rule_ids=rule_ids or [],
                entity_types=entity_types or [],
                min_event_count=min_event_count,
                mitre=mitre or [],
                any_tags=any_tags or [],
            ),
        ),
        body="",
    )


def test_brute_force_playbook_selected_for_mail_cluster() -> None:
    cluster = _cluster(rule="mail_auth", n=5)
    bf = _pb("mail_bruteforce", rule_ids=["mail_auth", "waf_auth"], min_event_count=3)
    pb, reason = select_playbook(cluster, [bf])
    assert pb is bf
    assert "mail_auth" in reason and "priority=0" in reason


def test_no_match_returns_sentinel() -> None:
    cluster = _cluster(rule="ml_stats", n=5)
    bf = _pb("mail_bruteforce", rule_ids=["mail_auth", "waf_auth"])
    pb, reason = select_playbook(cluster, [bf])
    assert pb is None
    assert reason == "no_playbook_matched"


def test_min_event_count_below_threshold_no_match() -> None:
    cluster = _cluster(rule="mail_auth", n=2)
    bf = _pb("mail_bruteforce", rule_ids=["mail_auth"], min_event_count=3)
    pb, reason = select_playbook(cluster, [bf])
    assert pb is None and reason == "no_playbook_matched"


def test_entity_type_constrains() -> None:
    # A USER cluster must not match a playbook scoped to ip/host only.
    cluster = _cluster(rule="mail_auth", n=5, entity_type=EntityType.USER, value="alice")
    only_ip = _pb("ip_only", rule_ids=["mail_auth"], entity_types=["ip", "host"])
    also_user = _pb("user_ok", rule_ids=["mail_auth"], entity_types=["user"])
    assert select_playbook(cluster, [only_ip])[0] is None
    assert select_playbook(cluster, [also_user])[0] is also_user


def test_unconstrained_playbook_always_matches() -> None:
    # A playbook with no criteria matches anything.
    cluster = _cluster(rule="anything", n=1)
    wild = _pb("catch_all")
    pb, reason = select_playbook(cluster, [wild])
    assert pb is wild and "matched" in reason


def test_ties_resolve_priority_then_version_then_id() -> None:
    cluster = _cluster(rule="mail_auth", n=5)
    low = _pb("a_low", rule_ids=["mail_auth"], priority=10)
    high = _pb("b_high", rule_ids=["mail_auth"], priority=50)
    pb, reason = select_playbook(cluster, [low, high])
    assert pb is high and "priority=50" in reason

    # Equal priority → higher version wins.
    v1 = _pb("a_v1", rule_ids=["mail_auth"], priority=50, version=1)
    v2 = _pb("b_v2", rule_ids=["mail_auth"], priority=50, version=2)
    assert select_playbook(cluster, [v1, v2])[0] is v2

    # Equal priority + version → lexicographically smallest id wins.
    z = _pb("z_id", rule_ids=["mail_auth"], priority=50, version=2)
    a = _pb("a_id", rule_ids=["mail_auth"], priority=50, version=2)
    assert select_playbook(cluster, [z, a])[0] is a


def test_mitre_matches_opportunistically_against_rule_names() -> None:
    # Clusters carry no MITRE pre-investigation; mitre matches rule names.
    cluster = _cluster(rule="T1110", n=3)
    pb = _pb("technique_named", mitre=["T1110"])
    selected, _ = select_playbook(cluster, [pb])
    assert selected is pb
    # And does not match a cluster whose rule is unrelated.
    other = _cluster(rule="mail_auth", n=3)
    assert select_playbook(other, [pb])[0] is None


def test_bundled_cloud_data_and_ransomware_procedures_select_exactly() -> None:
    playbooks = load_playbooks(Path(__file__).resolve().parents[1] / "playbooks")

    expected = {
        "cloud_iam_anomaly": "cloud_identity_compromise",
        "data_exfiltration": "data_exfiltration_response",
        "ransomware_behavior": "ransomware_response",
    }
    for rule_id, playbook_id in expected.items():
        selected, reason = select_playbook(_cluster(rule=rule_id), playbooks)
        assert selected is not None
        assert selected.id == playbook_id
        assert rule_id in reason

    selected, reason = select_playbook(_cluster(rule="unrelated_custom_rule"), playbooks)
    assert selected is None
    assert reason == "no_playbook_matched"
