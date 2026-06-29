"""C3-3 (agent-pipeline trace endpoint) + C3-5 (resolved-case RAG on close).

Offline: fake ES + mock LLM + the gateway's local-hash embedding fallback.
"""

from __future__ import annotations

from app.agents.formatter import Formatter
from app.agents.prompts import render_cluster
from app.api.routes import CaseAction, case_action, case_trace
from app.constants import ActionType, CaseStatus, EntityType, SourceSurface, Verdict
from app.engine.correlation import cluster_from_events
from app.models import AuditDoc, Case, Entity, RagChunk, TriggerReason, VerdictResult

from tests.conftest import make_raw_event


def _make_case(case_id: str = "case-x", ip: str = "203.0.113.50") -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        origin_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=ip),
        rule_ids=["waf-nginx-access"],
        risk_score=72.0,
        verdict=Verdict.TRUE_POSITIVE,
        status=CaseStatus.OPEN,
        trigger_reason=TriggerReason(
            sentence="6 'modsec_xss' events from ip 203.0.113.50 within 120s"
        ),
    )


# --------------------------------------------------------------------------- #
# C3-3 — trace endpoint
# --------------------------------------------------------------------------- #
async def test_trace_orders_steps_and_never_404(app_state):
    state = app_state
    # Write audit rows OUT of order; the endpoint must return them ts-ascending.
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:02+00:00", case_id="c1", actor="investigator",
        action_type=ActionType.VERDICT, result_summary="TRUE_POSITIVE",
    ))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:00+00:00", case_id="c1", actor="router",
        action_type=ActionType.DECISION, result_summary="bucket=uncertain",
    ))
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:01+00:00", case_id="c1", actor="investigator",
        action_type=ActionType.ES_QUERY, query_text='source.ip:"x"',
    ))
    # A row for a DIFFERENT case must not leak in.
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:00+00:00", case_id="other", actor="router",
        action_type=ActionType.DECISION,
    ))

    res = await case_trace("c1", state)
    assert res["case_id"] == "c1"
    assert res["total"] == 3
    assert [s["actor"] for s in res["steps"]] == ["router", "investigator", "investigator"]
    assert res["steps"][0]["action_type"] == "decision"
    assert res["steps"][1]["query_text"] == 'source.ip:"x"'

    # NEVER 404: an unknown / not-yet-investigated case returns empty steps.
    empty = await case_trace("does-not-exist", state)
    assert empty == {"case_id": "does-not-exist", "steps": [], "total": 0}


async def test_trace_include_prompts_toggle(app_state):
    state = app_state
    await state.audit.write(AuditDoc(
        ts="2026-06-16T10:00:00+00:00", case_id="c2", actor="router",
        action_type=ActionType.PROMPT, prompt_excerpt="SENSITIVE PROMPT TEXT",
    ))
    # Default include_prompts=True → excerpt present.
    on = await case_trace("c2", state)
    assert on["steps"][0]["prompt_excerpt"] == "SENSITIVE PROMPT TEXT"
    # Toggle off → excerpt omitted (untrusted prompt text hidden).
    await state.update_prefs(state.prefs.model_copy(
        update={"trace": state.prefs.trace.model_copy(update={"include_prompts": False})}
    ))
    off = await case_trace("c2", state)
    assert off["steps"][0]["prompt_excerpt"] is None
    assert off["steps"][0]["actor"] == "router"  # other fields still present


async def test_formatter_emits_audit_row_visible_in_trace(app_state):
    state = app_state
    fmt = Formatter(state.gateway, state.audit)
    draft = VerdictResult(verdict=Verdict.TRUE_POSITIVE, confidence=0.8)
    merged, _cost = await fmt.format(
        draft, "investigator reasoning", state.prefs, surface="investigate", case_id="c3"
    )
    # Formatter is presentation-only: the decision is preserved.
    assert merged.verdict == Verdict.TRUE_POSITIVE
    rows = await state.audit.records_for_case("c3")
    assert any(r.get("actor") == "formatter" for r in rows)
    res = await case_trace("c3", state)
    assert any(s["actor"] == "formatter" for s in res["steps"])


# --------------------------------------------------------------------------- #
# C3-5 — resolved-case RAG on close
# --------------------------------------------------------------------------- #
async def test_close_indexes_resolved_case_chunk_no_dup(app_state):
    state = app_state
    await state.cases.save(_make_case(case_id="case-close-1", ip="198.51.100.7"))

    out = await case_action(
        "case-close-1", CaseAction(action="close", note="benign scanner"), state
    )
    assert out["status"] == CaseStatus.CLOSED.value

    mine = [c for c in state.rag._store._chunks if c.doc_id == "resolved_case:case-close-1"]
    assert len(mine) == 1
    assert mine[0].source == "resolved_case"
    assert "benign scanner" in mine[0].text
    assert mine[0].metadata.get("note") == "benign scanner"
    assert mine[0].metadata.get("case_id") == "case-close-1"

    # Re-close (confirm_fp) must OVERWRITE via the deterministic doc_id, not dupe.
    await case_action(
        "case-close-1", CaseAction(action="confirm_fp", note="still benign"), state
    )
    mine2 = [c for c in state.rag._store._chunks if c.doc_id == "resolved_case:case-close-1"]
    assert len(mine2) == 1
    assert "still benign" in mine2[0].text


async def test_reopen_does_not_index(app_state):
    state = app_state
    case = _make_case(case_id="case-reopen-1")
    case.status = CaseStatus.NEEDS_HUMAN
    await state.cases.save(case)
    await case_action("case-reopen-1", CaseAction(action="reopen", note="n"), state)
    assert not any(
        c.doc_id == "resolved_case:case-reopen-1" for c in state.rag._store._chunks
    )


async def test_close_still_succeeds_when_rag_raises(app_state, monkeypatch):
    state = app_state
    await state.cases.save(_make_case(case_id="case-failsafe-1"))

    async def _boom(*_a, **_k):
        raise RuntimeError("vector store down")

    # The route-level try/except must keep the analyst's action working.
    monkeypatch.setattr(state.rag, "index_resolved_case", _boom)
    out = await case_action(
        "case-failsafe-1", CaseAction(action="close", note="x"), state
    )
    assert out["status"] == CaseStatus.CLOSED.value


async def test_index_resolved_case_gated_off(app_state):
    state = app_state
    await state.update_prefs(state.prefs.model_copy(
        update={"rag": state.prefs.rag.model_copy(update={"use_resolved_cases": False})}
    ))
    added = await state.rag.index_resolved_case(_make_case(case_id="case-gated"), note="x")
    assert added == 0


# --------------------------------------------------------------------------- #
# C3-5 — render_cluster baseline block
# --------------------------------------------------------------------------- #
def test_render_cluster_groups_resolved_cases():
    cluster = cluster_from_events(
        EntityType.IP, "203.0.113.9", [make_raw_event(id="e1", ip="203.0.113.9")]
    )
    chunks = [
        RagChunk(text="Resolved case abc: verdict TRUE_POSITIVE", source="resolved_case", score=0.9),
        RagChunk(text="SSH brute force runbook snippet", source="runbook", score=0.8),
    ]
    out = render_cluster(cluster, None, chunks)
    assert "## Prior analyst decisions (baseline)" in out
    assert "## Retrieved knowledge (runbooks / MITRE / suppression / threat-intel)" in out
    # The resolved-case chunk appears UNDER the baseline heading.
    assert out.index("Resolved case abc") > out.index("## Prior analyst decisions (baseline)")
    # The runbook chunk appears under the knowledge heading, not the baseline one.
    assert out.index("SSH brute force runbook") < out.index("## Prior analyst decisions (baseline)")
