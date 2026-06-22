"""Deterministic Case Manager (Section 6.4).

The verdict comes from the LLM; the close/escalate DECISION comes from THIS code,
enforced against the operator-configured ``AutoClosePolicy`` (config.py / settings).
The LLM verdict FEEDS the policy; it never bypasses it, and a playbook can only
recommend — it can never set or override these thresholds.

The decision is a pure function of ``(verdict, confidence, risk_score, policy)``:

* For a verdict class, if that class is ``enabled`` AND ``confidence`` clears
  ``min_confidence`` AND ``risk_score`` is within ``max_risk_score``, the case is
  auto-closed (decision_by = agent) with the configured objection window during
  which a human can reopen it. Otherwise it routes to a human (decision_by = system).
* NEEDS_HUMAN (and a missing/unknown verdict) ALWAYS route to a human — never
  auto-closable, regardless of configuration (enforced here in code).

Auto-close is a normal calibration surface: conservative defaults ship (FP auto-
close on above a bar; TP auto-close OFF by default but a supported opt-in), and
operators tune the thresholds per verdict class in settings.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from ..config import AutoClosePolicy, Preferences, VerdictAutoClose
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


def _entry_for(policy: AutoClosePolicy, verdict: Verdict | None) -> VerdictAutoClose | None:
    if verdict == Verdict.FALSE_POSITIVE:
        return policy.false_positive
    if verdict == Verdict.TRUE_POSITIVE:
        return policy.true_positive
    return None  # NEEDS_HUMAN / None are never auto-closable


def decide(
    verdict: Verdict | None,
    confidence: float,
    risk_score: float,
    policy: AutoClosePolicy,
    *,
    escalation_confidence: float = 0.6,
    critical_severity: float = 7.0,
) -> Decision:
    """Pure, deterministic, side-effect-free decision over the auto-close policy."""
    entry = _entry_for(policy, verdict)

    # A high-severity true positive that is NOT auto-closed should be flagged for
    # priority human attention. (Escalation never closes; it only prioritises.)
    escalate = bool(
        verdict == Verdict.TRUE_POSITIVE
        and (confidence >= escalation_confidence or risk_score >= critical_severity * 10.0)
    )

    if entry is not None and entry.enabled:
        if confidence >= entry.min_confidence and risk_score <= entry.max_risk_score:
            expires = (
                now_utc() + timedelta(minutes=entry.objection_window_minutes)
            ).isoformat()
            return Decision(
                status=CaseStatus.CLOSED,
                decision_by=DecisionBy.AGENT,
                objection_window_expires_at=expires,
                escalate=False,
                rationale=(
                    f"{(verdict.value if verdict else '?')} auto-closed: confidence "
                    f"{confidence:.2f} >= {entry.min_confidence} and risk {risk_score:.1f} "
                    f"<= {entry.max_risk_score}; objection window "
                    f"{entry.objection_window_minutes}m."
                ),
            )
        # Enabled but the bar wasn't cleared.
        return Decision(
            status=CaseStatus.NEEDS_HUMAN,
            decision_by=DecisionBy.SYSTEM,
            escalate=escalate,
            rationale=(
                f"{(verdict.value if verdict else '?')} routed to human: did not clear the "
                f"auto-close bar (confidence {confidence:.2f} vs {entry.min_confidence}, "
                f"risk {risk_score:.1f} vs {entry.max_risk_score})."
            ),
        )

    # Class disabled, or NEEDS_HUMAN / unknown verdict → always a human.
    if verdict == Verdict.TRUE_POSITIVE:
        rationale = "True positive routed to human: tp auto-close disabled."
    elif verdict == Verdict.FALSE_POSITIVE:
        rationale = "False positive routed to human: fp auto-close disabled."
    else:
        rationale = "No confident close decision; routing to human (fail-safe)."
    return Decision(
        status=CaseStatus.NEEDS_HUMAN,
        decision_by=DecisionBy.SYSTEM,
        escalate=escalate,
        rationale=rationale,
    )


class CaseManager:
    """Applies the deterministic decision to a case and records the trail."""

    def __init__(self, prefs: Preferences) -> None:
        self._prefs = prefs

    def update_prefs(self, prefs: Preferences) -> None:
        self._prefs = prefs

    def apply(self, case: Case) -> Case:
        decision = decide(
            case.verdict,
            case.confidence,
            case.risk_score,
            self._prefs.auto_close,
            escalation_confidence=self._prefs.escalation_confidence,
            critical_severity=self._prefs.critical_severity,
        )

        # Defence in depth: NEEDS_HUMAN / a missing verdict can NEVER be auto-closed,
        # whatever upstream produced — this invariant is not policy-tunable.
        if case.verdict in (None, Verdict.NEEDS_HUMAN) and decision.status == CaseStatus.CLOSED:
            raise AssertionError("Invariant violated: attempted to auto-close a NEEDS_HUMAN case")

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
