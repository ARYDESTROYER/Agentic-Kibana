"""es_query — the ONLY path to the log surface (Section 6.5).

Read-only, always: it executes through ``BaseESClient.search_logs``, which is
backed exclusively by the scoped read-only API key. It accepts structured,
validated parameters (never raw free-form DSL from the model) and renders both
the executed query and an equivalent KQL string for the one-click Discover
locator (Section 8.1/8.2).
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import Preferences
from ..es.base import BaseESClient
from ..es.querybuilder import ids_query
from ..models import RawEvent
from ..utils import relative_to_millis
from .base import Tool, ToolResult

logger = logging.getLogger("tlsoc.tools.es_query")

_MAX_SIZE = 200
_DEFAULT_SIZE = 50


class EsQueryTool(Tool):
    name = "es_query"
    description = (
        "Search the read-only log indices for events matching structured filters "
        "(ip, user, host, rule, minimum severity, free-text 'contains', time range)."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "ip": {"type": "string", "description": "source IP to filter on"},
            "user": {"type": "string"},
            "host": {"type": "string"},
            "rule": {"type": "string", "description": "rule/module value to filter on"},
            "severity_gte": {"type": "number"},
            "contains": {"type": "string", "description": "free-text substring across message fields"},
            "ids": {"type": "array", "items": {"type": "string"}},
            "time_from": {"type": "string", "description": "e.g. now-24h or ISO timestamp"},
            "time_to": {"type": "string", "description": "e.g. now or ISO timestamp"},
            "size": {"type": "integer", "description": f"max hits (<= {_MAX_SIZE})"},
        },
        "additionalProperties": False,
    }

    def __init__(self, es: BaseESClient, prefs: Preferences) -> None:
        self._es = es
        self._prefs = prefs

    async def run(self, **kwargs: Any) -> ToolResult:
        p = self._prefs
        size = min(int(kwargs.get("size") or _DEFAULT_SIZE), _MAX_SIZE)
        ids = kwargs.get("ids")
        try:
            if ids:
                body = ids_query(list(ids), size=size)
                kql = "_id in (%s)" % ", ".join(f'"{i}"' for i in ids)
                resp = await self._es.search_logs(p.data_view_pattern, body)
                return self._format(resp, kql, None, None)

            filters: list[dict[str, Any]] = []
            kql_parts: list[str] = []
            for key, field in (
                ("ip", p.source_ip_field),
                ("user", p.user_field),
                ("host", p.host_field),
                ("rule", p.rule_field),
            ):
                val = kwargs.get(key)
                if val not in (None, ""):
                    filters.append({"term": {field: val}})
                    kql_parts.append(f'{field} : "{val}"')

            sev = kwargs.get("severity_gte")
            if sev not in (None, ""):
                filters.append({"range": {p.severity_field: {"gte": sev}}})
                kql_parts.append(f"{p.severity_field} >= {sev}")

            contains = kwargs.get("contains")
            if contains:
                fields = [p.rule_name_field, "message", "event.original", "event.action"]
                filters.append({"multi_match": {"query": contains, "fields": fields}})
                kql_parts.append(f'message : "*{contains}*"')

            time_from = kwargs.get("time_from", "now-24h")
            time_to = kwargs.get("time_to", "now")
            from_millis = relative_to_millis(time_from)
            to_millis = relative_to_millis(time_to)
            filters.append(
                {"range": {p.time_field: {"gte": from_millis, "lte": to_millis, "format": "epoch_millis"}}}
            )

            body = {
                "size": size,
                "sort": [{p.time_field: {"order": "desc"}}],
                "query": {"bool": {"filter": filters}},
            }
            resp = await self._es.search_logs(p.data_view_pattern, body)
            kql = " and ".join(kql_parts) if kql_parts else "*"
            return self._format(resp, kql, time_from, time_to)
        except Exception as exc:  # noqa: BLE001
            logger.warning("es_query failed: %s", exc)
            return ToolResult(ok=False, error=str(exc), summary=f"es_query error: {exc}")

    def _format(self, resp: dict[str, Any], kql: str, time_from, time_to) -> ToolResult:
        hits = resp.get("hits", {}).get("hits", [])
        total = resp.get("hits", {}).get("total", {})
        total_val = total.get("value", len(hits)) if isinstance(total, dict) else len(hits)
        rows = []
        for h in hits:
            ev = RawEvent.from_hit(h, self._prefs)
            rows.append({
                "id": ev.id,
                "@timestamp": ev.source.get(self._prefs.time_field) or ev.source.get("@timestamp"),
                "ip": ev.ip,
                "user": ev.user,
                "host": ev.host,
                "rule": ev.rule,
                "rule_name": ev.rule_name,
                "severity": ev.severity,
                "action": ev.source.get("event", {}).get("action") if isinstance(ev.source.get("event"), dict) else None,
            })
        summary = f"{total_val} event(s) matched; returning {len(rows)}."
        return ToolResult(
            ok=True,
            summary=summary,
            data={"total": total_val, "hits": rows},
            query=kql,
            meta={
                "language": "kuery",
                "data_view": self._prefs.data_view_pattern,
                "time_from": time_from,
                "time_to": time_to,
            },
        )
