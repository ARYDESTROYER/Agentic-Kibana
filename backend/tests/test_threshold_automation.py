"""Wave 6 / F10 — threshold automation (post-decision, #3-safe).

Offline tests (fake ES + mock LLM). They assert the central #3 boundary: automation
runs AFTER decide()+apply()+save and may ONLY tag / recommend / notify / queue a
re-investigation (which itself re-runs decide()) / open a HITL Proposal. It can
NEVER set case.status/disposition, never auto-close, and decide() stays the ONLY
producer of CLOSED.
"""

from __future__ import annotations

import pytest

from app.config import (
    AutomationRule,
    Preferences,
    ThresholdAutomationConfig,
)
from app.constants import ActionType, CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.case_manager import decide
from app.engine.threshold_automation import ThresholdAutomation, evaluate
from app.models import Case, Entity
from app.state import AppState


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _case(
    *, case_id: str = "c1", verdict: Verdict | None = Verdict.TRUE_POSITIVE,
    risk: float = 80.0, status: CaseStatus = CaseStatus.NEEDS_HUMAN,
    rule: str = "modsec_sqli", source_id: str = "src-1",
    entity_type: EntityType = EntityType.IP, ip: str = "203.0.113.5",
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=entity_type, value=ip),
        rule_ids=[rule],
        source_id=source_id,
        risk_score=risk,
        verdict=verdict,
        confidence=0.9,
        status=status,
    )


def _rule(id_: str, action: str, *, priority: int = 100, enabled: bool = True,
          conditions: dict | None = None, payload: dict | None = None) -> AutomationRule:
    return AutomationRule(
        id=id_, action=action, priority=priority, enabled=enabled,
        conditions=conditions or {}, payload=payload or {},
    )


def _prefs_with(rules: list[AutomationRule], *, enabled: bool = True) -> Preferences:
    return Preferences(
        threshold_automation=ThresholdAutomationConfig(enabled=enabled, rules=rules)
    )


# --------------------------------------------------------------------------- #
# evaluate() — matching + priority order + disabled-by-default
# --------------------------------------------------------------------------- #
def test_disabled_by_default_yields_no_actions() -> None:
    # The OOB Preferences have threshold_automation.enabled=False.
    prefs = Preferences()
    assert prefs.threshold_automation.enabled is False
    assert evaluate(_case(), prefs) == []


def test_rules_match_in_priority_order() -> None:
    rules = [
        _rule("low", "tag", priority=300, payload={"tag": "c"}),
        _rule("high", "tag", priority=10, payload={"tag": "a"}),
        _rule("mid", "tag", priority=100, payload={"tag": "b"}),
    ]
    actions = evaluate(_case(), _prefs_with(rules))
    assert [a.rule_id for a in actions] == ["high", "mid", "low"]


def test_conditions_all_of_match() -> None:
    case = _case(verdict=Verdict.TRUE_POSITIVE, risk=80.0, rule="modsec_sqli",
                 source_id="src-1", entity_type=EntityType.IP)
    # Matches: all conditions hold.
    r = _rule("m", "tag", conditions={
        "verdict": "TRUE_POSITIVE", "min_risk": 50, "source_id": "src-1",
        "rule_name": "modsec_sqli", "entity_type": "ip",
    }, payload={"tag": "match"})
    assert [a.rule_id for a in evaluate(case, _prefs_with([r]))] == ["m"]

    # One condition fails (wrong verdict) → no match.
    r2 = _rule("nm", "tag", conditions={"verdict": "FALSE_POSITIVE"})
    assert evaluate(case, _prefs_with([r2])) == []

    # min_risk above the case risk → no match.
    r3 = _rule("nm2", "tag", conditions={"min_risk": 99})
    assert evaluate(case, _prefs_with([r3])) == []

    # status condition.
    r4 = _rule("st", "tag", conditions={"status": "needs_human"})
    assert [a.rule_id for a in evaluate(case, _prefs_with([r4]))] == ["st"]


def test_disabled_rule_skipped() -> None:
    rules = [_rule("off", "tag", enabled=False), _rule("on", "tag")]
    assert [a.rule_id for a in evaluate(_case(), _prefs_with(rules))] == ["on"]


# --------------------------------------------------------------------------- #
# execute() — SAFE actions apply directly (#3-safe)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_tag_and_recommend_apply_without_touching_status(app_state: AppState) -> None:
    case = _case(case_id="ct", status=CaseStatus.NEEDS_HUMAN)
    await app_state.cases.save(case)
    rules = [
        _rule("tag1", "tag", priority=10, payload={"tag": "auto-high-risk"}),
        _rule("rec1", "recommend", priority=20, payload={"text": "isolate the host"}),
    ]
    prefs = _prefs_with(rules)

    status_before, disposition_before = case.status, case.disposition
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    await automation.run(case, prefs, save=app_state.cases.save)

    # SAFE actions applied: tag + a recommendation comment.
    assert "auto-high-risk" in case.tags
    assert any("isolate the host" in c.body for c in case.comments)
    # Status / disposition are UNTOUCHED (#3).
    assert case.status == status_before
    assert case.disposition == disposition_before
    # Each action recorded on the additive audit list.
    assert {a["action"] for a in case.automation_actions} == {"tag", "recommend"}
    # ...and persisted.
    reloaded = await app_state.cases.get("ct")
    assert "auto-high-risk" in reloaded.tags


@pytest.mark.asyncio
async def test_notify_action_dispatches_via_callback(app_state: AppState) -> None:
    case = _case(case_id="cn")
    await app_state.cases.save(case)
    seen: list[tuple[str, str]] = []

    async def _notify(c, trigger):
        seen.append((c.case_id, trigger))

    automation = ThresholdAutomation(app_state.proposals, app_state.audit, notify=_notify)
    rules = [_rule("n", "notify", payload={"trigger": "escalated"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert seen == [("cn", "escalated")]
    assert case.status == CaseStatus.NEEDS_HUMAN  # unchanged


# --------------------------------------------------------------------------- #
# request_approval → HITL Proposal (NO live write)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_request_approval_creates_pending_proposal_no_live_write(app_state: AppState) -> None:
    case = _case(case_id="ca")
    await app_state.cases.save(case)
    suppression_before = list(app_state.prefs.suppression_rules)

    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = [_rule("appr", "request_approval", payload={
        "kind": "suppression", "field": "event.module", "value": "modsec_sqli",
        "confidence": 0.7,
    })]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    # A PENDING proposal exists; nothing was written live.
    pending = await app_state.proposals.list(status="pending")
    assert any(p.source_case_ids == ["ca"] and p.created_by == "automation" for p in pending)
    # No live suppression rule materialised (only approval writes live).
    assert list(app_state.prefs.suppression_rules) == suppression_before
    # The case records the proposal id, status untouched.
    appr = [a for a in case.automation_actions if a["action"] == "request_approval"]
    assert appr and appr[0].get("proposal_id")
    assert case.status == CaseStatus.NEEDS_HUMAN


# --------------------------------------------------------------------------- #
# run_playbook → QUEUES a re-investigation that re-runs decide() (not bypassed)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_run_playbook_queues_reinvestigation_calling_decide_again(app_state: AppState) -> None:
    case = _case(case_id="cp")
    await app_state.cases.save(case)
    queued: list[tuple[str, str]] = []

    async def _queue(c, playbook_id):
        # Simulate the re-investigation path: it calls decide() AGAIN with the case's
        # (possibly new) verdict/risk and the operator policy — automation never sets
        # status itself; only a fresh decide() can.
        queued.append((c.case_id, playbook_id))
        d = decide(c.verdict, c.confidence, c.risk_score, app_state.prefs.auto_close)
        assert d is not None  # decide() is the producer of any status change

    automation = ThresholdAutomation(
        app_state.proposals, app_state.audit, queue_playbook_run=_queue
    )
    rules = [_rule("pb", "run_playbook", payload={"playbook_id": "mail_bruteforce"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert queued == [("cp", "mail_bruteforce")]
    assert case.status == CaseStatus.NEEDS_HUMAN  # automation never moved status


# --------------------------------------------------------------------------- #
# THE #3 GUARDRAIL — automation can NEVER set status; NEEDS_HUMAN/escalated never close
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_automation_cannot_close_a_needs_human_case(app_state: AppState) -> None:
    case = _case(case_id="cnh", verdict=Verdict.NEEDS_HUMAN, status=CaseStatus.NEEDS_HUMAN)
    await app_state.cases.save(case)
    # Even a malicious-looking rule can only tag/recommend/notify/queue/propose — none
    # of which write status. The executor double-asserts status didn't move.
    rules = [
        _rule("t", "tag", payload={"tag": "x"}),
        _rule("r", "recommend", payload={"text": "y"}),
    ]
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    assert case.status == CaseStatus.NEEDS_HUMAN
    assert case.status != CaseStatus.CLOSED


@pytest.mark.asyncio
async def test_executor_raises_if_an_action_mutated_status(app_state: AppState, monkeypatch) -> None:
    """Defence-in-depth: if a future action ever mutated status, the executor's
    post-run #3 assertion fires (status is byte-stable across automation)."""
    case = _case(case_id="cmut")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)

    # Patch _execute_one to illegally close the case (simulating a regression).
    async def _bad(c, action, prefs):
        c.status = CaseStatus.CLOSED
        return True

    monkeypatch.setattr(automation, "_execute_one", _bad)
    rules = [_rule("bad", "tag")]
    with pytest.raises(AssertionError):
        await automation.run(case, _prefs_with(rules), save=app_state.cases.save)


# --------------------------------------------------------------------------- #
# decide() is the ONLY producer of CLOSED (verdict math byte-identical)
# --------------------------------------------------------------------------- #
def test_decide_is_only_producer_of_closed() -> None:
    """Automation must never short-circuit the close decision. Sweep verdict/risk
    combos and assert CLOSED only ever comes from decide() (per the policy)."""
    prefs = Preferences()
    policy = prefs.auto_close

    # FP clears the FP bar (default enabled, min_conf 0.85, max_risk 30) → CLOSED.
    d = decide(Verdict.FALSE_POSITIVE, 0.9, 10.0, policy)
    assert d.status == CaseStatus.CLOSED and d.decision_by == DecisionBy.AGENT

    # NEEDS_HUMAN never closes regardless of inputs.
    for conf in (0.0, 0.5, 1.0):
        d = decide(Verdict.NEEDS_HUMAN, conf, 0.0, policy)
        assert d.status != CaseStatus.CLOSED

    # TP default policy is disabled → never closes (even at high confidence).
    d = decide(Verdict.TRUE_POSITIVE, 0.99, 5.0, policy)
    assert d.status != CaseStatus.CLOSED

    # None/unknown verdict → human (fail-safe), never CLOSED.
    assert decide(None, 1.0, 0.0, policy).status != CaseStatus.CLOSED


@pytest.mark.asyncio
async def test_automation_audits_each_action(app_state: AppState) -> None:
    case = _case(case_id="caud")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = [_rule("t", "tag", payload={"tag": "audited"})]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)
    rows = await app_state.audit.records_for_case("caud")
    types = {
        (r.get("action_type") if isinstance(r, dict) else getattr(r, "action_type", None))
        for r in rows
    }
    # AUTOMATION action_type was recorded (may be the enum value string).
    assert ActionType.AUTOMATION.value in {str(getattr(t, "value", t)) for t in types}
