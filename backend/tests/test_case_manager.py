"""Deterministic Case Manager policy (Section 6.4 / Non-negotiable #3).

These tests guard the single most important invariant in the suite: the agent
NEVER auto-closes a true positive.
"""

from __future__ import annotations

import pytest

from app.config import Preferences
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.case_manager import CaseManager, decide
from app.models import Case, Entity


def _prefs(fp_enabled=False, min_conf=0.95, max_risk=30.0) -> Preferences:
    p = Preferences()
    p.fp_auto_close.enabled = fp_enabled
    p.fp_auto_close.min_confidence = min_conf
    p.fp_auto_close.max_risk_score = max_risk
    return p


def test_true_positive_never_closes_even_with_fp_autoclose_on():
    p = _prefs(fp_enabled=True, min_conf=0.1, max_risk=100.0)
    d = decide(Verdict.TRUE_POSITIVE, confidence=0.99, risk_score=5.0, prefs=p)
    assert d.status == CaseStatus.NEEDS_HUMAN
    assert d.decision_by == DecisionBy.SYSTEM


def test_true_positive_escalates_when_confident():
    p = _prefs()
    d = decide(Verdict.TRUE_POSITIVE, confidence=0.9, risk_score=90.0, prefs=p)
    assert d.escalate is True
    assert d.status == CaseStatus.NEEDS_HUMAN


def test_false_positive_autoclose_disabled_routes_to_human():
    p = _prefs(fp_enabled=False)
    d = decide(Verdict.FALSE_POSITIVE, confidence=0.99, risk_score=1.0, prefs=p)
    assert d.status == CaseStatus.NEEDS_HUMAN


def test_false_positive_autoclose_when_conditions_met():
    p = _prefs(fp_enabled=True, min_conf=0.9, max_risk=30.0)
    d = decide(Verdict.FALSE_POSITIVE, confidence=0.95, risk_score=10.0, prefs=p)
    assert d.status == CaseStatus.CLOSED
    assert d.decision_by == DecisionBy.AGENT
    assert d.objection_window_expires_at is not None


def test_false_positive_not_closed_when_confidence_too_low():
    p = _prefs(fp_enabled=True, min_conf=0.95, max_risk=30.0)
    d = decide(Verdict.FALSE_POSITIVE, confidence=0.5, risk_score=10.0, prefs=p)
    assert d.status == CaseStatus.NEEDS_HUMAN


def test_false_positive_not_closed_when_risk_too_high():
    p = _prefs(fp_enabled=True, min_conf=0.5, max_risk=30.0)
    d = decide(Verdict.FALSE_POSITIVE, confidence=0.99, risk_score=80.0, prefs=p)
    assert d.status == CaseStatus.NEEDS_HUMAN


def test_needs_human_and_none_fail_safe():
    p = _prefs(fp_enabled=True)
    assert decide(Verdict.NEEDS_HUMAN, 0.9, 1.0, p).status == CaseStatus.NEEDS_HUMAN
    assert decide(None, 0.9, 1.0, p).status == CaseStatus.NEEDS_HUMAN


def _case(verdict: Verdict, confidence: float, risk: float) -> Case:
    return Case(
        case_id="c1", cluster_signature="sig", source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="1.2.3.4"),
        verdict=verdict, confidence=confidence, risk_score=risk,
    )


def test_manager_apply_sets_status_and_history():
    p = _prefs(fp_enabled=True, min_conf=0.9, max_risk=30.0)
    case = _case(Verdict.FALSE_POSITIVE, 0.95, 10.0)
    CaseManager(p).apply(case)
    assert case.status == CaseStatus.CLOSED
    assert case.decision_by == DecisionBy.AGENT
    assert any(h.get("event") == "decision" for h in case.history)


def test_manager_apply_tp_invariant_holds():
    p = _prefs(fp_enabled=True, min_conf=0.1, max_risk=100.0)
    case = _case(Verdict.TRUE_POSITIVE, 0.99, 5.0)
    CaseManager(p).apply(case)
    assert case.status == CaseStatus.NEEDS_HUMAN  # never CLOSED
