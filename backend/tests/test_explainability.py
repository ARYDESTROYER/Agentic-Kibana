"""Case EXPLAINABILITY: the CONTEXT audit record + the /cases/{id}/rationale
endpoint that assembles a human-readable "why" object from the case + its audit
records (no LLM). All offline (fake ES + mock LLM), mirroring conftest patterns.
"""

from __future__ import annotations

import json

from app.api.routes import case_rationale, case_trace
from app.constants import ActionType, EntityType, SourceSurface
from app.engine.correlation import cluster_from_events
from app.models import RagChunk

from tests.conftest import make_raw_event


def _cluster(rule: str = "linux_auth", n: int = 6, ip: str = "203.0.113.50"):
    base = 1_700_000_000_000
    events = [
        make_raw_event(id=f"e{i}", ip=ip, rule=rule, ts_millis=base + i * 1000)
        for i in range(n)
    ]
    return cluster_from_events(EntityType.IP, ip, events)


def _final(verdict: str = "TRUE_POSITIVE", confidence: float = 0.92) -> str:
    return json.dumps({
        "action": "final",
        "reasoning": "Repeated auth failures then a success — credential stuffing.",
        "verdict": {
            "verdict": verdict, "confidence": confidence,
            "evidence": [{"summary": "6 failed logins", "event_ids": ["e0", "e1"], "query": 'source.ip:"x"'}],
            "mitre": ["T1110"], "recommended_action": "isolate", "reproduce_query": "",
        },
    })


def _tool_step(query: str = 'source.ip:"203.0.113.50"') -> str:
    return json.dumps({
        "action": "tool", "tool": "es_query",
        "input": {"query": query, "language": "kuery"},
    })


async def _run_investigation(state, mock_provider, *, with_memory=True, with_rag=True):
    """Drive one scripted strong investigation through the real pipeline: router →
    needs_strong_model, investigator → es_query then final TRUE_POSITIVE."""
    if with_memory:
        await state.memory.add("10.0.0.0/8 is the internal corporate range", category="network")

    if with_rag:
        async def _fake_retrieve(query, top_k=None):
            return [RagChunk(
                text="Internal vuln scanner runs planned testing; benign scanning is expected.",
                source="runbook", score=0.9,
            )]
        # Patch the live rag service the pipeline holds.
        state.rag.retrieve = _fake_retrieve  # type: ignore[method-assign]

    mock_provider.push("router", json.dumps(
        {"bucket": "needs_strong_model", "confidence": 0.9, "reason": "serious"}
    ))
    mock_provider.push("investigator", _tool_step())
    mock_provider.push("investigator", _final())

    return await state.pipeline.investigate_cluster(
        _cluster(), SourceSurface.INVESTIGATE, state.prefs
    )


# --------------------------------------------------------------------------- #
# 1) The CONTEXT audit record captures knowledge / memory / enrichment
# --------------------------------------------------------------------------- #
async def test_context_record_written_with_why(app_state, mock_provider):
    state = app_state
    case = await _run_investigation(state, mock_provider)

    rows = await state.audit.records_for_case(case.case_id)
    ctx = [r for r in rows if r.get("action_type") == ActionType.CONTEXT.value]
    assert ctx, "a CONTEXT explainability record must be written"
    rec = ctx[0]
    assert rec.get("actor") == "context"

    # Human-readable summary visible in the trace.
    summary = rec.get("result_summary") or ""
    assert "knowledge(" in summary and "[runbook]" in summary
    assert "memory(" in summary
    assert "enrichment:" in summary

    # Structured copy for the rationale endpoint.
    ti = rec.get("tool_input") or {}
    assert any(k.get("source") == "runbook" for k in ti["knowledge"])
    assert any("internal corporate range" in m for m in ti["memory"])
    assert ti["enrichment"] is not None and "is_malicious" in ti["enrichment"]


# --------------------------------------------------------------------------- #
# 2) The VERDICT record carries a reasoning excerpt
# --------------------------------------------------------------------------- #
async def test_verdict_record_has_reasoning(app_state, mock_provider):
    state = app_state
    case = await _run_investigation(state, mock_provider)
    rows = await state.audit.records_for_case(case.case_id)
    verdicts = [r for r in rows if r.get("action_type") == ActionType.VERDICT.value]
    assert verdicts
    assert "reasoning=" in (verdicts[0].get("result_summary") or "")
    assert "credential stuffing" in (verdicts[0].get("result_summary") or "")


# --------------------------------------------------------------------------- #
# 3) The rationale endpoint assembles the full "why" object (no LLM)
# --------------------------------------------------------------------------- #
async def test_rationale_endpoint_assembles_why(app_state, mock_provider):
    state = app_state
    case = await _run_investigation(state, mock_provider)

    out = await case_rationale(case.case_id, state)

    assert out["case_id"] == case.case_id
    assert out["verdict"] == "TRUE_POSITIVE"
    assert out["confidence"] == 0.92
    assert out["status"]  # closed or needs_human, but populated
    # persona is deterministically assigned.
    assert out["persona"]
    # playbook block present (id may be empty if no match, but reason is recorded).
    assert "id" in out["playbook"] and "reason" in out["playbook"]
    assert out["playbook"]["reason"]  # playbook_selector DECISION captured

    # knowledge with source.
    assert any(k["source"] == "runbook" for k in out["knowledge"])
    # memory facts injected.
    assert any("internal corporate range" in m for m in out["memory_used"])
    # enrichment present.
    assert out["enrichment"] is not None and "reputation_score" in out["enrichment"]
    # tools the agent ran, with the issued query recorded (es_query is read-only).
    es_tools = [t for t in out["tools"] if t["tool"] == "es_query"]
    assert es_tools and es_tools[0]["query"]
    # investigator reasoning excerpt.
    assert "credential stuffing" in out["reasoning"]
    # deterministic decision rationale (case_manager branch that fired).
    assert out["decision_rationale"]
    # MITRE + evidence carried from the case (the formatter shapes the final
    # evidence text; we assert the structure is surfaced).
    assert "T1110" in out["mitre"]
    assert out["evidence"] and all("summary" in e and "event_ids" in e for e in out["evidence"])


# --------------------------------------------------------------------------- #
# 4) The existing trace endpoint still builds (CONTEXT flows through it)
# --------------------------------------------------------------------------- #
async def test_trace_still_builds_with_context(app_state, mock_provider):
    state = app_state
    case = await _run_investigation(state, mock_provider)
    res = await case_trace(case.case_id, state)
    assert res["total"] >= 1
    actors = [s["actor"] for s in res["steps"]]
    assert "context" in actors  # the new CONTEXT record is surfaced in the trace
    # The context step carries its structured detail + readable summary.
    ctx_step = next(s for s in res["steps"] if s["actor"] == "context")
    assert ctx_step["action_type"] == ActionType.CONTEXT.value
    assert ctx_step["result_summary"]


# --------------------------------------------------------------------------- #
# 5) Defensive: rationale NEVER 404s and degrades gracefully
# --------------------------------------------------------------------------- #
async def test_rationale_unknown_case_is_empty_not_error(app_state):
    out = await case_rationale("does-not-exist", app_state)
    assert out["case_id"] == "does-not-exist"
    assert out["verdict"] == "" and out["knowledge"] == [] and out["memory_used"] == []
    assert out["enrichment"] is None and out["tools"] == []
    assert out["reasoning"] == "" and out["decision_rationale"] == ""
