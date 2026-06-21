"""Token & cost ledger store (Section 7.3) + the in-plugin cost panel reader.

The ledger is WRITTEN in exactly one place — the LLM gateway — guaranteeing no
call escapes it (Non-negotiable #6). Summaries for the in-plugin panel are
computed in Python over the window's documents (POC volumes are modest); the
deep, sliced views live in the native Kibana cost dashboard.
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


class UsageStore(UsageRepository):
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def write(self, doc: UsageDoc) -> None:
        try:
            await self._es.index_doc(USAGE_WRITE_ALIAS, doc.model_dump(mode="json"))
        except Exception as exc:  # noqa: BLE001
            logger.error("USAGE WRITE FAILED (role=%s model=%s): %s", doc.role, doc.model, exc)

    async def summary(self, window_hours: int = 24, case_id: str | None = None) -> dict[str, Any]:
        now = now_utc()
        from_millis = to_millis(now) - window_hours * 3600 * 1000
        today_start_millis = to_millis(now.replace(hour=0, minute=0, second=0, microsecond=0))

        filters: list[dict[str, Any]] = [
            {"range": {"ts": {"gte": from_millis, "format": "epoch_millis"}}}
        ]
        if case_id:
            filters.append({"term": {"case_id": case_id}})
        body = {"size": 10000, "query": {"bool": {"filter": filters}},
                "sort": [{"ts": {"order": "asc"}}]}
        try:
            resp = await self._es.search(USAGE_READ_PATTERN, body)
        except Exception as exc:  # noqa: BLE001
            logger.warning("usage summary search failed: %s", exc)
            return _empty_summary(window_hours)

        hits = resp.get("hits", {}).get("hits", [])
        total_cost = 0.0
        total_tokens = 0
        today_cost = 0.0
        by_surface: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
        by_model: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
        by_role: dict[str, dict[str, float]] = defaultdict(lambda: {"cost": 0.0, "tokens": 0, "calls": 0})
        over_time: dict[int, float] = defaultdict(float)

        for hit in hits:
            src = hit.get("_source", {})
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
            "call_count": len(hits),
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
