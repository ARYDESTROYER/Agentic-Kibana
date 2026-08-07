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
from app.constants import (
    AUDIT_WRITE_ALIAS,
    ActionType,
    CaseStatus,
    DecisionBy,
    EntityType,
    SourceSurface,
    Verdict,
)
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
def test_no_rules_by_default_yields_no_actions() -> None:
    # Autopilot overhaul: the ENGINE defaults ON, but the OOB Preferences ship NO rules,
    # so evaluate() is still a byte-identical no-op (nothing to match).
    prefs = Preferences()
    assert prefs.threshold_automation.enabled is True
    assert prefs.threshold_automation.rules == []
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
# bug #11 — request_approval proposals ROUND-TRIP through Approvals/Proposals.
#
# Before: a generic ``request_approval`` (no field/value) forced kind="suppression",
# so approving it 400'd ("invalid suppression payload") — a dead end. Now the kind is
# resolved to one the approve path can process: a COMPLETE suppression stays
# suppression; explicit Memory stays Memory; anything else becomes an
# acknowledgement-only automation review that always approves cleanly.
# --------------------------------------------------------------------------- #
def test_resolve_proposal_kind_round_trips() -> None:
    from app.engine.threshold_automation import _resolve_proposal_kind

    # A complete suppression payload → suppression (round-trips to a live rule).
    assert _resolve_proposal_kind({"field": "event.module", "value": "sqli"}) == "suppression"
    assert _resolve_proposal_kind(
        {"kind": "suppression", "field": "f", "value": "v"}
    ) == "suppression"
    # A PARTIAL suppression becomes review-only acknowledgement — never emit a kind
    # the approve path would 400 on or materialise it as something stronger.
    assert _resolve_proposal_kind(
        {"kind": "suppression", "field": "f"}
    ) == "automation_ack"
    assert _resolve_proposal_kind({"kind": "suppression"}) == "automation_ack"
    # An explicit Memory stays Memory; a generic gate is acknowledgement-only.
    assert _resolve_proposal_kind({"kind": "memory", "text": "note"}) == "memory"
    assert _resolve_proposal_kind({}) == "automation_ack"
    # An unknown requested kind remains safely reviewable without acquiring Memory
    # semantics.
    assert _resolve_proposal_kind({"kind": "escalate"}) == "automation_ack"


@pytest.mark.asyncio
async def test_generic_request_approval_proposal_is_approvable(app_state: AppState) -> None:
    """A generic ``request_approval`` (no suppression shape) must be APPROVABLE — not a
    dead end. It becomes an acknowledgement-only review and round-trips through the
    REAL approve route without a 400 or unrelated materialisation."""
    from app.api.routes import approve_proposal

    case = _case(case_id="approvable")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    # A generic approval gate — NO field/value, NO explicit kind.
    rules = [_rule("gate", "request_approval", payload={
        "rationale": "Escalation requires a lead's sign-off.",
    })]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    pending = await app_state.proposals.list(status="pending")
    prop = next(p for p in pending if p.source_case_ids == ["approvable"])
    assert prop.kind == "automation_ack"
    assert (prop.payload or {}).get("rule_id") == "gate"
    assert not (prop.payload or {}).get("text")

    # The full round-trip: approval marks the checkpoint reviewed, but creates no
    # Memory, suppression, preference, or case-lifecycle side effect.
    status_before = case.status
    memories_before = [m.model_dump(mode="json") for m in await app_state.memory.list(False)]
    prefs_before = app_state.execution_prefs.model_dump(mode="json")
    res = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert res["ok"] is True
    approved = await app_state.proposals.get(prop.id)
    assert approved is not None and approved.status == "approved"
    assert case.status == status_before  # approval never touches the case lifecycle (#3)
    assert [m.model_dump(mode="json") for m in await app_state.memory.list(False)] == memories_before
    assert app_state.execution_prefs.model_dump(mode="json") == prefs_before


@pytest.mark.asyncio
async def test_explicit_memory_request_approval_still_materialises_memory(
    app_state: AppState,
) -> None:
    """The new generic review kind must not weaken a deliberate Memory proposal."""
    from app.api.routes import approve_proposal

    case = _case(case_id="memory")
    await app_state.cases.save(case)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = [_rule("remember", "request_approval", payload={
        "kind": "memory",
        "text": "The approved maintenance scanner uses the internal relay.",
        "category": "operations",
    })]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    prop = next(
        p for p in await app_state.proposals.list(status="pending")
        if p.source_case_ids == ["memory"]
    )
    assert prop.kind == "memory"
    res = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert res["ok"] is True
    memories = await app_state.memory.list(False)
    assert any(
        m.text == "The approved maintenance scanner uses the internal relay."
        and m.review_status == "approved"
        for m in memories
    )


@pytest.mark.asyncio
async def test_concurrent_memory_approval_materialises_exactly_once(
    app_state: AppState,
) -> None:
    """Only one strict pending->applying claim may cross the side-effect boundary."""
    import asyncio

    from fastapi import HTTPException

    from app.api.routes import approve_proposal
    from app.models import Proposal

    prop = Proposal(
        kind="memory",
        payload={"text": "The maintenance relay is approved."},
        rationale="Record a reviewed fact.",
    )
    await app_state.proposals.add(prop)
    req = _ApproveRequest(app_state)
    results = await asyncio.gather(
        approve_proposal(prop.id, req, state=app_state),
        approve_proposal(prop.id, req, state=app_state),
        return_exceptions=True,
    )

    assert sum(isinstance(result, dict) and result.get("ok") is True for result in results) == 1
    conflicts = [result for result in results if isinstance(result, HTTPException)]
    assert len(conflicts) == 1 and conflicts[0].status_code == 409
    materialised = [
        m for m in await app_state.memory.list(False)
        if m.approval_proposal_id == prop.id
    ]
    assert len(materialised) == 1


@pytest.mark.asyncio
async def test_memory_approval_storage_failure_is_visible_and_retryable(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A fail-soft KV write can never become a reported trusted-Memory success."""
    from fastapi import HTTPException

    from app.api.routes import approve_proposal
    from app.constants import MEMORY_NS
    from app.models import Proposal

    prop = Proposal(kind="memory", payload={"text": "Must persist before trust."})
    await app_state.proposals.add(prop)
    original = app_state.memory._kv.put_if_strict

    async def _fail_memory(namespace, key, value, expected_rev):
        if namespace == MEMORY_NS:
            raise RuntimeError("memory store unavailable")
        return await original(namespace, key, value, expected_rev)

    monkeypatch.setattr(app_state.memory._kv, "put_if_strict", _fail_memory)
    with pytest.raises(HTTPException) as caught:
        await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert caught.value.status_code == 503
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"
    assert "memory store unavailable" in str(stored.approval_error)
    assert not any(m.approval_proposal_id == prop.id for m in await app_state.memory.list(False))


@pytest.mark.asyncio
async def test_retry_after_finalize_failure_does_not_duplicate_memory(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A confirmed side effect is reused if strict proposal finalisation must retry."""
    from fastapi import HTTPException

    from app.api.routes import approve_proposal
    from app.models import Proposal

    prop = Proposal(kind="memory", payload={"text": "Exactly-once reviewed fact."})
    await app_state.proposals.add(prop)
    original = app_state.proposals.finalize_approval
    calls = 0

    async def _fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("proposal finalisation unavailable")
        return await original(*args, **kwargs)

    monkeypatch.setattr(app_state.proposals, "finalize_approval", _fail_once)
    with pytest.raises(HTTPException) as first:
        await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert first.value.status_code == 503
    assert len([
        m for m in await app_state.memory.list(False)
        if m.approval_proposal_id == prop.id
    ]) == 1
    audit = await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:approve"
    )
    assert audit is not None
    assert f"proposal_id={prop.id}" in str(audit.get("result_summary"))

    second = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert second["ok"] is True
    assert len([
        m for m in await app_state.memory.list(False)
        if m.approval_proposal_id == prop.id
    ]) == 1


@pytest.mark.asyncio
async def test_approval_crash_after_audit_keeps_first_actor_on_different_operator_retry(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stale retry confirms the first immutable effect/audit instead of reattributing."""
    from app.api import routes as routes_module
    from app.models import Proposal

    prop = Proposal(kind="memory", payload={"text": "Alice reviewed this fact."})
    await app_state.proposals.add(prop)
    claimed, outcome = await app_state.proposals.claim_approval(
        prop.id, by="alice", token="approval-before-crash"
    )
    assert outcome == "claimed" and claimed is not None
    assert claimed.decision_actor == "alice"

    # The first process durably completed its effect and audit, then died before
    # proposal finalisation. These writes are the state the second process sees.
    await app_state.memory.add_approved_proposal_strict(
        "Alice reviewed this fact.",
        proposal_id=prop.id,
        author="alice",
    )
    await app_state.control_audit.record_strict(
        action_type=ActionType.PROPOSAL,
        event_id=f"proposal-decision:{prop.id}:approve",
        ts=claimed.decision_audit_at,
        surface="proposal",
        actor="alice",
        result_summary=(
            f"proposal_id={prop.id} action=approve kind=memory "
            "decision=authorized effect=pending finalization=pending"
        ),
    )

    monkeypatch.setattr(
        type(app_state.proposals),
        "_lease_is_stale",
        staticmethod(lambda _proposal: True),
    )
    monkeypatch.setattr(routes_module, "current_username", lambda _request: "bob")
    retried = await routes_module.approve_proposal(
        prop.id, _ApproveRequest(app_state), state=app_state
    )

    assert retried["ok"] is True
    assert "decision_actor" not in retried["proposal"]
    assert "applying_token" not in retried["proposal"]
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.decided_by == "alice"
    assert stored.decision_actor == "alice"
    memories = [
        item for item in await app_state.memory.list(False)
        if item.approval_proposal_id == prop.id
    ]
    assert len(memories) == 1 and memories[0].author == "alice"
    audit = await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:approve"
    )
    assert audit is not None and audit["actor"] == "alice"


@pytest.mark.asyncio
async def test_approval_audit_failure_is_visible_and_retryable_without_duplicate_effect(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """No approval success is reported without strict append-only evidence.

    The decision record is written BEFORE the effect, so an audit failure leaves the
    configuration untouched — an operator told the approval failed must never find
    the change already applied. The retry then converges on exactly one effect.
    """
    from fastapi import HTTPException

    from app.api.routes import approve_proposal
    from app.models import Proposal

    prop = Proposal(kind="memory", payload={"text": "Audited reviewed fact."})
    await app_state.proposals.add(prop)
    original = app_state.control_audit.record_strict
    calls = 0

    async def _fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("audit ledger unavailable")
        return await original(*args, **kwargs)

    monkeypatch.setattr(app_state.control_audit, "record_strict", _fail_once)
    with pytest.raises(HTTPException) as first:
        await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert first.value.status_code == 503
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"
    assert "audit ledger unavailable" in str(stored.approval_error)
    assert [
        item for item in await app_state.memory.list(False)
        if item.approval_proposal_id == prop.id
    ] == []

    retried = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert retried["ok"] is True
    assert len([
        item for item in await app_state.memory.list(False)
        if item.approval_proposal_id == prop.id
    ]) == 1
    assert await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:approve"
    ) is not None


@pytest.mark.asyncio
async def test_rejection_audit_failure_keeps_proposal_retryable(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reject uses the same strict claim/audit/finalise boundary as approve."""
    from fastapi import HTTPException

    from app.api.routes import reject_proposal
    from app.models import Proposal

    prop = Proposal(kind="automation_ack", rationale="Lead review")
    await app_state.proposals.add(prop)
    original = app_state.control_audit.record_strict
    calls = 0

    async def _fail_once(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("audit ledger unavailable")
        return await original(*args, **kwargs)

    monkeypatch.setattr(app_state.control_audit, "record_strict", _fail_once)
    with pytest.raises(HTTPException) as first:
        await reject_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert first.value.status_code == 503
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.status == "pending"
    assert stored.decision_intent == "reject"

    retried = await reject_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert retried["ok"] is True
    assert retried["proposal"]["status"] == "rejected"
    assert "applying_token" not in retried["proposal"]
    assert await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:reject"
    ) is not None


@pytest.mark.asyncio
async def test_rejection_crash_after_audit_keeps_first_actor_on_retry(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A different operator can recover a stale rejection without owning its audit."""
    from app.api import routes as routes_module
    from app.models import Proposal

    prop = Proposal(kind="automation_ack", rationale="Review this checkpoint.")
    await app_state.proposals.add(prop)
    claimed, outcome = await app_state.proposals.claim_rejection(
        prop.id, by="alice", token="rejection-before-crash"
    )
    assert outcome == "claimed" and claimed is not None
    await app_state.control_audit.record_strict(
        action_type=ActionType.PROPOSAL,
        event_id=f"proposal-decision:{prop.id}:reject",
        ts=claimed.decision_audit_at,
        surface="proposal",
        actor="alice",
        result_summary=(
            f"proposal_id={prop.id} action=reject kind=automation_ack "
            "effect=none finalization=pending"
        ),
    )

    monkeypatch.setattr(
        type(app_state.proposals),
        "_lease_is_stale",
        staticmethod(lambda _proposal: True),
    )
    monkeypatch.setattr(routes_module, "current_username", lambda _request: "bob")
    retried = await routes_module.reject_proposal(
        prop.id, _ApproveRequest(app_state), state=app_state
    )

    assert retried["ok"] is True
    assert "decision_actor" not in retried["proposal"]
    stored = await app_state.proposals.get(prop.id)
    assert stored is not None and stored.decided_by == "alice"
    assert stored.decision_actor == "alice"
    audit = await app_state.control_audit._es.get_doc(
        AUDIT_WRITE_ALIAS, f"proposal-decision:{prop.id}:reject"
    )
    assert audit is not None and audit["actor"] == "alice"


@pytest.mark.asyncio
async def test_complete_suppression_request_approval_still_round_trips(app_state: AppState) -> None:
    """A ``request_approval`` carrying a COMPLETE suppression payload keeps the
    suppression round-trip (approving it adds a live rule) — no regression."""
    from app.api.routes import approve_proposal

    case = _case(case_id="suppr")
    await app_state.cases.save(case)
    n_rules_before = len(app_state.prefs.suppression_rules)
    automation = ThresholdAutomation(app_state.proposals, app_state.audit)
    rules = [_rule("appr", "request_approval", payload={
        "kind": "suppression", "field": "event.module", "value": "modsec_sqli",
        "confidence": 0.7,
    })]
    await automation.run(case, _prefs_with(rules), save=app_state.cases.save)

    prop = next(
        p for p in await app_state.proposals.list(status="pending")
        if p.source_case_ids == ["suppr"]
    )
    assert prop.kind == "suppression"
    res = await approve_proposal(prop.id, _ApproveRequest(app_state), state=app_state)
    assert res["ok"] is True
    # A live suppression rule was materialised by the approve path.
    assert len(app_state.prefs.suppression_rules) == n_rules_before + 1


class _ApproveRequest:
    """Minimal Request stand-in for the approve route (auth OFF in tests → the route's
    ``current_username`` resolves to '' without a cookie). Exposes ``app.state.tlsoc``
    so ``get_state(request)`` resolves the live AppState."""

    def __init__(self, state: AppState) -> None:
        self.headers = {}
        self.cookies = {}
        self.scope = {"type": "http"}
        self.app = type("_App", (), {"state": type("_S", (), {"tlsoc": state})()})()


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
