"""End-to-end investigation pipeline (Gate 1).

Covers the spine acceptance behaviour: a scripted verdict flows through triage →
investigator → formatter → deterministic Case Manager; true positives never
auto-close; false positives auto-close only under policy; and any model failure
fails to a human.
"""

from __future__ import annotations

import json

from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from app.engine.correlation import cluster_from_events
from app.llm.providers import BaseProvider, CompletionResult
from app.state import AppState
from tests.conftest import make_raw_event


def _cluster(ip: str = "1.2.3.4", n: int = 3):
    base = 1_700_000_000_000
    events = [make_raw_event(id=f"e{i}", ip=ip, ts_millis=base + i * 1000) for i in range(n)]
    return cluster_from_events(EntityType.IP, ip, events)


def _final_verdict(verdict: str, confidence: float) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "scripted",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "scripted evidence", "event_ids": ["e0"]}],
            "mitre": ["T1110"], "recommended_action": "block the source",
            "reproduce_query": 'source.ip : "1.2.3.4"',
        },
    })


async def test_true_positive_not_autoclosed_by_default(app_state: AppState, mock_provider):
    # FP auto-close on, TP auto-close OFF (default) → a TP still routes to a human.
    p = app_state.prefs.model_copy(deep=True)
    p.auto_close.false_positive.enabled = True
    p.auto_close.false_positive.min_confidence = 0.1
    p.auto_close.false_positive.max_risk_score = 100.0
    await app_state.update_prefs(p)

    mock_provider.push("router", json.dumps({"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}))
    mock_provider.push("investigator", _final_verdict("TRUE_POSITIVE", 0.99))

    case = await app_state.pipeline.investigate_cluster(_cluster(), SourceSurface.INVESTIGATE, app_state.prefs)
    assert case.verdict == Verdict.TRUE_POSITIVE
    assert case.status == CaseStatus.NEEDS_HUMAN
    assert case.decision_by == DecisionBy.SYSTEM
    assert case.token_cost >= 0.0


async def test_benign_false_positive_autocloses_under_policy(app_state: AppState, mock_provider):
    p = app_state.prefs.model_copy(deep=True)
    p.auto_close.false_positive.enabled = True
    p.auto_close.false_positive.min_confidence = 0.5
    p.auto_close.false_positive.max_risk_score = 100.0
    await app_state.update_prefs(p)

    mock_provider.push("router", json.dumps({"bucket": "obviously_benign", "confidence": 0.95, "reason": "noise"}))

    case = await app_state.pipeline.investigate_cluster(_cluster("9.9.9.9"), SourceSurface.AUTOMATED_SCAN, app_state.prefs)
    assert case.verdict == Verdict.FALSE_POSITIVE
    assert case.status == CaseStatus.CLOSED
    assert case.decision_by == DecisionBy.AGENT
    assert case.objection_window_expires_at is not None


async def test_investigate_is_idempotent_by_signature(app_state: AppState, mock_provider):
    for _ in range(2):
        mock_provider.push("router", json.dumps({"bucket": "uncertain", "confidence": 0.3, "reason": "?"}))
        mock_provider.push("investigator", _final_verdict("NEEDS_HUMAN", 0.2))
    c1 = await app_state.pipeline.investigate_cluster(_cluster("3.3.3.3"), SourceSurface.INVESTIGATE, app_state.prefs)
    c2 = await app_state.pipeline.investigate_cluster(_cluster("3.3.3.3"), SourceSurface.INVESTIGATE, app_state.prefs)
    assert c1.case_id == c2.case_id  # same open case, not a duplicate


async def test_model_failure_fails_to_human(secrets, mock_provider):
    from app.es.fake import InMemoryESClient

    raising = _RaisingProvider()
    state = AppState.create(
        secrets=secrets, es=InMemoryESClient(),
        provider_overrides={"anthropic": raising, "openai": raising, "mock": raising},
    )
    await state.startup(start_poller=False)
    try:
        case = await state.pipeline.investigate_cluster(
            _cluster("2.2.2.2"), SourceSurface.AUTOMATED_SCAN, state.prefs
        )
        assert case.verdict == Verdict.NEEDS_HUMAN
        assert case.status == CaseStatus.NEEDS_HUMAN
    finally:
        await state.shutdown()


async def test_kill_switch_skips_investigation(app_state: AppState):
    p = app_state.prefs.model_copy(deep=True)
    p.caps.kill_switch = True
    await app_state.update_prefs(p)
    case = await app_state.pipeline.investigate_cluster(_cluster("4.4.4.4"), SourceSurface.INVESTIGATE, app_state.prefs)
    assert case.verdict == Verdict.NEEDS_HUMAN
    assert case.status == CaseStatus.NEEDS_HUMAN


class _RaisingProvider(BaseProvider):
    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        raise RuntimeError("model down")

    async def embed(self, texts, model):
        from app.llm.providers import EmbeddingResult

        return EmbeddingResult(vectors=[[0.0] for _ in texts], tokens=0)
