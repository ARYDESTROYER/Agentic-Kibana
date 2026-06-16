"""Builders for the standard Elasticsearch query shapes the suite issues.

Centralising query construction means (a) the real and in-memory clients
interpret identical structures, (b) the cost gate's query-time severity/rule
filtering lives in one auditable place (Section 6.3 #1), and (c) the durable
cursor's inclusive lower bound is applied consistently (Section 6.1).
"""

from __future__ import annotations

from typing import Any

from ..config import Preferences
from ..models import Cursor


def scope_filters(prefs: Preferences) -> list[dict[str, Any]]:
    """Free, query-time filtering: only above-threshold, in-scope events.

    This is layer 1 of the cost gate (Section 6.3): below-threshold or
    out-of-scope events never leave Elasticsearch.
    """
    filters: list[dict[str, Any]] = []
    if prefs.severity_threshold and prefs.severity_threshold > 0:
        filters.append({"range": {prefs.severity_field: {"gte": prefs.severity_threshold}}})
    if prefs.in_scope_rules:
        filters.append({"terms": {prefs.rule_field: list(prefs.in_scope_rules)}})
    return filters


def scope_must_not(prefs: Preferences) -> list[dict[str, Any]]:
    must_not: list[dict[str, Any]] = []
    if prefs.excluded_rules:
        must_not.append({"terms": {prefs.rule_field: list(prefs.excluded_rules)}})
    # Suppression rules (free dedup/suppression layer of the cost gate).
    for rule in prefs.suppression_rules:
        must_not.append({"term": {rule.field: rule.value}})
    return must_not


def poll_query(
    prefs: Preferences,
    cursor: Cursor,
    cold_start_from_millis: int,
    batch_size: int | None = None,
) -> dict[str, Any]:
    """Body for one polling batch: above-threshold, in-scope events at or after
    the cursor, oldest first. Sorted by time only (``@timestamp`` has doc_values;
    sorting on ``_id`` does not). Same-millisecond dedup is handled by the cursor
    boundary, not by a sort tiebreaker."""
    lower_bound = cursor.timestamp_millis if cursor.is_set() else cold_start_from_millis
    filters = scope_filters(prefs)
    filters.append({"range": {prefs.time_field: {"gte": lower_bound, "format": "epoch_millis"}}})
    body: dict[str, Any] = {
        "size": batch_size or prefs.poll_batch_size,
        "sort": [{prefs.time_field: {"order": "asc"}}],
        "query": {"bool": {"filter": filters, "must_not": scope_must_not(prefs)}},
        "track_total_hits": False,
    }
    return body


def entity_query(
    prefs: Preferences,
    field: str,
    value: str,
    from_millis: int | None = None,
    to_millis: int | None = None,
    size: int = 100,
    extra_filters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Fetch events for an entity (used by evidence gathering / chat)."""
    filters: list[dict[str, Any]] = [{"term": {field: value}}]
    if from_millis is not None or to_millis is not None:
        rng: dict[str, Any] = {"format": "epoch_millis"}
        if from_millis is not None:
            rng["gte"] = from_millis
        if to_millis is not None:
            rng["lte"] = to_millis
        filters.append({"range": {prefs.time_field: rng}})
    if extra_filters:
        filters.extend(extra_filters)
    return {
        "size": size,
        "sort": [{prefs.time_field: {"order": "desc"}}],
        "query": {"bool": {"filter": filters}},
    }


def ids_query(ids: list[str], size: int | None = None) -> dict[str, Any]:
    """Fetch specific events by document id (Surface 2 row click)."""
    return {
        "size": size or max(1, len(ids)),
        "query": {"ids": {"values": list(ids)}},
    }


def standup_aggregations(prefs: Preferences, from_millis: int, to_millis: int) -> dict[str, Any]:
    """Deterministic 24h aggregate (Surface 4) — never raw logs to a model."""
    base_filter = scope_filters(prefs)
    base_filter.append(
        {"range": {prefs.time_field: {"gte": from_millis, "lte": to_millis, "format": "epoch_millis"}}}
    )
    return {
        "size": 0,
        "query": {"bool": {"filter": base_filter, "must_not": scope_must_not(prefs)}},
        "aggs": {
            "by_rule": {"terms": {"field": prefs.rule_field, "size": 20}},
            "by_severity": {"terms": {"field": prefs.severity_field, "size": 10}},
            "top_source_ips": {"terms": {"field": prefs.source_ip_field, "size": 10}},
            "top_users": {"terms": {"field": prefs.user_field, "size": 10}},
            "top_hosts": {"terms": {"field": prefs.host_field, "size": 10}},
            "unique_ips": {"cardinality": {"field": prefs.source_ip_field}},
            "events_over_time": {
                "date_histogram": {
                    "field": prefs.time_field,
                    "fixed_interval": "1h",
                }
            },
        },
    }
