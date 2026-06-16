"""Daily standup (Surface 4, Section 8.4 / Non-negotiable #7).

Aggregate first in Elasticsearch (near-free, no LLM), then send ONLY the compact
JSON aggregate to the cheap model for prose. Raw logs are NEVER fed to a model.
Fully disableable; on model failure it returns a deterministic text fallback.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from ..audit.audit_log import AuditLogger
from ..config import Preferences
from ..constants import CASES_READ_PATTERN, ActionType, Role
from ..es.base import BaseESClient
from ..es.querybuilder import standup_aggregations
from ..llm.gateway import GatewayError, LLMGateway
from ..utils import iso_now, now_utc, to_millis

logger = logging.getLogger("tlsoc.agents.standup")


class StandupService:
    def __init__(self, es: BaseESClient, gateway: LLMGateway, audit: AuditLogger) -> None:
        self._es = es
        self._gateway = gateway
        self._audit = audit

    async def generate(self, prefs: Preferences, window_hours: int | None = None) -> dict[str, Any]:
        window = window_hours or prefs.standup.window_hours
        now = now_utc()
        to_millis_ = to_millis(now)
        from_millis = to_millis_ - window * 3600 * 1000

        aggregate = await self._aggregate_logs(prefs, from_millis, to_millis_)
        aggregate["window_hours"] = window
        aggregate["cases"] = await self._case_stats(from_millis)

        summary, cost = await self._summarise(aggregate, prefs)
        return {
            "generated_at": iso_now(),
            "window_hours": window,
            "aggregate": aggregate,
            "summary": summary,
            "cost": cost,
        }

    async def _aggregate_logs(self, prefs: Preferences, from_millis: int, to_millis_: int) -> dict[str, Any]:
        body = standup_aggregations(prefs, from_millis, to_millis_)
        try:
            resp = await self._es.search_logs(prefs.data_view_pattern, body)
        except Exception as exc:  # noqa: BLE001
            logger.warning("standup aggregation failed: %s", exc)
            return {"error": str(exc)}
        aggs = resp.get("aggregations", {})
        total = resp.get("hits", {}).get("total", {})
        return {
            "total_events": total.get("value", 0) if isinstance(total, dict) else 0,
            "by_rule": _buckets(aggs.get("by_rule")),
            "by_severity": _buckets(aggs.get("by_severity")),
            "top_source_ips": _buckets(aggs.get("top_source_ips")),
            "top_users": _buckets(aggs.get("top_users")),
            "top_hosts": _buckets(aggs.get("top_hosts")),
            "unique_ips": aggs.get("unique_ips", {}).get("value", 0),
            "events_over_time": _buckets(aggs.get("events_over_time")),
        }

    async def _case_stats(self, from_millis: int) -> dict[str, Any]:
        body = {
            "size": 0,
            "query": {"range": {"created_at": {"gte": from_millis, "format": "epoch_millis"}}},
            "aggs": {
                "by_status": {"terms": {"field": "status", "size": 10}},
                "by_verdict": {"terms": {"field": "verdict", "size": 10}},
            },
        }
        try:
            resp = await self._es.search(CASES_READ_PATTERN, body)
        except Exception as exc:  # noqa: BLE001
            logger.warning("case stats failed: %s", exc)
            return {}
        total = resp.get("hits", {}).get("total", {})
        aggs = resp.get("aggregations", {})
        return {
            "opened": total.get("value", 0) if isinstance(total, dict) else 0,
            "by_status": _buckets(aggs.get("by_status")),
            "by_verdict": _buckets(aggs.get("by_verdict")),
        }

    async def _summarise(self, aggregate: dict[str, Any], prefs: Preferences) -> tuple[str, float]:
        from .prompts import STANDUP_SYSTEM

        messages = [
            {"role": "system", "content": STANDUP_SYSTEM},
            {"role": "user", "content": json.dumps(aggregate, default=str)},
        ]
        await self._audit.record(
            action_type=ActionType.PROMPT, surface=Role.STANDUP.value, actor=Role.STANDUP.value,
            model=prefs.standup_model.model, prompt_excerpt="<aggregate JSON>",
        )
        try:
            res = await self._gateway.complete(
                Role.STANDUP, messages, prefs.standup_model, surface=Role.STANDUP.value
            )
            return res.text, res.cost
        except GatewayError as exc:
            logger.info("Standup model unavailable (%s); using deterministic summary", exc)
            return _deterministic_summary(aggregate), 0.0


def _buckets(agg: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not agg:
        return []
    return [{"key": b.get("key"), "count": b.get("doc_count")} for b in agg.get("buckets", [])]


def _deterministic_summary(aggregate: dict[str, Any]) -> str:
    total = aggregate.get("total_events", 0)
    rules = aggregate.get("by_rule", [])
    top_rule = rules[0]["key"] if rules else "n/a"
    ips = aggregate.get("top_source_ips", [])
    top_ip = ips[0]["key"] if ips else "n/a"
    cases = aggregate.get("cases", {})
    return (
        f"Standup ({aggregate.get('window_hours', 24)}h): {total} events across "
        f"{len(rules)} rule type(s). Top rule: {top_rule}. Top source IP: {top_ip}. "
        f"{aggregate.get('unique_ips', 0)} unique source IPs. "
        f"Cases opened: {cases.get('opened', 0)}. "
        "(LLM summary unavailable; this is the deterministic aggregate.)"
    )
