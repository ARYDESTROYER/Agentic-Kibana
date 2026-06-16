"""Deterministic Case Manager (Section 6.4 / Non-negotiable #3).

The verdict comes from the LLM; the close/escalate DECISION comes from THIS code.
Hard, non-negotiable invariants enforced here (not in any prompt):

* A TRUE_POSITIVE is NEVER auto-closed — it always routes to a human.
* A FALSE_POSITIVE may auto-close ONLY when fp_auto_close is enabled AND
  confidence and risk satisfy the configured thresholds, and then only with an
  objection window during which a human can reopen it.
* Anything else (NEEDS_HUMAN, missing verdict, any failure) routes to a human.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from ..config import Preferences
from ..constants import CaseStatus, DecisionBy, Verdict
from ..models import Case
from ..utils import iso_now, now_utc


@dataclass(frozen=True)
class Decision:
    status: CaseStatus
    decision_by: DecisionBy
    objection_window_expires_at: str | None = None
    escalate: bool = False
    rationale: str = ""


def decide(
    verdict: Verdict | None,
    confidence: float,
    risk_score: float,
    prefs: Preferences,
) -> Decision:
    """Pure decision function. Deterministic, side-effect free, fully testable."""
    fp = prefs.fp_auto_close

    if verdict == Verdict.TRUE_POSITIVE:
        escalate = confidence >= prefs.escalation_confidence or risk_score >= (
            prefs.critical_severity * 10.0
        )
        # NEVER closed. This branch can only ever route to a human.
        return Decision(
            status=CaseStatus.NEEDS_HUMAN,
            decision_by=DecisionBy.SYSTEM,
            escalate=escalate,
            rationale="True positive always routes to a human (Non-negotiable #3).",
        )

    if verdict == Verdict.FALSE_POSITIVE:
        if fp.enabled and confidence >= fp.min_confidence and risk_score <= fp.max_risk_score:
            expires = (now_utc() + timedelta(minutes=fp.objection_window_minutes)).isoformat()
            return Decision(
                status=CaseStatus.CLOSED,
                decision_by=DecisionBy.AGENT,
                objection_window_expires_at=expires,
                rationale=(
                    f"FP auto-close: confidence {confidence:.2f} >= {fp.min_confidence} and "
                    f"risk {risk_score:.1f} <= {fp.max_risk_score}; objection window "
                    f"{fp.objection_window_minutes}m."
                ),
            )
        return Decision(
            status=CaseStatus.NEEDS_HUMAN,
            decision_by=DecisionBy.SYSTEM,
            rationale="False positive did not meet strict auto-close conditions; human confirms.",
        )

    # NEEDS_HUMAN, None, or any unexpected value -> fail to human.
    return Decision(
        status=CaseStatus.NEEDS_HUMAN,
        decision_by=DecisionBy.SYSTEM,
        rationale="No confident close decision; routing to human (fail-safe).",
    )


class CaseManager:
    """Applies the deterministic decision to a case and records the trail."""

    def __init__(self, prefs: Preferences) -> None:
        self._prefs = prefs

    def update_prefs(self, prefs: Preferences) -> None:
        self._prefs = prefs

    def apply(self, case: Case) -> Case:
        decision = decide(case.verdict, case.confidence, case.risk_score, self._prefs)

        # Defence in depth: a true positive can never be closed, whatever upstream did.
        if case.verdict == Verdict.TRUE_POSITIVE and decision.status == CaseStatus.CLOSED:
            raise AssertionError("Invariant violated: attempted to auto-close a TRUE_POSITIVE")

        case.status = decision.status
        case.decision_by = decision.decision_by
        case.objection_window_expires_at = decision.objection_window_expires_at
        case.updated_at = iso_now()
        case.history.append({
            "ts": case.updated_at,
            "event": "decision",
            "status": decision.status.value,
            "decision_by": decision.decision_by.value,
            "escalate": decision.escalate,
            "rationale": decision.rationale,
        })
        return case
