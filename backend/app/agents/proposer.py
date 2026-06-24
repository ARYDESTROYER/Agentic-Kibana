"""Agent-DRAFTED suppression / memory PROPOSALS (human-in-the-loop).

When an analyst CLOSES a case as a false positive, the proposer inspects the
case's own member events and DRAFTS a tightly-scoped suppression rule that the
analyst can later approve in one click — turning "I keep closing this same noisy
detection" into a reviewable, auditable rule. It NEVER writes a live rule: it only
produces a *pending* :class:`app.models.Proposal`; approval (a human action) is the
single live-write path (see ``api/routes`` ``/proposals/{id}/approve``).

Three anti-poisoning invariants, enforced HERE in code (verified in tests):

1. **Literal-presence only.** The proposer may ONLY propose a ``field==value`` pair
   whose field AND value LITERALLY appear in the closed case's member events. It can
   never invent a selector. The value must be common to MOST member events (so a
   single odd event can't seed a rule).
2. **Allowlist of safe selector fields.** Only specific, detection-identifying
   fields (rule/module/signature/event.action/event.code/process.name/file path)
   are eligible. A bare ENTITY field (the source's configured IP / user / host),
   ``message`` / ``event.original`` / ``@timestamp``, or any severity selector is
   DENIED outright — those are over-broad and would suppress unrelated activity.
3. **Single-rule scope.** A proposal is only drafted when the case's member events
   share ONE rule id; a cross-rule cluster yields nothing (a rule that matched
   across unrelated ``rule_ids`` would be over-broad).

FAIL-SAFE: every entry point is wrapped so the proposer can NEVER raise into the
analyst's close / confirm_fp path. On any doubt it returns ``None`` (propose
nothing) — silence is always safe.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from ..config import Preferences
from ..constants import Verdict
from ..models import Case, Proposal
from ..utils import dotted_get, now_utc

logger = logging.getLogger("tlsoc.agents.proposer")

# How many member events to sample when deriving a selector (bounded, read-only).
MAX_SAMPLE_EVENTS = 50
# A proposed rule self-retires after this window unless an operator renews it.
DEFAULT_EXPIRY_DAYS = 90
# A value must appear in at least this FRACTION of sampled events to be proposed
# (so a rule is genuinely characteristic of the cluster, not one stray event).
MIN_VALUE_PREVALENCE = 0.8

# Conservative ALLOWLIST of selector fields the proposer may target. Each is a
# specific, detection-identifying field whose value names a rule/signature/action —
# NOT a free-text or entity field. Order = preference (most specific first).
ALLOWED_SELECTOR_FIELDS: tuple[str, ...] = (
    "event.code",
    "rule.id",
    "rule.name",
    "event.module",
    "signature",
    "signature_id",
    "event.action",
    "process.name",
    "process.executable",
    "file.path",
    "file.name",
)

# Hard DENYLIST: never propose a selector on these fields. Over-broad / free-text /
# entity / time fields would suppress unrelated activity. Entity fields are added
# dynamically from the source's configured mapping in :func:`_denied_fields`.
DENYLIST_FIELDS: frozenset[str] = frozenset({
    "@timestamp", "timestamp", "message", "event.original", "log.original",
    "event.severity", "severity", "event.risk_score", "risk_score",
})


def _denied_fields(prefs: Preferences) -> frozenset[str]:
    """The static denylist PLUS the source's configured entity fields (a bare IP /
    user / host selector is over-broad and is never proposable)."""
    return DENYLIST_FIELDS | {
        prefs.source_ip_field,
        prefs.user_field,
        prefs.host_field,
        prefs.severity_field,
    }


async def _sample_event_sources(case: Case, *, source, prefs: Preferences) -> list[dict]:
    """Best-effort, BOUNDED fetch of the case's member-event source documents.

    Uses the live source connector's ``fetch_by_ids`` (read-only, field-mapping
    aware). Returns ``[]`` on any failure (the caller treats an empty sample as
    "propose nothing")."""
    ids = list(case.member_event_ids or [])[:MAX_SAMPLE_EVENTS]
    if not ids or source is None:
        return []
    fetch = getattr(source, "fetch_by_ids", None)
    if fetch is None:
        return []
    try:
        result = await fetch(prefs, ids, len(ids))
    except Exception as exc:  # noqa: BLE001 — proposing is best-effort
        logger.warning("Proposer: member-event fetch failed for %s: %s", case.case_id, exc)
        return []
    out: list[dict] = []
    for ev in getattr(result, "events", []) or []:
        src = getattr(ev, "source", None)
        if isinstance(src, dict) and src:
            out.append(src)
    return out


def _derive_selector(
    sources: list[dict], denied: frozenset[str]
) -> tuple[str, str] | None:
    """Pick the single safest ``(field, value)`` that LITERALLY appears in (most of)
    the sampled events. Allowlist + literal-presence + prevalence enforced here.

    Returns ``None`` when nothing safe + characteristic is derivable."""
    if not sources:
        return None
    n = len(sources)
    threshold = max(1, int(round(n * MIN_VALUE_PREVALENCE)))
    for field in ALLOWED_SELECTOR_FIELDS:
        if field in denied:
            continue
        # Count the literal values present for THIS field across the sample.
        counts: dict[str, int] = {}
        for src in sources:
            raw = dotted_get(src, field, None)
            if raw is None:
                continue
            # Only scalar, non-empty values — never lists/dicts (over-broad/ambiguous).
            if isinstance(raw, (list, dict)):
                continue
            val = str(raw).strip()
            if not val:
                continue
            counts[val] = counts.get(val, 0) + 1
        if not counts:
            continue
        # The dominant value for this field must cover at least the prevalence bar.
        value, hits = max(counts.items(), key=lambda kv: kv[1])
        if hits >= threshold:
            return field, value
    return None


async def draft_suppression_proposal(
    case: Case, *, source, prefs: Preferences
) -> Proposal | None:
    """Draft a pending suppression Proposal for a freshly-closed FALSE_POSITIVE.

    Returns ``None`` (propose nothing) unless ALL hold: the case verdict is
    FALSE_POSITIVE; its member events share ONE rule id; a safe, literally-present,
    prevalent ``field==value`` selector is derivable (allowlist + denylist). NEVER
    raises — any error degrades to ``None``."""
    try:
        # Only false positives motivate a suppression rule. A NEEDS_HUMAN / TP / unknown
        # verdict is NEVER auto-suppressed (would silence genuine activity).
        if case.verdict != Verdict.FALSE_POSITIVE:
            return None
        # Single-rule scope: a multi-rule cluster's selector would be over-broad.
        rule_ids = [r for r in (case.rule_ids or []) if str(r).strip()]
        if len(set(rule_ids)) != 1:
            return None

        sources = await _sample_event_sources(case, source=source, prefs=prefs)
        if not sources:
            return None

        denied = _denied_fields(prefs)
        selector = _derive_selector(sources, denied)
        if selector is None:
            return None
        field, value = selector

        # Defence in depth: the chosen field must be on the allowlist AND off the
        # denylist, and the value must literally appear in the sample.
        if field in denied or field not in ALLOWED_SELECTOR_FIELDS:
            return None
        if not any(str(dotted_get(s, field, None)).strip() == value for s in sources):
            return None

        n = len(sources)
        prevalence = sum(
            1 for s in sources if str(dotted_get(s, field, None)).strip() == value
        ) / n
        confidence = round(min(0.95, 0.5 + 0.45 * prevalence), 2)

        entity = f"{case.entity.type.value}:{case.entity.value}"
        rationale = (
            f"Closed FALSE_POSITIVE case {case.case_id} ({entity}, rule "
            f"{rule_ids[0]}): {field}=={value} appeared in {int(prevalence * 100)}% "
            f"of its {n} member event(s). Suppressing this exact field==value would "
            f"keep this benign detection out of investigation. Review before approving."
        )
        expires = (now_utc() + timedelta(days=DEFAULT_EXPIRY_DAYS)).isoformat()
        # The payload is a SuppressionRule-shaped dict the approve path materialises.
        payload = {
            "field": field,
            "value": value,
            "reason": f"Auto-proposed from FP case {case.case_id}",
            "confidence": confidence,
            "rationale": rationale,
            "source_case_ids": [case.case_id],
            "created_by": "agent",
            "expires_at": expires,
            "enabled": True,
        }
        return Proposal(
            kind="suppression",
            payload=payload,
            rationale=rationale,
            confidence=confidence,
            source_case_ids=[case.case_id],
            created_by="agent",
            expires_at=expires,
        )
    except Exception as exc:  # noqa: BLE001 — proposing must NEVER break the close path
        logger.warning("draft_suppression_proposal failed for %s: %s", getattr(case, "case_id", "?"), exc)
        return None
