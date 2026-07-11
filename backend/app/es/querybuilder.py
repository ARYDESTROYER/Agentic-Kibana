"""Builders for the standard Elasticsearch query shapes the suite issues.

Centralising query construction means (a) the real and in-memory clients
interpret identical structures, (b) the cost gate's query-time severity/rule
filtering lives in one auditable place (Section 6.3 #1), and (c) the durable
cursor's inclusive lower bound is applied consistently (Section 6.1).
"""

from __future__ import annotations

from typing import Any

from ..config import Preferences
from ..models import Cursor, split_cursor_event_key


# Pull polling intentionally re-opens a small window behind the durable frontier
# so records indexed late can still be observed.  The Cursor's exact recent-id
# ledger prevents replay; both the time window and ledger are bounded.
PULL_LATE_ARRIVAL_OVERLAP_MILLIS = 5 * 60 * 1000
PULL_RECENT_EVENT_LIMIT = 100_000


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
    # Suppression rules (free dedup/suppression layer of the cost gate). Only LIVE
    # rules filter at query time — a disabled or expired rule is skipped (matched by
    # cost_gate.passes_suppression), so toggling enabled/expiry takes effect at once.
    for rule in prefs.suppression_rules:
        if rule.is_live():
            must_not.append({"term": {rule.field: rule.value}})
    return must_not


def poll_query(
    prefs: Preferences,
    cursor: Cursor,
    cold_start_from_millis: int,
    batch_size: int | None = None,
) -> dict[str, Any]:
    """Body for one frontier page, oldest first.

    The bound remains inclusive in semantics, but source-index-qualified ids that
    were already consumed at the exact cursor timestamp are excluded server-side.
    This is what lets a timestamp containing more than one page drain without the
    first page starving every subsequent poll.  A PIT ``_shard_doc`` tie-breaker is
    added by the connector while it drains pages; the base body stays compatible
    with sources that do not support PIT.
    """
    filters = scope_filters(prefs)
    if cursor.is_set():
        newer = {
            "range": {
                prefs.time_field: {
                    "gt": cursor.timestamp_millis,
                    "format": "epoch_millis",
                }
            }
        }
        at_boundary: dict[str, Any] = {
            "range": {
                prefs.time_field: {
                    "gte": cursor.timestamp_millis,
                    "lte": cursor.timestamp_millis,
                    "format": "epoch_millis",
                }
            }
        }
        boundary_branch: dict[str, Any] = at_boundary
        exclusions = _cursor_key_exclusions(cursor.boundary_ids)
        if exclusions:
            boundary_branch = {
                "bool": {"filter": [at_boundary], "must_not": exclusions}
            }
        filters.append(
            {
                "bool": {
                    "should": [newer, boundary_branch],
                    "minimum_should_match": 1,
                }
            }
        )
    else:
        filters.append(
            {
                "range": {
                    prefs.time_field: {
                        "gte": cold_start_from_millis,
                        "format": "epoch_millis",
                    }
                }
            }
        )
    body: dict[str, Any] = {
        "size": batch_size or prefs.poll_batch_size,
        "sort": [{prefs.time_field: {"order": "asc"}}],
        "query": {"bool": {"filter": filters, "must_not": scope_must_not(prefs)}},
        "track_total_hits": False,
    }
    return body


def late_arrival_query(
    prefs: Preferences,
    cursor: Cursor,
    *,
    batch_size: int | None = None,
    overlap_millis: int = PULL_LATE_ARRIVAL_OVERLAP_MILLIS,
) -> dict[str, Any] | None:
    """Body for the bounded window strictly *behind* the durable frontier.

    Already-observed source-index-qualified ids are excluded at the source.  The
    caller still applies ``Cursor.should_skip`` as the correctness backstop.  A
    saturated ledger disables this optional pass rather than risking duplicate
    replay; the primary frontier remains fully operational.
    """
    if (
        not cursor.is_set()
        or overlap_millis <= 0
        or cursor.overlap_saturated
        or not cursor.late_arrival_overlap_enabled
    ):
        return None
    lower = max(0, cursor.timestamp_millis - overlap_millis)
    filters = scope_filters(prefs)
    filters.append(
        {
            "range": {
                prefs.time_field: {
                    "gte": lower,
                    "lt": cursor.timestamp_millis,
                    "format": "epoch_millis",
                }
            }
        }
    )
    must_not = scope_must_not(prefs)
    must_not.extend(_cursor_key_exclusions(cursor.recent_event_millis))
    return {
        "size": batch_size or prefs.poll_batch_size,
        "sort": [{prefs.time_field: {"order": "asc"}}],
        "query": {"bool": {"filter": filters, "must_not": must_not}},
        "track_total_hits": False,
    }


def _cursor_key_exclusions(keys: Any) -> list[dict[str, Any]]:
    """Build index-scoped ``ids`` exclusions from new and legacy cursor keys."""
    grouped: dict[str, list[str]] = {}
    legacy: list[str] = []
    for raw in keys or ():
        index, event_id = split_cursor_event_key(str(raw))
        if not event_id:
            continue
        if index is None:
            legacy.append(event_id)
        else:
            grouped.setdefault(index, []).append(event_id)

    clauses: list[dict[str, Any]] = []
    if legacy:
        clauses.append({"ids": {"values": list(dict.fromkeys(legacy))}})
    for index, event_ids in grouped.items():
        clauses.append(
            {
                "bool": {
                    "filter": [
                        {"term": {"_index": index}},
                        {"ids": {"values": list(dict.fromkeys(event_ids))}},
                    ]
                }
            }
        )
    return clauses


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
