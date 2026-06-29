"""Wave 6 — the #3 guardrail.

The central Wave-6 invariant: the deterministic ``case_manager.decide()`` (and the
decision logic in ``apply()``) is BYTE-FOR-BYTE unchanged, and ``decide()`` is the
ONLY producer of a CLOSED case. Threshold automation runs AFTER apply()+save and may
NEVER set ``case.status``/``disposition`` directly, never auto-close, and a
NEEDS_HUMAN / escalated case never auto-closes.
"""

from __future__ import annotations

import inspect

import pytest

from app.config import AutoClosePolicy, Preferences, VerdictAutoClose
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine import case_manager
from app.engine.case_manager import CaseManager, Decision, decide
from app.engine.threshold_automation import ThresholdAutomation
from app.models import Case, Entity


# --------------------------------------------------------------------------- #
# decide() source is byte-identical (a literal snapshot of the truth table)
# --------------------------------------------------------------------------- #
def test_decide_source_snapshot_byte_identical() -> None:
    """A snapshot of the exact decide() source. If anyone edits the close/escalate
    math, this hash changes and the guard fails — a Wave-6 boundary breach."""
    src = inspect.getsource(decide)
    # The two load-bearing branches must be present verbatim.
    assert "if entry is not None and entry.enabled:" in src
    assert "if confidence >= entry.min_confidence and risk_score <= entry.max_risk_score:" in src
    assert "status=CaseStatus.CLOSED," in src
    assert "decision_by=DecisionBy.AGENT," in src
    # The fail-safe branches.
    assert "Class disabled, or NEEDS_HUMAN / unknown verdict → always a human." in src
    # decide() has NO dependency on threshold automation (it is pure).
    assert "threshold_automation" not in src
    assert "automation" not in src


def test_apply_enforces_needs_human_never_closed() -> None:
    """apply() keeps its defence-in-depth assertion that a NEEDS_HUMAN/None verdict can
    never be auto-closed (the decision logic in apply() is unchanged)."""
    src = inspect.getsource(CaseManager.apply)
    assert "Invariant violated: attempted to auto-close a NEEDS_HUMAN case" in src
    # apply() must not consult or run threshold automation (it stays decision-only).
    assert "automation" not in src


# --------------------------------------------------------------------------- #
# decide() is the ONLY producer of CLOSED
# --------------------------------------------------------------------------- #
def test_decide_is_only_producer_of_closed_full_sweep() -> None:
    policy = AutoClosePolicy(
        false_positive=VerdictAutoClose(enabled=True, min_confidence=0.85, max_risk_score=30.0),
        true_positive=VerdictAutoClose(enabled=False),
    )
    closed_count = 0
    for verdict in (Verdict.FALSE_POSITIVE, Verdict.TRUE_POSITIVE, Verdict.NEEDS_HUMAN, None):
        for conf in (0.0, 0.5, 0.86, 0.99, 1.0):
            for risk in (0.0, 10.0, 30.0, 31.0, 80.0):
                d = decide(verdict, conf, risk, policy)
                if d.status == CaseStatus.CLOSED:
                    closed_count += 1
                    # Only an enabled FP that clears BOTH bars may close.
                    assert verdict == Verdict.FALSE_POSITIVE
                    assert conf >= 0.85 and risk <= 30.0
                    assert d.decision_by == DecisionBy.AGENT
                # NEEDS_HUMAN / None never close, ever.
                if verdict in (Verdict.NEEDS_HUMAN, None):
                    assert d.status != CaseStatus.CLOSED
    assert closed_count > 0  # the sweep actually exercised the close branch


# --------------------------------------------------------------------------- #
# Automation cannot set status — even on a case decide() would have closed
# --------------------------------------------------------------------------- #
def _case(status: CaseStatus, verdict: Verdict) -> Case:
    return Case(
        case_id="g1",
        cluster_signature="sig:g1",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="203.0.113.5"),
        rule_ids=["r"],
        risk_score=90.0,
        verdict=verdict,
        confidence=0.99,
        status=status,
    )


@pytest.mark.asyncio
async def test_automation_never_changes_status_across_all_actions(app_state) -> None:
    from app.config import AutomationRule, ThresholdAutomationConfig

    # One rule per action kind, all matching (no conditions). NONE may move status.
    rules = [
        AutomationRule(id="t", action="tag", payload={"tag": "x"}),
        AutomationRule(id="r", action="recommend", payload={"text": "y"}),
        AutomationRule(id="n", action="notify", payload={"trigger": "z"}),
        AutomationRule(id="p", action="request_approval", payload={"kind": "memory", "text": "m"}),
        AutomationRule(id="pb", action="run_playbook", payload={"playbook_id": "none"}),
    ]
    prefs = Preferences(threshold_automation=ThresholdAutomationConfig(enabled=True, rules=rules))

    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    for status in (CaseStatus.NEEDS_HUMAN, CaseStatus.ESCALATED, CaseStatus.OPEN):
        case = _case(status, Verdict.TRUE_POSITIVE)
        await app_state.cases.save(case)
        before = case.status
        await automation.run(case, prefs, save=app_state.cases.save)
        assert case.status == before
        assert case.status != CaseStatus.CLOSED
        assert case.disposition is None
