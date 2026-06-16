"""Deterministic correlation (Section 6.2).

Pure functions, no LLM. Per-rule config decides which entities cross a trigger
(``every`` / ``threshold`` / ``never``); a triggered entity then gathers ALL its
in-scope events in the batch (across rules) into one entity-centric cluster, so
"diversity of rule types hit" is a meaningful, auditable risk input.
"""

from __future__ import annotations

from collections import defaultdict

from ..config import Preferences
from ..constants import CorrelationMode, EntityType
from ..models import Cluster, Entity, RawEvent
from .signatures import cluster_signature


def correlate(events: list[RawEvent], prefs: Preferences) -> list[Cluster]:
    """Group a polled batch into candidate investigations (clusters)."""
    triggered: set[tuple[EntityType, str]] = set()

    by_rule: dict[str, list[RawEvent]] = defaultdict(list)
    for ev in events:
        by_rule[ev.rule or "unknown"].append(ev)

    for rule, rule_events in by_rule.items():
        cfg = prefs.correlation_for(rule)
        if cfg.mode == CorrelationMode.NEVER:
            continue
        group_by = cfg.group_by
        by_entity: dict[str, list[RawEvent]] = defaultdict(list)
        for ev in rule_events:
            val = ev.entity_value(group_by)
            if val:
                by_entity[val].append(ev)
        for value, group in by_entity.items():
            if cfg.mode == CorrelationMode.EVERY:
                triggered.add((group_by, value))
            elif cfg.mode == CorrelationMode.THRESHOLD:
                if _window_breach(group, cfg.n, cfg.window_seconds):
                    triggered.add((group_by, value))

    clusters: list[Cluster] = []
    for entity_type, value in sorted(triggered, key=lambda t: (t[0].value, t[1])):
        members = [ev for ev in events if ev.entity_value(entity_type) == value]
        if members:
            clusters.append(_build_cluster(entity_type, value, members))
    return clusters


def _window_breach(events: list[RawEvent], n: int, window_seconds: int) -> bool:
    """True if any time window of ``window_seconds`` contains >= ``n`` events."""
    if n <= 1:
        return len(events) >= 1
    if len(events) < n:
        return False
    times = sorted(ev.timestamp_millis for ev in events)
    span = window_seconds * 1000
    left = 0
    for right in range(len(times)):
        while times[right] - times[left] > span:
            left += 1
        if right - left + 1 >= n:
            return True
    return False


def cluster_from_events(entity_type: EntityType, value: str, members: list[RawEvent]) -> Cluster:
    """Public builder for ad-hoc clusters (Surface 2 manual investigate)."""
    return _build_cluster(entity_type, value, members)


def _build_cluster(entity_type: EntityType, value: str, members: list[RawEvent]) -> Cluster:
    members_sorted = sorted(members, key=lambda e: e.timestamp_millis)
    rule_values = sorted({ev.rule for ev in members if ev.rule})
    return Cluster(
        signature=cluster_signature(entity_type, value),
        entity=Entity(type=entity_type, value=value),
        group_by=entity_type,
        rule_values=rule_values,
        member_event_ids=[ev.id for ev in members_sorted],
        member_events=members_sorted,
        first_seen_millis=members_sorted[0].timestamp_millis,
        last_seen_millis=members_sorted[-1].timestamp_millis,
        count=len(members_sorted),
    )
