"""Shared helpers for the agent roles: robust verdict coercion and KQL fallback."""

from __future__ import annotations

from typing import Any

from ..config import Preferences
from ..constants import Verdict
from ..models import Cluster, EvidenceItem, VerdictResult


def _clamp01(value: Any) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, v))


def coerce_verdict(obj: dict | None) -> VerdictResult:
    """Turn an arbitrary model-produced dict into a valid VerdictResult.

    Unknown/invalid verdicts fail safe to NEEDS_HUMAN; confidence is clamped;
    evidence/mitre are normalised. Never raises."""
    if not isinstance(obj, dict):
        return VerdictResult(verdict=Verdict.NEEDS_HUMAN)

    try:
        verdict = Verdict(str(obj.get("verdict", "")).upper())
    except ValueError:
        verdict = Verdict.NEEDS_HUMAN

    evidence: list[EvidenceItem] = []
    for item in obj.get("evidence", []) or []:
        if isinstance(item, dict):
            evidence.append(
                EvidenceItem(
                    summary=str(item.get("summary", "")),
                    event_ids=[str(x) for x in (item.get("event_ids") or [])],
                    query=item.get("query"),
                )
            )
        elif isinstance(item, str):
            evidence.append(EvidenceItem(summary=item))

    mitre = [str(x) for x in (obj.get("mitre") or []) if x]

    return VerdictResult(
        verdict=verdict,
        confidence=_clamp01(obj.get("confidence", 0.0)),
        evidence=evidence,
        mitre=mitre,
        recommended_action=str(obj.get("recommended_action", "")),
        reproduce_query=str(obj.get("reproduce_query", "")),
    )


def rag_query(cluster: Cluster) -> str:
    """A natural-language retrieval query for the RAG tool from a cluster."""
    rules = " ".join(cluster.rule_values) or "security events"
    return f"{cluster.entity.type.value} {rules} investigation runbook mitre"


def entity_kql(cluster: Cluster, prefs: Preferences) -> str:
    """A safe reproduce-query fallback that always points Discover at the entity."""
    field = {
        "ip": prefs.source_ip_field,
        "user": prefs.user_field,
        "host": prefs.host_field,
    }.get(cluster.entity.type.value, prefs.source_ip_field)
    return f'{field} : "{cluster.entity.value}"'
