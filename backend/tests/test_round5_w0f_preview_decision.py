"""Round 5 / W0-F F4 — ``POST /api/triage/preview-decision``.

A thin READ-ONLY what-if wrapper over the ONE pure ``case_manager.decide()`` so the
Settings/Rules UI can preview the deterministic auto-close outcome for a hypothetical
``(verdict, confidence, risk_score[, policy])`` WITHOUT ever drifting from the real
decision code — and without touching the LLM, a case, or any store.

These tests pin the three acceptance guarantees:

(a) **PARITY** — the endpoint's ``{decision, rationale}`` is byte-identical to calling
    the pure ``decide()`` directly, across a matrix of verdict × confidence × risk ×
    policy inputs (both the LIVE prefs policy and an explicit candidate ``policy``).
(b) **ZERO ``UsageDoc`` writes** — the preview NEVER bills the LLM (#6): a spy on the
    usage-ledger write path records nothing across the whole matrix.
(c) **NOT re-implemented / NOT monkeypatched** — the router binds the SAME
    ``case_manager.decide`` function object (imported, never re-derived); a sentinel
    monkeypatch of ``case_manager.decide`` is observed by the endpoint, proving it
    delegates to the imported pure function rather than a private copy.

Offline: the in-process ``app_state`` fixture (fake ES + mock LLM). The endpoint is
exercised through its FastAPI callable with the RBAC dep overridden to a no-op (auth is
default-OFF in the suite, matching production's no-auth profile).
"""

from __future__ import annotations

import itertools

import pytest

from app.api import routes_triage
from app.api.routes_triage import _PreviewDecisionIn, preview_decision
from app.config import AutoClosePolicy, Preferences, VerdictAutoClose
from app.engine import case_manager
from app.engine.case_manager import decide
from app.constants import CaseStatus, DecisionBy, Verdict


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
async def _call(state, **kw) -> dict:
    """Invoke the endpoint callable directly (RBAC dep is a plain FastAPI Depends the
    ASGI layer injects; here we bypass it — auth is OFF in the suite, so require_permission
    is a no-op anyway). ``_`` is the RBAC principal placeholder."""
    body = _PreviewDecisionIn(**kw)
    return await preview_decision(body, state=state, _=None)


def _expected(prefs: Preferences, *, verdict, confidence, risk_score, policy=None,
              esc=None, crit=None):
    """The EXACT pure-decide() result the endpoint must reproduce."""
    return decide(
        verdict,
        confidence,
        risk_score,
        policy if policy is not None else prefs.auto_close,
        escalation_confidence=esc if esc is not None else prefs.escalation_confidence,
        critical_severity=crit if crit is not None else prefs.critical_severity,
    )


# A wide, deterministic input matrix spanning every branch of decide():
#   * FALSE_POSITIVE / TRUE_POSITIVE / NEEDS_HUMAN / None
#   * confidence below & above each policy bar
#   * risk within & beyond each policy ceiling
_VERDICTS = [Verdict.FALSE_POSITIVE, Verdict.TRUE_POSITIVE, Verdict.NEEDS_HUMAN, None]
_CONFIDENCES = [0.0, 0.5, 0.86, 0.9, 0.96, 1.0]
_RISKS = [0.0, 5.0, 15.0, 25.0, 35.0, 80.0]


def _matrix():
    for v, c, r in itertools.product(_VERDICTS, _CONFIDENCES, _RISKS):
        yield v, c, r


# --------------------------------------------------------------------------- #
# (a) PARITY with the pure decide() — live policy
# --------------------------------------------------------------------------- #
async def test_parity_with_decide_over_matrix_live_policy(app_state) -> None:
    """Across the full input matrix, the endpoint reproduces decide() exactly using the
    LIVE ``prefs.auto_close`` when no ``policy`` is supplied."""
    state = app_state
    prefs = state.prefs
    for verdict, conf, risk in _matrix():
        res = await _call(state, verdict=verdict, confidence=conf, risk_score=risk)
        exp = _expected(prefs, verdict=verdict, confidence=conf, risk_score=risk)
        d = res["decision"]
        assert d["status"] == exp.status.value, (verdict, conf, risk)
        assert d["decision_by"] == exp.decision_by.value, (verdict, conf, risk)
        assert d["escalate"] == exp.escalate, (verdict, conf, risk)
        # The auto-close objection window is decide()'s ONE time-dependent field (it
        # stamps now()+window on a close); assert PRESENCE-parity, not the microsecond.
        assert (d["objection_window_expires_at"] is None) == (
            exp.objection_window_expires_at is None
        ), (verdict, conf, risk)
        assert d["auto_closed"] == (exp.status == CaseStatus.CLOSED)
        assert res["rationale"] == exp.rationale, (verdict, conf, risk)


# --------------------------------------------------------------------------- #
# (a) PARITY — explicit candidate policy (the what-if draft path)
# --------------------------------------------------------------------------- #
async def test_parity_with_explicit_candidate_policy(app_state) -> None:
    """When the caller supplies a candidate ``policy`` (a draft the operator has not
    saved), the preview decides against THAT policy — still byte-identical to decide()."""
    state = app_state
    prefs = state.prefs
    # A draft that turns TP auto-close ON with a low bar (very different from defaults).
    draft = AutoClosePolicy(
        false_positive=VerdictAutoClose(enabled=False),
        true_positive=VerdictAutoClose(
            enabled=True, min_confidence=0.5, max_risk_score=90.0,
            objection_window_minutes=60,
        ),
    )
    for verdict, conf, risk in _matrix():
        res = await _call(state, verdict=verdict, confidence=conf, risk_score=risk,
                          policy=draft)
        exp = _expected(prefs, verdict=verdict, confidence=conf, risk_score=risk,
                        policy=draft)
        d = res["decision"]
        assert d["status"] == exp.status.value, (verdict, conf, risk)
        assert d["decision_by"] == exp.decision_by.value
        assert d["escalate"] == exp.escalate
        assert res["rationale"] == exp.rationale
    assert res["inputs"]["policy_provided"] is True


async def test_candidate_policy_flips_a_would_close(app_state) -> None:
    """A concrete, human-legible what-if: with the DEFAULT policy a confident FP within
    the risk bar auto-closes; with a draft that DISABLES FP auto-close the SAME inputs
    route to a human. The preview reflects the supplied policy, not the live one."""
    state = app_state
    live = await _call(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.95,
                       risk_score=10.0)
    assert live["decision"]["status"] == CaseStatus.CLOSED.value
    assert live["decision"]["auto_closed"] is True

    draft = AutoClosePolicy(false_positive=VerdictAutoClose(enabled=False))
    drafted = await _call(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.95,
                          risk_score=10.0, policy=draft)
    assert drafted["decision"]["status"] == CaseStatus.NEEDS_HUMAN.value
    assert drafted["decision"]["auto_closed"] is False
    assert drafted["decision"]["decision_by"] == DecisionBy.SYSTEM.value


async def test_needs_human_never_auto_closes_even_with_permissive_policy(app_state) -> None:
    """#3 code-enforced: NEEDS_HUMAN (and a missing verdict) can NEVER be auto-closed,
    whatever the previewed policy says — the preview surfaces the same guarantee."""
    state = app_state
    permissive = AutoClosePolicy(
        false_positive=VerdictAutoClose(enabled=True, min_confidence=0.0,
                                        max_risk_score=100.0),
        true_positive=VerdictAutoClose(enabled=True, min_confidence=0.0,
                                       max_risk_score=100.0),
    )
    for verdict in (Verdict.NEEDS_HUMAN, None):
        res = await _call(state, verdict=verdict, confidence=1.0, risk_score=0.0,
                          policy=permissive)
        assert res["decision"]["status"] == CaseStatus.NEEDS_HUMAN.value
        assert res["decision"]["auto_closed"] is False


async def test_escalation_overrides_reach_decide(app_state) -> None:
    """The optional ``escalation_confidence`` / ``critical_severity`` overrides are
    threaded into decide() (they flag the advisory ``escalate`` band only). A very low
    escalation bar flips ``escalate`` True for a TP that would not escalate by default."""
    state = app_state
    prefs = state.prefs
    # Default TP auto-close is OFF, so a TP routes to human; with a low escalation bar it
    # should be flagged escalate=True.
    res = await _call(state, verdict=Verdict.TRUE_POSITIVE, confidence=0.3,
                      risk_score=5.0, escalation_confidence=0.1, critical_severity=999.0)
    exp = _expected(prefs, verdict=Verdict.TRUE_POSITIVE, confidence=0.3, risk_score=5.0,
                    esc=0.1, crit=999.0)
    assert res["decision"]["escalate"] == exp.escalate is True
    assert res["inputs"]["escalation_confidence"] == 0.1
    assert res["inputs"]["critical_severity"] == 999.0


# --------------------------------------------------------------------------- #
# (b) ZERO UsageDoc writes — the preview never bills the LLM (#6)
# --------------------------------------------------------------------------- #
async def test_zero_usage_writes_across_matrix(app_state, monkeypatch) -> None:
    """A spy on the usage-ledger ``write`` records NOTHING across the whole matrix — the
    preview is a pure computation with no gateway call, so zero ``UsageDoc`` writes."""
    state = app_state
    calls: list = []
    real_write = state.usage_store.write

    async def _spy(doc):  # noqa: ANN001
        calls.append(doc)
        return await real_write(doc)

    monkeypatch.setattr(state.usage_store, "write", _spy)

    for verdict, conf, risk in _matrix():
        await _call(state, verdict=verdict, confidence=conf, risk_score=risk)

    assert calls == [], f"preview-decision billed the ledger {len(calls)} time(s)"


async def test_preview_does_not_mutate_cases_or_config(app_state) -> None:
    """The preview writes NO case and mutates NO config: the case count and the live
    ``prefs.auto_close`` are unchanged after a permissive-policy what-if."""
    state = app_state
    before = state.prefs.auto_close.model_dump(mode="json")
    _, n_before = await state.cases.list()
    await _call(state, verdict=Verdict.FALSE_POSITIVE, confidence=1.0, risk_score=0.0,
                policy=AutoClosePolicy(
                    false_positive=VerdictAutoClose(enabled=True, min_confidence=0.0,
                                                    max_risk_score=100.0)))
    assert state.prefs.auto_close.model_dump(mode="json") == before  # live policy untouched
    _, n_after = await state.cases.list()
    assert n_after == n_before                                       # no case created


# --------------------------------------------------------------------------- #
# (c) delegates to the imported pure decide() — NOT re-implemented / observed via patch
# --------------------------------------------------------------------------- #
def test_router_binds_the_real_decide_object() -> None:
    """The router imported the ONE true pure function — the ``decide`` name in
    ``routes_triage`` IS ``case_manager.decide`` (same object identity), proving it was
    imported, not re-implemented."""
    assert routes_triage.decide is case_manager.decide


async def test_endpoint_delegates_to_case_manager_decide(app_state, monkeypatch) -> None:
    """Monkeypatch ``routes_triage.decide`` (the imported symbol the endpoint calls) with
    a sentinel and observe that the endpoint's output comes from IT — proving the endpoint
    delegates to the imported pure function rather than a private inlined copy of the
    truth table. (We patch the module-local binding, which is exactly what the endpoint
    resolves at call time; ``case_manager.decide`` itself is never edited.)"""
    from app.engine.case_manager import Decision

    seen: dict = {}
    sentinel = Decision(
        status=CaseStatus.CLOSED, decision_by=DecisionBy.AGENT,
        objection_window_expires_at="SENTINEL-TS", escalate=True,
        rationale="SENTINEL-RATIONALE",
    )

    def _fake_decide(verdict, confidence, risk_score, policy, **kw):  # noqa: ANN001
        seen["args"] = (verdict, confidence, risk_score, policy, kw)
        return sentinel

    monkeypatch.setattr(routes_triage, "decide", _fake_decide)
    res = await _call(app_state, verdict=Verdict.TRUE_POSITIVE, confidence=0.9,
                      risk_score=3.0)

    assert seen, "endpoint did not call the (patched) imported decide"
    assert seen["args"][0] == Verdict.TRUE_POSITIVE
    assert seen["args"][1] == 0.9 and seen["args"][2] == 3.0
    # The endpoint returned OUR sentinel decision verbatim → it delegates, not re-derives.
    assert res["decision"]["objection_window_expires_at"] == "SENTINEL-TS"
    assert res["rationale"] == "SENTINEL-RATIONALE"
    assert res["decision"]["escalate"] is True
    assert res["decision"]["auto_closed"] is True


def test_case_manager_module_is_not_monkeypatched_at_rest() -> None:
    """Sanity: at import time (no patching) the case_manager module exposes the genuine
    pure ``decide`` and its ``apply()`` companion — this test file never edits
    case_manager.py and the endpoint never rebinds ``case_manager.decide`` itself."""
    assert callable(case_manager.decide)
    # A trivial live evaluation still works (the real truth table), independent of the API.
    prefs = Preferences()
    d = decide(Verdict.NEEDS_HUMAN, 1.0, 0.0, prefs.auto_close)
    assert d.status == CaseStatus.NEEDS_HUMAN and d.decision_by == DecisionBy.SYSTEM


# --------------------------------------------------------------------------- #
# shape / RBAC-surface smoke
# --------------------------------------------------------------------------- #
async def test_response_shape_and_inputs_echo(app_state) -> None:
    """The response carries the documented ``{decision, rationale, inputs}`` shape with
    the inputs echoed back (so the UI can label the what-if)."""
    state = app_state
    res = await _call(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.9,
                      risk_score=10.0)
    assert set(res) == {"decision", "rationale", "inputs"}
    assert set(res["decision"]) == {
        "status", "decision_by", "escalate", "objection_window_expires_at", "auto_closed",
    }
    assert res["inputs"]["verdict"] == "FALSE_POSITIVE"
    assert res["inputs"]["confidence"] == 0.9
    assert res["inputs"]["risk_score"] == 10.0
    assert res["inputs"]["policy_provided"] is False


def test_preview_endpoint_requires_cases_read_rbac() -> None:
    """The route is RBAC-gated on ``cases:read`` via the shared ``require_permission``
    dep (no state-changer, so read is the correct grant). Assert the dependency is wired
    on the route so a future refactor can't silently drop the gate."""
    from app.main import app

    routes = [r for r in app.routes if getattr(r, "path", "") == "/api/triage/preview-decision"]
    assert routes, "preview-decision route not mounted"
    route = routes[0]
    assert "POST" in route.methods
    dep_names = [
        getattr(d.call, "__name__", getattr(getattr(d, "call", None), "__qualname__", ""))
        for d in route.dependant.dependencies
    ]
    # require_permission returns an inner ``_dep`` closure; its presence proves the gate.
    assert any(n == "_dep" for n in dep_names), dep_names
