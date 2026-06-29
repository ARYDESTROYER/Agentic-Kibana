"""Deterministic Case Manager policy (Section 6.4).

The close/escalate decision is computed in code from the operator-configured
``AutoClosePolicy`` — never from raw LLM output and never from playbook text. These
tests pin that enforcement: per-verdict-class enable/threshold/objection-window,
TRUE_POSITIVE auto-close as an explicit opt-in (off by default), and NEEDS_HUMAN
never auto-closable regardless of configuration.
"""

from __future__ import annotations

from app.config import AutoClosePolicy, Preferences, VerdictAutoClose
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.case_manager import CaseManager, decide
from app.models import Case, Entity


def _policy(
    *, fp=False, fp_conf=0.95, fp_risk=30.0, tp=False, tp_conf=0.95, tp_risk=10.0
) -> AutoClosePolicy:
    return AutoClosePolicy(
        false_positive=VerdictAutoClose(
            enabled=fp, min_confidence=fp_conf, max_risk_score=fp_risk,
            objection_window_minutes=60,
        ),
        true_positive=VerdictAutoClose(
            enabled=tp, min_confidence=tp_conf, max_risk_score=tp_risk,
            objection_window_minutes=120,
        ),
    )


# --- TRUE_POSITIVE: off by default, opt-in supported ---------------------------
def test_tp_routes_to_human_when_tp_autoclose_disabled():
    # Default: tp disabled even with fp on → human.
    d = decide(Verdict.TRUE_POSITIVE, 0.99, 5.0, _policy(fp=True))
    assert d.status == CaseStatus.NEEDS_HUMAN
    assert d.decision_by == DecisionBy.SYSTEM


def test_tp_autocloses_when_opted_in_and_bar_cleared():
    d = decide(Verdict.TRUE_POSITIVE, 0.97, 5.0, _policy(tp=True, tp_conf=0.95, tp_risk=10.0))
    assert d.status == CaseStatus.CLOSED
    assert d.decision_by == DecisionBy.AGENT
    assert d.objection_window_expires_at is not None


def test_tp_opted_in_but_bar_not_met_routes_to_human():
    low_conf = decide(Verdict.TRUE_POSITIVE, 0.5, 5.0, _policy(tp=True, tp_conf=0.95))
    high_risk = decide(Verdict.TRUE_POSITIVE, 0.99, 80.0, _policy(tp=True, tp_risk=10.0))
    assert low_conf.status == CaseStatus.NEEDS_HUMAN
    assert high_risk.status == CaseStatus.NEEDS_HUMAN


def test_tp_escalates_when_confident_and_not_closed():
    d = decide(Verdict.TRUE_POSITIVE, 0.9, 90.0, _policy())
    assert d.escalate is True
    assert d.status == CaseStatus.NEEDS_HUMAN


# --- FALSE_POSITIVE ------------------------------------------------------------
def test_fp_autoclose_disabled_routes_to_human():
    d = decide(Verdict.FALSE_POSITIVE, 0.99, 1.0, _policy(fp=False))
    assert d.status == CaseStatus.NEEDS_HUMAN


def test_fp_autocloses_when_conditions_met():
    d = decide(Verdict.FALSE_POSITIVE, 0.95, 10.0, _policy(fp=True, fp_conf=0.9, fp_risk=30.0))
    assert d.status == CaseStatus.CLOSED
    assert d.decision_by == DecisionBy.AGENT
    assert d.objection_window_expires_at is not None


def test_fp_not_closed_when_confidence_too_low():
    d = decide(Verdict.FALSE_POSITIVE, 0.5, 10.0, _policy(fp=True, fp_conf=0.95))
    assert d.status == CaseStatus.NEEDS_HUMAN


def test_fp_not_closed_when_risk_too_high():
    d = decide(Verdict.FALSE_POSITIVE, 0.99, 80.0, _policy(fp=True, fp_conf=0.5, fp_risk=30.0))
    assert d.status == CaseStatus.NEEDS_HUMAN


# --- NEEDS_HUMAN / unknown — never auto-closable -------------------------------
def test_needs_human_and_none_always_route_to_human():
    pol = _policy(fp=True, tp=True)
    assert decide(Verdict.NEEDS_HUMAN, 0.99, 1.0, pol).status == CaseStatus.NEEDS_HUMAN
    assert decide(None, 0.99, 1.0, pol).status == CaseStatus.NEEDS_HUMAN


# --- CaseManager.apply ---------------------------------------------------------
def _case(verdict: Verdict, confidence: float, risk: float) -> Case:
    return Case(
        case_id="c1", cluster_signature="sig", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        verdict=verdict, confidence=confidence, risk_score=risk,
    )


def test_manager_apply_fp_closes_and_records_history():
    p = Preferences()
    p.auto_close.false_positive = VerdictAutoClose(enabled=True, min_confidence=0.9, max_risk_score=30.0)
    case = _case(Verdict.FALSE_POSITIVE, 0.95, 10.0)
    CaseManager(p).apply(case)
    assert case.status == CaseStatus.CLOSED
    assert case.decision_by == DecisionBy.AGENT
    assert any(h.get("event") == "decision" for h in case.history)


def test_manager_apply_tp_opt_in_closes():
    p = Preferences()
    p.auto_close.true_positive = VerdictAutoClose(enabled=True, min_confidence=0.9, max_risk_score=20.0)
    case = _case(Verdict.TRUE_POSITIVE, 0.95, 5.0)
    CaseManager(p).apply(case)
    assert case.status == CaseStatus.CLOSED  # supported opt-in
    assert case.decision_by == DecisionBy.AGENT


def test_manager_apply_tp_default_routes_to_human_as_escalated():
    # Status taxonomy (F8): a confident TP is NOT auto-closed by default, and the
    # existing decide().escalate flag now surfaces as the ESCALATED lifecycle status
    # in apply() (non-close branch only). It is still a human/SYSTEM decision — not
    # closed — so the close invariant is intact.
    p = Preferences()  # defaults: tp auto-close off
    case = _case(Verdict.TRUE_POSITIVE, 0.99, 5.0)
    CaseManager(p).apply(case)
    assert case.status == CaseStatus.ESCALATED
    assert case.status != CaseStatus.CLOSED
    assert case.decision_by == DecisionBy.SYSTEM
    assert case.escalation_level >= 1


# --- Status taxonomy (F8) — decide() UNCHANGED + apply() layers disposition -----
def test_decide_truth_table_byte_identical():
    """Guard non-negotiable #3: decide()'s pure truth table is unchanged by the F8
    additions. We re-assert the exact (status, decision_by, escalate) tuples the
    legacy table produced for every verdict class and both policy outcomes."""
    pol = _policy(fp=True, fp_conf=0.9, fp_risk=30.0, tp=True, tp_conf=0.9, tp_risk=10.0)

    # FP clears the bar → CLOSED by AGENT, no escalate.
    d = decide(Verdict.FALSE_POSITIVE, 0.95, 10.0, pol)
    assert (d.status, d.decision_by, d.escalate) == (CaseStatus.CLOSED, DecisionBy.AGENT, False)
    # FP misses the bar → NEEDS_HUMAN by SYSTEM, no escalate (FP never escalates).
    d = decide(Verdict.FALSE_POSITIVE, 0.5, 10.0, pol)
    assert (d.status, d.decision_by, d.escalate) == (CaseStatus.NEEDS_HUMAN, DecisionBy.SYSTEM, False)
    # TP clears the bar → CLOSED by AGENT, escalate forced False on close.
    d = decide(Verdict.TRUE_POSITIVE, 0.95, 5.0, pol)
    assert (d.status, d.decision_by, d.escalate) == (CaseStatus.CLOSED, DecisionBy.AGENT, False)
    # TP misses the bar but is confident → NEEDS_HUMAN by SYSTEM, escalate True.
    d = decide(Verdict.TRUE_POSITIVE, 0.95, 80.0, pol)
    assert (d.status, d.decision_by, d.escalate) == (CaseStatus.NEEDS_HUMAN, DecisionBy.SYSTEM, True)
    # NEEDS_HUMAN / None → always NEEDS_HUMAN by SYSTEM, never closed.
    assert decide(Verdict.NEEDS_HUMAN, 0.99, 1.0, pol).status == CaseStatus.NEEDS_HUMAN
    assert decide(None, 0.99, 1.0, pol).status == CaseStatus.NEEDS_HUMAN


def test_apply_sets_disposition_from_verdict_when_unset():
    p = Preferences()
    p.auto_close.false_positive = VerdictAutoClose(enabled=True, min_confidence=0.9, max_risk_score=30.0)
    case = _case(Verdict.FALSE_POSITIVE, 0.95, 10.0)
    assert case.disposition is None
    CaseManager(p).apply(case)
    from app.constants import Disposition
    assert case.disposition == Disposition.FALSE_POSITIVE


def test_apply_does_not_override_analyst_disposition():
    from app.constants import Disposition
    p = Preferences()
    case = _case(Verdict.TRUE_POSITIVE, 0.99, 5.0)
    case.disposition = Disposition.BENIGN  # analyst already classified it
    CaseManager(p).apply(case)
    assert case.disposition == Disposition.BENIGN


def test_apply_escalated_only_in_non_close_branch_and_records_history():
    # A confident TP that does NOT auto-close becomes ESCALATED (non-close) and the
    # transition is recorded on the append-only status timeline.
    p = Preferences()  # tp auto-close off → non-close branch
    case = _case(Verdict.TRUE_POSITIVE, 0.9, 90.0)
    CaseManager(p).apply(case)
    assert case.status == CaseStatus.ESCALATED
    assert case.status_history and case.status_history[-1].to_status == CaseStatus.ESCALATED.value


def test_apply_close_branch_never_escalates():
    # When the decision closes the case, ESCALATED must NOT override CLOSED (the
    # escalate→ESCALATED mapping is guarded to the non-close branch).
    p = Preferences()
    p.auto_close.true_positive = VerdictAutoClose(enabled=True, min_confidence=0.9, max_risk_score=95.0)
    case = _case(Verdict.TRUE_POSITIVE, 0.95, 90.0)  # would escalate if not closed
    CaseManager(p).apply(case)
    assert case.status == CaseStatus.CLOSED


def test_apply_needs_human_never_closed_invariant_still_raises():
    """The defence-in-depth invariant (NEEDS_HUMAN/None never CLOSED) must still
    raise if a decision ever attempts it — even with the F8 additions in place."""
    import pytest

    from app.engine.case_manager import Decision

    p = Preferences()
    mgr = CaseManager(p)
    case = _case(Verdict.NEEDS_HUMAN, 0.99, 1.0)

    # Force decide() to (impossibly) return CLOSED to prove the assertion fires.
    import app.engine.case_manager as cm

    orig = cm.decide
    cm.decide = lambda *a, **k: Decision(status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT)
    try:
        with pytest.raises(AssertionError):
            mgr.apply(case)
    finally:
        cm.decide = orig
