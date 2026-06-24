"""PART 2 — agent-DRAFTED suppression/asset PROPOSALS with HUMAN APPROVAL.

Offline tests (fake ES + mock LLM, SQLite-capable). Covers:
  * ProposalStore round-trip over the KV (no migration): add/list/get/set_status,
    durable across a fresh store instance.
  * draft_suppression_proposal: proposes a sound literal field==value for a clean
    FP; returns None for denylisted/over-broad cases (bare IP, severity, cross-rule)
    and NEVER invents a selector absent from the events.
  * approve(suppression): appends a live SuppressionRule that the cost gate honours;
    enabled=False / expired rules are NOT dropped.
  * reject: prefs unchanged.
  * confirm_fp still 200s + still indexes the resolved_case RAG chunk even if the
    proposer raises (fail-safe isolation).
  * decide() is byte-identical (we didn't touch the close/escalate math).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from functools import partial

from app.agents.proposer import draft_suppression_proposal
from app.config import AutoClosePolicy, Preferences, SuppressionRule, VerdictAutoClose
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine.case_manager import Decision, decide
from app.engine.correlation import cluster_from_events
from app.engine.cost_gate import passes_suppression
from app.models import Case, Entity, Proposal
from app.state import AppState
from app.stores.proposals import ProposalStore

from tests.conftest import make_log_event, make_raw_event


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _fp_case(
    *, case_id: str = "c1", rule: str = "linux_auth", ip: str = "203.0.113.10",
    member_ids: list[str] | None = None,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=ip),
        rule_ids=[rule],
        member_event_ids=member_ids or [],
        verdict=Verdict.FALSE_POSITIVE,
        confidence=0.9,
        status=CaseStatus.CLOSED,
    )


async def _seed_events(state: AppState, *, rule: str, ip: str, n: int, **extra) -> list[str]:
    """Seed n matching log events into the fake ES; return their ids."""
    es = state.es
    ids = []
    for i in range(n):
        src = make_log_event(rule=rule, ip=ip, **extra)
        ids.append(es.add_log("all-logs-2026.06.16", src, doc_id=f"{rule}-{ip}-{i}"))
    return ids


# --------------------------------------------------------------------------- #
# ProposalStore round-trip (over the KV, no migration)
# --------------------------------------------------------------------------- #
async def test_proposal_store_crud(app_state: AppState) -> None:
    store: ProposalStore = app_state.proposals
    assert await store.list() == []

    p = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "linux_auth"},
        rationale="why", confidence=0.8, source_case_ids=["c1"], created_by="agent",
    )
    await store.add(p)

    listed = await store.list()
    assert len(listed) == 1 and listed[0].id == p.id
    assert await store.get(p.id) is not None
    assert await store.get("prop-nope") is None

    # filter by status
    assert len(await store.list(status="pending")) == 1
    assert len(await store.list(status="approved")) == 0

    # set_status records decided_by/decided_at
    updated = await store.set_status(p.id, "approved", by="alice")
    assert updated is not None and updated.status == "approved"
    assert updated.decided_by == "alice" and updated.decided_at
    assert len(await store.list(status="pending")) == 0
    assert len(await store.list(status="approved")) == 1

    # set_status on a missing id → None
    assert await store.set_status("prop-missing", "rejected", by="x") is None


async def test_proposal_store_durable_across_instances(app_state: AppState) -> None:
    p = Proposal(kind="memory", payload={"text": "host web01 is public"}, created_by="agent")
    await app_state.proposals.add(p)
    fresh = ProposalStore(app_state._kv)
    ids = [x.id for x in await fresh.list()]
    assert p.id in ids


# --------------------------------------------------------------------------- #
# draft_suppression_proposal — sound proposals + anti-poisoning denials
# --------------------------------------------------------------------------- #
async def test_draft_proposes_literal_selector_for_clean_fp(app_state: AppState) -> None:
    ids = await _seed_events(app_state, rule="benign_scanner", ip="10.1.2.3", n=6)
    case = _fp_case(rule="benign_scanner", ip="10.1.2.3", member_ids=ids)

    prop = await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs)
    assert prop is not None
    assert prop.kind == "suppression"
    # The selector field is on the allowlist AND its value LITERALLY appears in events.
    field, value = prop.payload["field"], prop.payload["value"]
    assert field in ("event.module", "rule.name", "event.action", "event.code")
    # event.module / rule.name == "benign_scanner"; event.action == "login".
    assert value in ("benign_scanner", "login")
    assert prop.confidence > 0.5
    assert case.case_id in prop.source_case_ids
    assert prop.expires_at  # self-retiring


async def test_draft_returns_none_for_non_fp(app_state: AppState) -> None:
    ids = await _seed_events(app_state, rule="some_rule", ip="10.0.0.5", n=5)
    case = _fp_case(rule="some_rule", ip="10.0.0.5", member_ids=ids)
    case.verdict = Verdict.TRUE_POSITIVE
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None
    case.verdict = Verdict.NEEDS_HUMAN
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None
    case.verdict = None
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None


async def test_draft_returns_none_for_cross_rule(app_state: AppState) -> None:
    # Two distinct rule ids on the case → over-broad → propose nothing.
    ids = await _seed_events(app_state, rule="rule_a", ip="10.0.0.9", n=4)
    case = _fp_case(rule="rule_a", ip="10.0.0.9", member_ids=ids)
    case.rule_ids = ["rule_a", "rule_b"]
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None


async def test_draft_never_proposes_bare_entity_or_severity(app_state: AppState) -> None:
    # Even though source.ip / event.severity literally appear in the events, the
    # denylist forbids proposing on them — the selector must be a safe rule-ish field.
    ids = await _seed_events(app_state, rule="auth_fail", ip="198.51.100.7", n=5)
    case = _fp_case(rule="auth_fail", ip="198.51.100.7", member_ids=ids)
    prop = await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs)
    assert prop is not None
    field = prop.payload["field"]
    # Never the IP / user / host / severity field.
    assert field not in (
        app_state.prefs.source_ip_field, app_state.prefs.user_field,
        app_state.prefs.host_field, app_state.prefs.severity_field,
    )
    assert field not in ("@timestamp", "message", "event.original")


async def test_draft_never_invents_absent_selector(app_state: AppState) -> None:
    # No member events available at all → cannot derive any literal selector → None.
    case = _fp_case(rule="ghost_rule", ip="10.0.0.99", member_ids=[])
    assert await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs) is None


async def test_draft_requires_value_prevalence(app_state: AppState) -> None:
    # A field whose value differs in every event (no dominant value) is not proposed
    # on that field; the proposer falls back to a field with a common value (rule).
    es = app_state.es
    ids = []
    for i in range(6):
        # process.name differs every event; event.module is constant.
        src = make_log_event(rule="const_rule", ip="10.5.5.5")
        src["process"] = {"name": f"proc-{i}"}
        ids.append(es.add_log("all-logs-2026.06.16", src, doc_id=f"prev-{i}"))
    case = _fp_case(rule="const_rule", ip="10.5.5.5", member_ids=ids)
    prop = await draft_suppression_proposal(case, source=app_state.log_source, prefs=app_state.prefs)
    assert prop is not None
    # Must NOT pick the per-event-varying process.name; picks the constant rule field.
    assert prop.payload["field"] != "process.name"
    assert prop.payload["value"] == "const_rule"


# --------------------------------------------------------------------------- #
# Approve / reject endpoints (HITL — human is the only live-write path)
# --------------------------------------------------------------------------- #
def _make_cluster(rule: str, ip: str, n: int = 6):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, rule=rule, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


async def test_approve_suppression_adds_live_rule(client) -> None:
    state: AppState = client.app.state.tlsoc
    # A pending suppression proposal targeting event.module==noisy_rule.
    p = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "noisy_rule",
                 "reason": "auto", "confidence": 0.9, "created_by": "agent", "enabled": True},
        rationale="from FP case", confidence=0.9, source_case_ids=["c-fp"], created_by="agent",
    )
    await state.proposals.add(p)

    # Before approval: a noisy_rule cluster is NOT suppressed.
    cluster = _make_cluster("noisy_rule", "10.9.9.9")
    assert passes_suppression(cluster, state.prefs) is True

    r = client.post(f"/api/proposals/{p.id}/approve")
    assert r.status_code == 200, r.text
    assert r.json()["proposal"]["status"] == "approved"

    # The rule is now live in prefs and the matching cluster is dropped.
    rules = state.prefs.suppression_rules
    assert any(rr.field == "event.module" and rr.value == "noisy_rule" for rr in rules)
    cluster2 = _make_cluster("noisy_rule", "10.9.9.9")
    assert passes_suppression(cluster2, state.prefs) is False

    # Approving an already-decided proposal → 409.
    assert client.post(f"/api/proposals/{p.id}/approve").status_code == 409
    # Unknown id → 404.
    assert client.post("/api/proposals/prop-nope/approve").status_code == 404


async def test_approved_rule_honors_enabled_and_expiry(client) -> None:
    state: AppState = client.app.state.tlsoc
    # disabled rule → NOT dropped
    p_dis = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "disabled_rule", "enabled": False},
        confidence=0.8, created_by="agent",
    )
    await state.proposals.add(p_dis)
    assert client.post(f"/api/proposals/{p_dis.id}/approve").status_code == 200
    cluster = _make_cluster("disabled_rule", "10.2.2.2")
    assert passes_suppression(cluster, state.prefs) is True  # disabled → still investigated

    # expired rule → NOT dropped
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    p_exp = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "expired_rule", "enabled": True, "expires_at": past},
        confidence=0.8, created_by="agent", expires_at=past,
    )
    await state.proposals.add(p_exp)
    assert client.post(f"/api/proposals/{p_exp.id}/approve").status_code == 200
    cluster2 = _make_cluster("expired_rule", "10.3.3.3")
    assert passes_suppression(cluster2, state.prefs) is True  # expired → still investigated


async def test_reject_leaves_prefs_unchanged(client) -> None:
    state: AppState = client.app.state.tlsoc
    before = list(state.prefs.suppression_rules)
    p = Proposal(
        kind="suppression",
        payload={"field": "event.module", "value": "rejected_rule"},
        confidence=0.7, created_by="agent",
    )
    await state.proposals.add(p)
    r = client.post(f"/api/proposals/{p.id}/reject")
    assert r.status_code == 200
    assert r.json()["proposal"]["status"] == "rejected"
    # Prefs untouched; the rejected rule never went live.
    assert state.prefs.suppression_rules == before
    cluster = _make_cluster("rejected_rule", "10.4.4.4")
    assert passes_suppression(cluster, state.prefs) is True
    # Reject again → 409.
    assert client.post(f"/api/proposals/{p.id}/reject").status_code == 409


def test_list_proposals_filters_by_status(client) -> None:
    # Empty to start.
    assert client.get("/api/proposals").json()["count"] == 0
    # Add two pending proposals via the store (on the app loop, via the test portal).
    state: AppState = client.app.state.tlsoc
    p1 = Proposal(kind="suppression", payload={"field": "event.module", "value": "r1"}, created_by="agent")
    p2 = Proposal(kind="suppression", payload={"field": "event.module", "value": "r2"}, created_by="agent")
    client.portal.call(state.proposals.add, p1)
    client.portal.call(state.proposals.add, p2)
    assert client.get("/api/proposals").json()["count"] == 2
    assert client.get("/api/proposals?status=pending").json()["count"] == 2
    assert client.get("/api/proposals?status=approved").json()["count"] == 0


# --------------------------------------------------------------------------- #
# confirm_fp drafts a proposal end-to-end + fail-safe isolation
# --------------------------------------------------------------------------- #
def test_confirm_fp_drafts_proposal(client) -> None:
    state: AppState = client.app.state.tlsoc
    # Seed events + a closed-able case with a single rule.
    ids = client.portal.call(partial(_seed_events, state, rule="quiet_rule", ip="10.7.7.7", n=5))
    case = _fp_case(case_id="cfp", rule="quiet_rule", ip="10.7.7.7", member_ids=ids)
    case.status = CaseStatus.NEEDS_HUMAN
    case.verdict = Verdict.FALSE_POSITIVE
    client.portal.call(state.cases.save, case)

    r = client.post("/api/cases/cfp/action", json={"action": "confirm_fp", "analyst": "ana", "note": "benign scanner"})
    assert r.status_code == 200

    proposals = client.get("/api/proposals?status=pending").json()["proposals"]
    assert any(p["source_case_ids"] == ["cfp"] for p in proposals)


def test_confirm_fp_succeeds_and_indexes_rag_even_if_proposer_raises(client, monkeypatch) -> None:
    state: AppState = client.app.state.tlsoc
    # Force resolved_case RAG indexing ON so we can assert the chunk is written.
    prefs = state.prefs.model_copy(update={
        "rag": state.prefs.rag.model_copy(update={"enabled": True, "use_resolved_cases": True}),
    })
    client.portal.call(state.update_prefs, prefs)

    # Make the proposer EXPLODE — the close must still 200 and still index the chunk.
    import app.agents.proposer as proposer_mod

    async def _boom(*a, **k):
        raise RuntimeError("proposer blew up")

    monkeypatch.setattr(proposer_mod, "draft_suppression_proposal", _boom)

    indexed: dict = {}
    orig_index = state.rag.index_resolved_case

    async def _spy(case, note=""):
        indexed["called"] = True
        return await orig_index(case, note=note)

    monkeypatch.setattr(state.rag, "index_resolved_case", _spy)

    ids = client.portal.call(partial(_seed_events, state, rule="boom_rule", ip="10.8.8.8", n=3))
    case = _fp_case(case_id="cboom", rule="boom_rule", ip="10.8.8.8", member_ids=ids)
    case.status = CaseStatus.OPEN
    client.portal.call(state.cases.save, case)

    r = client.post("/api/cases/cboom/action", json={"action": "confirm_fp", "analyst": "ana", "note": "fp"})
    assert r.status_code == 200  # the analyst's close is NEVER broken by the proposer
    assert indexed.get("called") is True  # the resolved_case RAG chunk was still indexed
    # No proposal was drafted (the proposer raised → caught → nothing added).
    assert client.get("/api/proposals").json()["count"] == 0


# --------------------------------------------------------------------------- #
# decide() byte-identical — we did NOT touch the close/escalate math
# --------------------------------------------------------------------------- #
def test_decide_is_unchanged() -> None:
    """A focused equality snapshot over (verdict, confidence, risk, policy) combos.

    These EXPECTED values were captured from the unmodified case_manager.decide();
    any drift means the verdict/close math was altered (a Part-2 guardrail breach).
    """
    policy = AutoClosePolicy(
        false_positive=VerdictAutoClose(enabled=True, min_confidence=0.8, max_risk_score=40.0,
                                        objection_window_minutes=60),
        true_positive=VerdictAutoClose(enabled=False, min_confidence=0.9, max_risk_score=20.0,
                                       objection_window_minutes=60),
    )

    def shape(d: Decision) -> tuple:
        # objection_window_expires_at is time-relative — assert only its presence.
        return (d.status, d.decision_by, d.escalate, bool(d.objection_window_expires_at))

    # FP clears the bar → auto-closed by agent, objection window set.
    d = decide(Verdict.FALSE_POSITIVE, 0.9, 10.0, policy)
    assert shape(d) == (CaseStatus.CLOSED, d.decision_by, False, True)
    assert d.status == CaseStatus.CLOSED and d.decision_by.value == "agent"

    # FP below confidence bar → human, no window.
    d = decide(Verdict.FALSE_POSITIVE, 0.5, 10.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN and d.decision_by.value == "system"
    assert d.objection_window_expires_at is None

    # FP over risk bar → human.
    d = decide(Verdict.FALSE_POSITIVE, 0.95, 80.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN

    # TP class disabled → human; high-confidence TP escalates.
    d = decide(Verdict.TRUE_POSITIVE, 0.95, 50.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN and d.escalate is True

    # TP low confidence + low risk → human, no escalation.
    d = decide(Verdict.TRUE_POSITIVE, 0.1, 5.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN and d.escalate is False

    # NEEDS_HUMAN never auto-closes.
    d = decide(Verdict.NEEDS_HUMAN, 1.0, 0.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN and d.decision_by.value == "system"

    # Unknown / None verdict → human (fail-safe).
    d = decide(None, 1.0, 0.0, policy)
    assert d.status == CaseStatus.NEEDS_HUMAN
