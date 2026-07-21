"""Token & cost ledger store (Section 7.3) + the in-plugin cost panel reader.

The ledger is WRITTEN in exactly one place — the LLM gateway — guaranteeing no
call escapes it (Non-negotiable #6). The window summary that feeds the cost panel
AND the BudgetGate is computed with a single ES ``sum`` aggregation so it is EXACT
regardless of row count: the old size-capped (10 000-doc) hit fetch silently
under-counted monthly / high-volume-daily spend, which defeated the budget
ceiling. On a backend whose ``search`` does not compute ``sum`` aggregations (the
in-memory test fake) the code transparently falls back to a *paginated* hit-scan
that has NO 10 000-row cap, so the two backends report identical totals.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from typing import Any

from ..constants import USAGE_READ_PATTERN, USAGE_WRITE_ALIAS
from ..es.base import BaseESClient
from ..models import UsageDoc
from ..utils import now_utc, parse_es_timestamp, to_millis
from .base import UsageRepository

logger = logging.getLogger("tlsoc.usage")

# Page size for the fallback hit-scan (used only when the backend cannot compute
# the ``sum`` aggregation — i.e. the in-memory test fake). It must stay <= the ES
# ``max_result_window`` (10 000) so a real cluster taking this path (it never does
# — real ES always returns the aggregation) would still page legally.
_SCAN_PAGE = 10000


class UsageStore(UsageRepository):
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def write(self, doc: UsageDoc) -> None:
        try:
            await self._es.index_doc(USAGE_WRITE_ALIAS, doc.model_dump(mode="json"))
        except Exception as exc:  # noqa: BLE001
            logger.error("USAGE WRITE FAILED (role=%s model=%s): %s", doc.role, doc.model, exc)

    async def records(self, *, limit: int = 1000) -> list[dict[str, Any]]:
        """Newest-first bounded ledger rows for the privileged data export."""
        cap = max(1, min(int(limit or 1000), 5000))
        try:
            resp = await self._es.search(
                USAGE_READ_PATTERN,
                {
                    "size": cap,
                    "query": {"match_all": {}},
                    "sort": [{"ts": {"order": "desc"}}],
                },
            )
            return [h.get("_source", {}) or {} for h in resp.get("hits", {}).get("hits", [])]
        except Exception as exc:  # noqa: BLE001 — export degrades per scope
            logger.warning("usage records read failed: %s", exc)
            return []

    async def summary(self, window_hours: int = 24, case_id: str | None = None) -> dict[str, Any]:
        now = now_utc()
        from_millis = to_millis(now) - window_hours * 3600 * 1000
        today_start_millis = to_millis(now.replace(hour=0, minute=0, second=0, microsecond=0))

        filters: list[dict[str, Any]] = [
            {"range": {"ts": {"gte": from_millis, "format": "epoch_millis"}}}
        ]
        if case_id:
            filters.append({"term": {"case_id": case_id}})
        query = {"bool": {"filter": filters}}

        # Pass 1 — the exact, unbounded aggregation. ``size:0`` + ``sum`` aggs mean
        # the total is computed over EVERY matching row (no 10 000-doc truncation),
        # so a 30-day / high-volume window can no longer silently under-count spend
        # and defeat the BudgetGate. ``track_total_hits`` gives the exact call count.
        body = {
            "size": 0,
            "track_total_hits": True,
            "query": query,
            "aggs": {
                "total_cost": {"sum": {"field": "cost"}},
                "total_tokens": {"sum": {"field": "total_tokens"}},
                "today_cost": {
                    "filter": {"range": {"ts": {"gte": today_start_millis,
                                                "format": "epoch_millis"}}},
                    "aggs": {"cost": {"sum": {"field": "cost"}}},
                },
                "by_surface": _terms_agg("surface"),
                "by_model": _terms_agg("model"),
                "by_role": _terms_agg("role"),
                "cost_over_time": {
                    "date_histogram": {"field": "ts", "calendar_interval": "hour"},
                    "aggs": {"cost": {"sum": {"field": "cost"}}},
                },
            },
        }
        try:
            resp = await self._es.search(USAGE_READ_PATTERN, body)
        except Exception as exc:  # noqa: BLE001
            logger.warning("usage summary search failed: %s", exc)
            return _empty_summary(window_hours)

        aggs = resp.get("aggregations") or {}
        if _has_sum_aggs(aggs):
            return _summary_from_aggs(window_hours, resp, aggs)

        # Pass 2 — fallback for a backend whose ``search`` does not compute ``sum``
        # aggregations (the in-memory test fake). Page through EVERY matching row
        # (no 10 000-doc cap) and sum in Python — identical numbers, just slower.
        try:
            sources = await self._scan_all(query)
        except Exception as exc:  # noqa: BLE001
            logger.warning("usage summary scan failed: %s", exc)
            return _empty_summary(window_hours)
        return _summary_from_sources(window_hours, sources, today_start_millis)

    async def _scan_all(self, query: dict[str, Any]) -> list[dict[str, Any]]:
        """Page through every ``_source`` matching ``query`` with no row cap, ordered
        by ``ts`` asc. Only taken on the aggregation-less fallback backend."""
        sources: list[dict[str, Any]] = []
        frm = 0
        while True:
            page = await self._es.search(
                USAGE_READ_PATTERN,
                {"size": _SCAN_PAGE, "from": frm, "query": query,
                 "sort": [{"ts": {"order": "asc"}}]},
            )
            hits = page.get("hits", {}).get("hits", [])
            if not hits:
                break
            sources.extend(h.get("_source", {}) for h in hits)
            if len(hits) < _SCAN_PAGE:
                break
            frm += _SCAN_PAGE
        return sources


def _terms_agg(field: str) -> dict[str, Any]:
    """A terms bucket over ``field`` with per-bucket cost + token sums. ``size`` is
    generous so the top-N slice in ``_top()`` (10/5) is computed from a complete set
    of high-cost buckets, not a truncated one."""
    return {
        "terms": {"field": field, "size": 1000, "missing": "unknown"},
        "aggs": {
            "cost": {"sum": {"field": "cost"}},
            "tokens": {"sum": {"field": "total_tokens"}},
        },
    }


def _has_sum_aggs(aggs: dict[str, Any]) -> bool:
    """True when the backend actually computed the ``sum`` aggregations (real ES).
    The in-memory fake returns no aggregations for ``sum``/nested aggs, so this is
    False there and the caller takes the paginated-scan fallback."""
    total = aggs.get("total_cost")
    return isinstance(total, dict) and "value" in total


def _summary_from_aggs(window_hours: int, resp: dict[str, Any],
                       aggs: dict[str, Any]) -> dict[str, Any]:
    """Build the panel summary from the exact ES aggregation result (no row cap)."""
    total_cost = float((aggs.get("total_cost") or {}).get("value", 0.0) or 0.0)
    total_tokens = int((aggs.get("total_tokens") or {}).get("value", 0) or 0)
    today_cost = float(((aggs.get("today_cost") or {}).get("cost") or {}).get("value", 0.0) or 0.0)
    call_count = int(resp.get("hits", {}).get("total", {}).get("value", 0) or 0)

    over_time = [
        {"ts": int(b.get("key", 0)), "cost": round(float((b.get("cost") or {}).get("value", 0.0) or 0.0), 6)}
        for b in (aggs.get("cost_over_time") or {}).get("buckets", [])
    ]
    return {
        "window_hours": window_hours,
        "total_cost": round(total_cost, 6),
        "total_tokens": total_tokens,
        "today_cost": round(today_cost, 6),
        "call_count": call_count,
        "currency": "USD",
        "by_surface": _top_from_buckets(aggs.get("by_surface")),
        "by_model": _top_from_buckets(aggs.get("by_model")),
        "by_role": _top_from_buckets(aggs.get("by_role")),
        "cost_over_time": over_time,
        "top_cost_drivers": _top_from_buckets(aggs.get("by_model"), limit=5),
    }


def _top_from_buckets(agg: Any, limit: int = 10) -> list[dict[str, Any]]:
    buckets = (agg or {}).get("buckets", []) if isinstance(agg, dict) else []
    rows = [
        {
            "key": str(b.get("key", "unknown")),
            "cost": round(float((b.get("cost") or {}).get("value", 0.0) or 0.0), 6),
            "tokens": int((b.get("tokens") or {}).get("value", 0) or 0),
            "calls": int(b.get("doc_count", 0) or 0),
        }
        for b in buckets
    ]
    rows.sort(key=lambda r: r["cost"], reverse=True)
    return rows[:limit]


def _summary_from_sources(window_hours: int, sources: list[dict[str, Any]],
                          today_start_millis: int) -> dict[str, Any]:
    """Sum every scanned ``_source`` in Python (aggregation-less fallback backend).
    Byte-equivalent to the old hit loop, just without the 10 000-doc truncation."""
    total_cost = 0.0
    total_tokens = 0
    today_cost = 0.0
    by_surface: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
    by_model: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
    by_role: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
    over_time: dict[int, float] = defaultdict(float)

    for src in sources:
        cost = float(src.get("cost", 0.0) or 0.0)
        tokens = int(src.get("total_tokens", 0) or 0)
        total_cost += cost
        total_tokens += tokens
        ts = parse_es_timestamp(src.get("ts"))
        ts_millis = to_millis(ts) if ts else 0
        if ts_millis >= today_start_millis:
            today_cost += cost
        for bucket, key in (
            (by_surface, src.get("surface", "unknown")),
            (by_model, src.get("model", "unknown")),
            (by_role, src.get("role", "unknown")),
        ):
            bucket[key]["cost"] += cost
            bucket[key]["tokens"] += tokens
            bucket[key]["calls"] += 1
        hour = (ts_millis // 3_600_000) * 3_600_000
        over_time[hour] += cost

    return {
        "window_hours": window_hours,
        "total_cost": round(total_cost, 6),
        "total_tokens": total_tokens,
        "today_cost": round(today_cost, 6),
        "call_count": len(sources),
        "currency": "USD",
        "by_surface": _top(by_surface),
        "by_model": _top(by_model),
        "by_role": _top(by_role),
        "cost_over_time": [
            {"ts": k, "cost": round(v, 6)} for k, v in sorted(over_time.items())
        ],
        "top_cost_drivers": _top(by_model, limit=5),
    }


def _top(bucket: dict[str, dict[str, float]], limit: int = 10) -> list[dict[str, Any]]:
    rows = [
        {"key": k, "cost": round(v["cost"], 6), "tokens": int(v["tokens"]), "calls": int(v["calls"])}
        for k, v in bucket.items()
    ]
    rows.sort(key=lambda r: r["cost"], reverse=True)
    return rows[:limit]


def _empty_summary(window_hours: int) -> dict[str, Any]:
    return {
        "window_hours": window_hours,
        "total_cost": 0.0,
        "total_tokens": 0,
        "today_cost": 0.0,
        "call_count": 0,
        "currency": "USD",
        "by_surface": [],
        "by_model": [],
        "by_role": [],
        "cost_over_time": [],
        "top_cost_drivers": [],
    }
