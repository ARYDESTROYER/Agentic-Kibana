"""Round 5 / R1 — the auto-close dead-field bug fix (PROPOSAL bug #1).

The FLAGSHIP autonomy toggle used to do NOTHING: the Settings editor wrote
``prefs.fp_auto_close`` while ``case_manager.decide()`` reads ``prefs.auto_close``.
Because ``put_settings`` merges over a full ``model_dump`` in which ``auto_close`` is
always populated by its ``default_factory``, the ``_migrate_fp_auto_close`` migration
(which only fires when ``auto_close`` is ABSENT) never ran — so editing
``fp_auto_close`` at runtime changed a field the engine never consults.

This suite pins the fix END-TO-END through the REAL write path (``PUT /api/settings``
deep-merge → ``Preferences`` re-validate → ``state.prefs``) and the REAL decision path
(the pure ``case_manager.decide()`` + the ``POST /api/triage/preview-decision`` wrapper
over it):

  (A) writing ``auto_close.false_positive`` (the field decide() reads) CHANGES the
      decision — disabling it flips a would-be auto-close to NEEDS_HUMAN;
  (B) writing ONLY the DEAD ``fp_auto_close`` scalar does NOT change the decision on a
      config that already carries ``auto_close`` (the exact bug — now provably harmless
      because the editor no longer writes it);
  (C) the ``true_positive`` opt-in works the same way (OFF by default → a confident TP
      routes to a human; enabling it via ``auto_close.true_positive`` auto-closes);
  (D) NEEDS_HUMAN is code-enforced never-auto-close regardless of any config.

⛔ This test file NEVER edits ``engine/case_manager.py`` (#3): it only WRITES config via
the settings path and OBSERVES the pure ``decide()``. The deep-merge preserves
``fp_auto_close`` (kept for the legacy migrate path); we assert both keys coexist.

Offline: the in-process ``app_state`` fixture (fake ES + mock LLM). We invoke the real
``put_settings`` and ``preview_decision`` route callables directly (RBAC is a no-op in
the suite, matching production's default no-auth profile).
"""

from __future__ import annotations

import pytest

from app.api.routes import put_settings
from app.api.routes_triage import _PreviewDecisionIn, preview_decision
from app.constants import CaseStatus, DecisionBy, Verdict
from app.engine.case_manager import decide

pytestmark = pytest.mark.asyncio


# --------------------------------------------------------------------------- #
# helpers — drive the REAL settings write + the REAL preview-over-decide()
# --------------------------------------------------------------------------- #
def _fake_request(state):
    """A minimal Starlette Request wired to ``state`` so the P12 audit actor lookup
    (``current_username`` → ``get_state(request)``) resolves in a direct-coroutine call.
    Auth is off in tests, so the actor resolves to ``""`` — the audit row is still
    written (surface + changed keys), just unattributed."""
    from starlette.applications import Starlette
    from starlette.requests import Request

    app = Starlette()
    app.state.tlsoc = state
    scope = {"type": "http", "app": app, "headers": [], "method": "PUT", "path": "/api/settings"}
    return Request(scope)


async def _put(state, patch: dict) -> dict:
    """PATCH the live prefs through the REAL deep-merge ``PUT /api/settings`` path."""
    return await put_settings(patch, request=_fake_request(state), state=state, _=None)


async def _preview(state, *, verdict, confidence, risk_score) -> dict:
    """What-if the LIVE ``prefs.auto_close`` via the pure decide() wrapper (no LLM)."""
    body = _PreviewDecisionIn(verdict=verdict, confidence=confidence, risk_score=risk_score)
    return await preview_decision(body, state=state, _=None)


def _direct_decide(state, *, verdict, confidence, risk_score):
    """Call the ONE pure ``decide()`` directly against the live policy (second angle)."""
    prefs = state.prefs
    return decide(
        verdict,
        confidence,
        risk_score,
        prefs.auto_close,
        escalation_confidence=prefs.escalation_confidence,
        critical_severity=prefs.critical_severity,
    )


# --------------------------------------------------------------------------- #
# (A) writing auto_close.false_positive CHANGES what decide() does
# --------------------------------------------------------------------------- #
async def test_disabling_fp_auto_close_via_auto_close_flips_the_decision(app_state) -> None:
    """A confident FALSE_POSITIVE within the risk bar auto-closes under the default
    policy; PATCHing ``auto_close.false_positive.enabled=False`` through the real
    settings path makes the SAME inputs route to a human — proving decide() acts on the
    field the editor now writes."""
    state = app_state

    # Ensure FP auto-close is ON with a bar these inputs clear (the shipped default).
    await _put(state, {"auto_close": {"false_positive": {
        "enabled": True, "min_confidence": 0.85, "max_risk_score": 30.0,
        "objection_window_minutes": 1440,
    }}})
    before = await _preview(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.95, risk_score=10.0)
    assert before["decision"]["status"] == CaseStatus.CLOSED.value
    assert before["decision"]["auto_closed"] is True
    assert before["decision"]["decision_by"] == DecisionBy.AGENT.value

    # Now DISABLE it via the field decide() reads.
    await _put(state, {"auto_close": {"false_positive": {"enabled": False}}})
    after = await _preview(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.95, risk_score=10.0)
    assert after["decision"]["status"] == CaseStatus.NEEDS_HUMAN.value
    assert after["decision"]["auto_closed"] is False
    assert after["decision"]["decision_by"] == DecisionBy.SYSTEM.value

    # The live policy really changed (not just the preview) — decide() sees it directly.
    assert state.prefs.auto_close.false_positive.enabled is False
    d = _direct_decide(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.95, risk_score=10.0)
    assert d.status == CaseStatus.NEEDS_HUMAN


async def test_tightening_the_confidence_bar_via_auto_close_changes_the_decision(app_state) -> None:
    """Raising ``auto_close.false_positive.min_confidence`` above the verdict confidence
    routes the SAME case to a human — the numeric bars decide() compares against are the
    ones the editor writes."""
    state = app_state
    await _put(state, {"auto_close": {"false_positive": {
        "enabled": True, "min_confidence": 0.80, "max_risk_score": 50.0,
    }}})
    ok = await _preview(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.85, risk_score=10.0)
    assert ok["decision"]["status"] == CaseStatus.CLOSED.value

    await _put(state, {"auto_close": {"false_positive": {"min_confidence": 0.95}}})
    held = await _preview(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.85, risk_score=10.0)
    assert held["decision"]["status"] == CaseStatus.NEEDS_HUMAN.value


# --------------------------------------------------------------------------- #
# (B) the DEAD fp_auto_close field does NOT drive the decision (the bug, made safe)
# --------------------------------------------------------------------------- #
async def test_writing_only_the_dead_fp_auto_close_field_does_not_change_the_decision(app_state) -> None:
    """The exact bug: on a config that already carries ``auto_close`` (always true after
    ``PUT /api/settings`` populates it), writing ONLY the legacy ``fp_auto_close`` scalar
    does NOT change what decide() does. Here ``auto_close.false_positive`` is DISABLED, so
    a confident FP routes to a human; flipping the dead ``fp_auto_close`` on/off leaves
    that outcome unchanged — which is exactly why the old UI toggle did nothing."""
    state = app_state
    # auto_close FP OFF (the field decide() reads); dead scalar starts OFF too.
    await _put(state, {
        "auto_close": {"false_positive": {"enabled": False}},
        "fp_auto_close": {"enabled": False, "min_confidence": 0.9, "max_risk_score": 30.0},
    })
    baseline = await _preview(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.99, risk_score=1.0)
    assert baseline["decision"]["status"] == CaseStatus.NEEDS_HUMAN.value

    # Turn the DEAD field fully permissive — decide() must still route to a human.
    await _put(state, {"fp_auto_close": {
        "enabled": True, "min_confidence": 0.0, "max_risk_score": 100.0,
    }})
    assert state.prefs.fp_auto_close.enabled is True          # the dead field DID persist…
    assert state.prefs.auto_close.false_positive.enabled is False  # …but decide()'s field didn't move
    unchanged = await _preview(state, verdict=Verdict.FALSE_POSITIVE, confidence=0.99, risk_score=1.0)
    assert unchanged["decision"]["status"] == CaseStatus.NEEDS_HUMAN.value
    assert unchanged["decision"]["auto_closed"] is False


async def test_deep_merge_preserves_fp_auto_close_alongside_auto_close(app_state) -> None:
    """The R1 fix keeps the legacy ``fp_auto_close`` (for ``_migrate_fp_auto_close``); the
    settings deep-merge writes ``auto_close`` WITHOUT clobbering the sibling ``fp_auto_close``
    block. Both keys coexist after an auto_close-only PATCH (no sibling wipe, the merge
    invariant)."""
    state = app_state
    # Seed a distinctive fp_auto_close, then PATCH only auto_close.
    await _put(state, {"fp_auto_close": {"enabled": True, "min_confidence": 0.77}})
    await _put(state, {"auto_close": {"true_positive": {"enabled": True}}})
    assert state.prefs.fp_auto_close.min_confidence == pytest.approx(0.77)  # sibling survived
    assert state.prefs.auto_close.true_positive.enabled is True


# --------------------------------------------------------------------------- #
# (C) the TRUE_POSITIVE opt-in (OFF by default) works via auto_close.true_positive
# --------------------------------------------------------------------------- #
async def test_true_positive_auto_close_is_off_by_default(app_state) -> None:
    """A confident TRUE_POSITIVE routes to a human out of the box (TP auto-close is an
    explicit opt-in, OFF by default)."""
    state = app_state
    res = await _preview(state, verdict=Verdict.TRUE_POSITIVE, confidence=0.99, risk_score=1.0)
    assert state.prefs.auto_close.true_positive.enabled is False
    assert res["decision"]["status"] == CaseStatus.NEEDS_HUMAN.value
    assert res["decision"]["auto_closed"] is False


async def test_enabling_true_positive_via_auto_close_auto_closes(app_state) -> None:
    """Opting IN to TP auto-close via ``auto_close.true_positive`` makes a confident,
    low-risk TP auto-close — the same field-that-decide()-reads mechanism as FP."""
    state = app_state
    await _put(state, {"auto_close": {"true_positive": {
        "enabled": True, "min_confidence": 0.9, "max_risk_score": 20.0,
        "objection_window_minutes": 60,
    }}})
    res = await _preview(state, verdict=Verdict.TRUE_POSITIVE, confidence=0.95, risk_score=5.0)
    assert res["decision"]["status"] == CaseStatus.CLOSED.value
    assert res["decision"]["auto_closed"] is True
    assert res["decision"]["decision_by"] == DecisionBy.AGENT.value


# --------------------------------------------------------------------------- #
# (D) NEEDS_HUMAN is code-enforced never-auto-close, whatever the config
# --------------------------------------------------------------------------- #
async def test_needs_human_never_auto_closes_regardless_of_config(app_state) -> None:
    """No auto_close config can make NEEDS_HUMAN (or a missing verdict) auto-close —
    the locked, un-editable class the R1 UI surfaces (#3 code-enforced)."""
    state = app_state
    # Make EVERY editable class maximally permissive.
    await _put(state, {"auto_close": {
        "false_positive": {"enabled": True, "min_confidence": 0.0, "max_risk_score": 100.0},
        "true_positive": {"enabled": True, "min_confidence": 0.0, "max_risk_score": 100.0},
        "needs_human": {"enabled": True, "min_confidence": 0.0, "max_risk_score": 100.0},
    }})
    for verdict in (Verdict.NEEDS_HUMAN, None):
        res = await _preview(state, verdict=verdict, confidence=1.0, risk_score=0.0)
        assert res["decision"]["status"] == CaseStatus.NEEDS_HUMAN.value
        assert res["decision"]["auto_closed"] is False
