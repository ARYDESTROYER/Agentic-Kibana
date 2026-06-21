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


def test_manager_apply_tp_default_routes_to_human():
    p = Preferences()  # defaults: tp auto-close off
    case = _case(Verdict.TRUE_POSITIVE, 0.99, 5.0)
    CaseManager(p).apply(case)
    assert case.status == CaseStatus.NEEDS_HUMAN
