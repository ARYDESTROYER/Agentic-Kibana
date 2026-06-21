"""es_query — the ONLY path to the log surface (Section 6.5).

Read-only, always. The tool accepts structured, validated parameters (never raw
free-form DSL from the model) and delegates execution to the active
:class:`~app.connectors.base.PullConnector` (Elasticsearch, OpenSearch, …). The
connector compiles the structured query to its native dialect, runs it through
the scoped read-only credential, and returns normalised events plus a
:class:`~app.connectors.base.QueryRendering` (the native query string + language)
for the one-click Discover/deep-link locator (Section 8.1/8.2).

Routing through the connector is what makes the log surface source-agnostic: the
LLM emits the same structured shape regardless of which SIEM backs the deployment.
"""

from __future__ import annotations

import logging
from typing import Any

from ..config import Preferences
from ..connectors.base import PullConnector, SearchResult, StructuredQuery
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

    def __init__(self, source: PullConnector, prefs: Preferences) -> None:
        self._source = source
        self._prefs = prefs

    async def run(self, **kwargs: Any) -> ToolResult:
        size = min(int(kwargs.get("size") or _DEFAULT_SIZE), _MAX_SIZE)
        try:
            # ``severity_gte`` may legitimately be 0 — DON'T collapse it with ``or``.
            sev = kwargs.get("severity_gte")
            sev = sev if sev not in (None, "") else None
            query = StructuredQuery(
                ip=_clean(kwargs.get("ip")),
                user=_clean(kwargs.get("user")),
                host=_clean(kwargs.get("host")),
                rule=_clean(kwargs.get("rule")),
                severity_gte=sev,
                contains=_clean(kwargs.get("contains")),
                ids=list(kwargs.get("ids") or []),
                time_from=kwargs.get("time_from", "now-24h"),
                time_to=kwargs.get("time_to", "now"),
                size=size,
                sort_desc=True,
            )
            result = await self._source.search(self._prefs, query)
            return self._format(result)
        except Exception as exc:  # noqa: BLE001
            logger.warning("es_query failed: %s", exc)
            return ToolResult(ok=False, error=str(exc), summary=f"es_query error: {exc}")

    def _format(self, result: SearchResult) -> ToolResult:
        p = self._prefs
        rows = []
        for ev in result.events:
            src = ev.source if isinstance(ev.source, dict) else {}
            event_obj = src.get("event")
            rows.append({
                "id": ev.id,
                "@timestamp": src.get(p.time_field) or src.get("@timestamp"),
                "ip": ev.ip,
                "user": ev.user,
                "host": ev.host,
                "rule": ev.rule,
                "rule_name": ev.rule_name,
                "severity": ev.severity,
                "action": event_obj.get("action") if isinstance(event_obj, dict) else None,
            })
        summary = f"{result.total} event(s) matched; returning {len(rows)}."
        r = result.rendering
        return ToolResult(
            ok=True,
            summary=summary,
            data={"total": result.total, "hits": rows},
            query=r.query if r else "*",
            meta={
                "language": r.language if r else "kuery",
                "data_view": r.data_view if r else p.data_view_pattern,
                "time_from": r.time_from if r else None,
                "time_to": r.time_to if r else None,
            },
        )


def _clean(value: Any) -> str | None:
    """Treat empty string as 'unset' (parity with the legacy ``not in (None, "")``)."""
    if value in (None, ""):
        return None
    return str(value)
