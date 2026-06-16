"""Deterministic correlation (Section 6.2).

Pure functions, no LLM. Per-rule config decides which entities cross a trigger
(``every`` / ``threshold`` / ``never``); a triggered entity then gathers ALL its
in-scope events in the batch (across rules) into one entity-centric cluster, so
"diversity of rule types hit" is a meaningful, auditable risk input.

It also records a deterministic ``TriggerReason`` (Feature 3) explaining WHY each
cluster fired (the primary triggering rule + matched window), surfaced in the UI.
"""

from __future__ import annotations

from collections import defaultdict
from typing import NamedTuple

from ..config import CorrelationRule, Preferences
from ..constants import CorrelationMode, EntityType
from ..models import Cluster, Entity, RawEvent, TriggerReason
from .signatures import cluster_signature


class _WindowDetail(NamedTuple):
    observed_count: int
    window_start: int
    window_end: int


def correlate(events: list[RawEvent], prefs: Preferences) -> list[Cluster]:
    """Group a polled batch into candidate investigations (clusters)."""
    # (entity_type, value) -> the PRIMARY triggering rule's metadata.
    triggers: dict[tuple[EntityType, str], dict] = {}

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
            detail = _window_detail(group, cfg)
            if detail is None:
                continue
            sev = [g.severity for g in group if g.severity is not None]
            meta = {
                "rule_value": rule,
                "mode": cfg.mode.value,
                "n": cfg.n,
                "window_seconds": cfg.window_seconds,
                "group_by": group_by.value,
                "observed_count": detail.observed_count,
                "window_start": detail.window_start,
                "window_end": detail.window_end,
                "severity_min": min(sev) if sev else None,
                "severity_max": max(sev) if sev else None,
            }
            key = (group_by, value)
            # Keep the PRIMARY rule (highest observed_count) for multi-rule entities.
            if key not in triggers or detail.observed_count > triggers[key]["observed_count"]:
                triggers[key] = meta

    clusters: list[Cluster] = []
    for (entity_type, value), meta in sorted(triggers.items(), key=lambda t: (t[0][0].value, t[0][1])):
        members = [ev for ev in events if ev.entity_value(entity_type) == value]
        if members:
            clusters.append(_build_cluster(entity_type, value, members, meta))
    return clusters


def _window_detail(events: list[RawEvent], cfg: CorrelationRule) -> _WindowDetail | None:
    """Return the matched-window detail if the rule triggers, else None.

    For ``every`` (or n<=1) any occurrence triggers; the window is the span of the
    entity's events for that rule. For ``threshold`` it is the densest window with
    >= n events.
    """
    if not events:
        return None
    times = sorted(ev.timestamp_millis for ev in events)
    if cfg.mode == CorrelationMode.EVERY or cfg.n <= 1:
        return _WindowDetail(len(events), times[0], times[-1])
    if len(events) < cfg.n:
        return None
    span = cfg.window_seconds * 1000
    best: _WindowDetail | None = None
    left = 0
    for right in range(len(times)):
        while times[right] - times[left] > span:
            left += 1
        count = right - left + 1
        if count >= cfg.n and (best is None or count > best.observed_count):
            best = _WindowDetail(count, times[left], times[right])
    return best


def _window_breach(events: list[RawEvent], n: int, window_seconds: int) -> bool:
    """Backwards-compatible bool wrapper over ``_window_detail``."""
    cfg = CorrelationRule(mode=CorrelationMode.THRESHOLD, n=max(1, n),
                          window_seconds=max(1, window_seconds))
    if n <= 1:
        return len(events) >= 1
    return _window_detail(events, cfg) is not None


def cluster_from_events(entity_type: EntityType, value: str, members: list[RawEvent]) -> Cluster:
    """Public builder for ad-hoc clusters (Surface 2 manual investigate)."""
    return _build_cluster(entity_type, value, members, None)


def _build_cluster(
    entity_type: EntityType,
    value: str,
    members: list[RawEvent],
    trigger_meta: dict | None,
) -> Cluster:
    members_sorted = sorted(members, key=lambda e: e.timestamp_millis)
    rule_values = sorted({ev.rule for ev in members if ev.rule})
    trigger_reason = _build_trigger_reason(entity_type, value, rule_values, trigger_meta)
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
        trigger_reason=trigger_reason,
    )


def _build_trigger_reason(
    entity_type: EntityType, value: str, rule_values: list[str], meta: dict | None
) -> TriggerReason | None:
    if not meta:
        return None
    mode = meta["mode"]
    n = meta["n"]
    window_s = meta["window_seconds"]
    count = meta["observed_count"]
    rule = meta["rule_value"]
    smin, smax = meta.get("severity_min"), meta.get("severity_max")

    if mode == CorrelationMode.THRESHOLD.value:
        sentence = (
            f"{count} '{rule}' events from {entity_type.value} {value} within {window_s}s "
            f"(threshold N={n}, grouped by {meta['group_by']})"
        )
    elif mode == CorrelationMode.EVERY.value:
        sentence = (
            f"'{rule}' event from {entity_type.value} {value} "
            f"(rule configured to investigate every occurrence)"
        )
    else:
        sentence = f"{count} '{rule}' events from {entity_type.value} {value}"
    if smin is not None and smax is not None and (smin or smax):
        sentence += f"; severity {smin:g}–{smax:g}"

    return TriggerReason(
        rule_value=rule,
        mode=mode,
        n=n,
        window_seconds=window_s,
        group_by=meta["group_by"],
        observed_count=count,
        window_start=meta["window_start"],
        window_end=meta["window_end"],
        entity=f"{entity_type.value}:{value}",
        rule_values=rule_values,
        severity_min=smin,
        severity_max=smax,
        sentence=sentence,
    )
