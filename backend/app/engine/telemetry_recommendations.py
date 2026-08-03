"""Evidence-only telemetry-gap recommendations.

This module never infers a gap because a connector is absent. It accepts only a
versioned, structured observation emitted after an actual query/tool attempt
proved that the requested evidence could not be obtained.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any, Iterable

from ..models import Case

TELEMETRY_GAP_SCHEMA = "agentic-soc.telemetry-gap/v1"

# Explicit, operator-auditable mapping. Unknown fields/sources are ignored rather
# than allowing source-influenced text to manufacture product recommendations.
_SUPPORTED_GAPS: dict[tuple[str, str], tuple[str, str]] = {
    ("dns.question.name", "outbound_dns"): (
        "Outbound DNS logs",
        "Resolve destination domains and DNS behavior that IP-only telemetry cannot explain.",
    ),
    ("process.command_line", "endpoint_process"): (
        "Endpoint process telemetry",
        "Confirm which process initiated the observed host or network activity.",
    ),
    ("user.authentication_method", "identity_authentication"): (
        "Identity authentication logs",
        "Confirm MFA and authentication-method context for identity activity.",
    ),
}
_PRODUCERS = {"investigator", "tool", "system"}
_PROOF_RESULTS = {"field_missing", "query_unsupported", "source_unqueryable"}


def _validated_gap(case: Case, item: dict[str, Any]) -> dict[str, Any] | None:
    if item.get("schema") != TELEMETRY_GAP_SCHEMA or item.get("event") != "telemetry_gap":
        return None
    if str(item.get("producer") or "") not in _PRODUCERS:
        return None
    field = str(item.get("field") or "").strip()
    source = str(item.get("recommended_source") or "").strip()
    mapped = _SUPPORTED_GAPS.get((field, source))
    evidence = item.get("evidence")
    if mapped is None or not isinstance(evidence, dict):
        return None
    result = str(evidence.get("result") or "").strip()
    query = str(evidence.get("query") or "").strip()
    # "Connector absent" is not proof. We require a bounded query/tool attempt and
    # a controlled machine result that established the missing evidence.
    if result not in _PROOF_RESULTS or not query:
        return None
    label, benefit = mapped
    return {
        "case_id": case.case_id,
        "field": field,
        "source_type": source,
        "source_label": label,
        "benefit": benefit,
        "proof": {"result": result, "query": query[:500]},
    }


def recommend_sources(cases: Iterable[Case]) -> list[dict[str, Any]]:
    """Aggregate explicitly proven gaps; never inspect configured source absence."""
    grouped: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for case in cases:
        for item in case.history or []:
            if not isinstance(item, dict):
                continue
            gap = _validated_gap(case, item)
            if gap is not None:
                grouped[(gap["field"], gap["source_type"])].append(gap)
    rows: list[dict[str, Any]] = []
    for (_field, _source), gaps in grouped.items():
        example = gaps[0]
        case_ids = sorted({gap["case_id"] for gap in gaps})
        rows.append({
            "field": example["field"],
            "source_type": example["source_type"],
            "source_label": example["source_label"],
            "benefit": example["benefit"],
            "affected_case_count": len(case_ids),
            "case_ids": case_ids[:50],
            "evidence": [gap["proof"] for gap in gaps[:10]],
        })
    rows.sort(key=lambda row: (-row["affected_case_count"], row["source_type"]))
    return rows

