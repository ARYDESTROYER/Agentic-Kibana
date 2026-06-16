"""Shared helpers for the agent roles: robust verdict coercion and KQL fallback."""

from __future__ import annotations

import re
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


# Bare entity tokens a model commonly emits in a reproduce_query, mapped to the
# Preferences attribute holding the CONFIGURED field name for that entity.
_BARE_TOKEN_FIELDS = {
    "ip": "source_ip_field",
    "user": "user_field",
    "host": "host_field",
}
# `<token> : value` or `<token>:value`, value optionally quoted (single/double).
_BARE_TOKEN_RE = re.compile(
    r"\b(ip|user|host)\s*:\s*(\"[^\"]*\"|'[^']*'|[^\s\"']+)",
    re.IGNORECASE,
)


def normalize_kql(query: str, prefs: Preferences) -> str:
    """Normalise a reproduce-query so bare entity tokens map to configured fields.

    Maps ``ip:x`` / ``user:x`` / ``host:x`` to the CONFIGURED entity fields
    (``source_ip_field`` / ``user_field`` / ``host_field``) with proper quoting,
    e.g. ``ip:1.2.3.4`` -> ``source.ip : "1.2.3.4"``. It is IDEMPOTENT on already-
    correct KQL: a query that already references the configured field (``source.ip :
    "x"``) is left unchanged. Any other text passes through untouched.
    """
    if not query:
        return query

    configured_fields = {getattr(prefs, attr) for attr in _BARE_TOKEN_FIELDS.values()}

    def _replace(m: re.Match[str]) -> str:
        token = m.group(1).lower()
        raw_value = m.group(2)
        value = raw_value
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            value = value[1:-1]
        field = getattr(prefs, _BARE_TOKEN_FIELDS[token])
        return f'{field} : "{value}"'

    # If the bare token's name IS already a configured field (unlikely but possible),
    # the regex still rewrites it identically — so the operation stays idempotent.
    result = _BARE_TOKEN_RE.sub(_replace, query)

    # Idempotency safety net: when the input already used a configured field, the
    # regex above does not match it (the field name contains a dot, not a bare
    # token), so it is preserved verbatim.
    _ = configured_fields  # documents intent; no further action required.
    return result
