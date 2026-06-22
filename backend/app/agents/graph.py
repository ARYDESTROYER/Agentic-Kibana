"""LangGraph orchestration of the investigation flow (Section 3.1: FastAPI + LangGraph).

The flow is a small state graph: triage → (benign shortcut | strong investigator)
→ verdict. When LangGraph is importable it runs as a compiled ``StateGraph``; if
LangGraph is unavailable or errors, it falls back to an identical direct
sequence. Both paths call the SAME router/investigator/RAG components, so there is
no behavioural divergence — the graph is an orchestration shell, not a second
implementation.
"""

from __future__ import annotations

import logging
from typing import Any, TypedDict

from ..config import Preferences
from ..constants import TriageBucket, Verdict
from ..engine.cost_gate import CaseBudget
from ..models import Cluster, EnrichmentResult, EvidenceItem, VerdictResult
from ..utils import truncate
from .common import entity_kql, rag_query

logger = logging.getLogger("tlsoc.agents.graph")


async def run_investigation(
    router,
    investigator,
    rag,
    cluster: Cluster,
    enrichment: EnrichmentResult | None,
    prefs: Preferences,
    budget: CaseBudget,
    surface: str,
    case_id: str | None,
    persona=None,
    playbook=None,
    memory=None,
) -> tuple[VerdictResult, float]:
    """Run triage → verdict, preferring the LangGraph state graph.

    The (deterministically pre-selected) ``persona`` specialises the investigator
    and the matched ``playbook`` is injected as TRUSTED procedure (and contributes
    its canned ``rag_queries``); the operator ``memory`` (durable trusted facts) is
    injected as a distinct block — all three no-ops on the cheap benign/triage path."""

    async def do_triage():
        return await router.triage(cluster, enrichment, prefs, surface=surface, case_id=case_id)

    async def do_benign(triage) -> tuple[VerdictResult, float]:
        return (
            VerdictResult(
                verdict=Verdict.FALSE_POSITIVE,
                confidence=triage.confidence,
                evidence=[EvidenceItem(summary=f"Router triage: {truncate(triage.reason, 200)}")],
                recommended_action="Router classified this as benign noise.",
                reproduce_query=entity_kql(cluster, prefs),
            ),
            0.0,
        )

    async def do_investigate() -> tuple[VerdictResult, float]:
        rag_chunks = []
        if prefs.rag.enabled:
            await rag.ensure_seeded()
            # Base retrieval query + the selected playbook's canned rag_queries.
            # Each retrieve is bounded by top_k; we merge, de-dupe by text and cap
            # the union so prompt size stays bounded (and the cost gate still binds).
            queries = [rag_query(cluster)]
            if playbook is not None and prefs.playbooks.enabled:
                queries += list(playbook.manifest.rag_queries)
            seen: set[str] = set()
            for q in queries:
                for ch in await rag.retrieve(q, prefs.rag.top_k):
                    if ch.text not in seen:
                        seen.add(ch.text)
                        rag_chunks.append(ch)
            rag_chunks = rag_chunks[: max(prefs.rag.top_k * 2, prefs.rag.top_k)]
        return await investigator.investigate(
            cluster, enrichment, rag_chunks, prefs, budget, surface=surface, case_id=case_id,
            persona=persona, playbook=playbook, memory=memory,
        )

    try:
        return await _run_with_langgraph(do_triage, do_benign, do_investigate)
    except Exception as exc:  # noqa: BLE001 — LangGraph optional/fragile; never break the flow
        logger.info("LangGraph unavailable/failed (%s); using direct investigation flow", exc)
        return await _run_direct(do_triage, do_benign, do_investigate)


async def _run_direct(do_triage, do_benign, do_investigate) -> tuple[VerdictResult, float]:
    triage = await do_triage()
    cost = triage.cost
    if triage.bucket == TriageBucket.BENIGN:
        verdict, c = await do_benign(triage)
    else:
        verdict, c = await do_investigate()
    return verdict, cost + c


async def _run_with_langgraph(do_triage, do_benign, do_investigate) -> tuple[VerdictResult, float]:
    from langgraph.graph import END, StateGraph

    class FlowState(TypedDict, total=False):
        triage: Any
        verdict: VerdictResult
        cost: float

    async def triage_node(state: FlowState) -> FlowState:
        triage = await do_triage()
        return {"triage": triage, "cost": state.get("cost", 0.0) + triage.cost}

    async def benign_node(state: FlowState) -> FlowState:
        verdict, c = await do_benign(state["triage"])
        return {"verdict": verdict, "cost": state.get("cost", 0.0) + c}

    async def investigate_node(state: FlowState) -> FlowState:
        verdict, c = await do_investigate()
        return {"verdict": verdict, "cost": state.get("cost", 0.0) + c}

    def route(state: FlowState) -> str:
        return "benign" if state["triage"].bucket == TriageBucket.BENIGN else "investigate"

    # Node names must not collide with FlowState keys (LangGraph reserves keys),
    # so the nodes are suffixed while the routing values map to those node names.
    graph = StateGraph(FlowState)
    graph.add_node("triage_step", triage_node)
    graph.add_node("benign_step", benign_node)
    graph.add_node("investigate_step", investigate_node)
    graph.set_entry_point("triage_step")
    graph.add_conditional_edges(
        "triage_step", route, {"benign": "benign_step", "investigate": "investigate_step"}
    )
    graph.add_edge("benign_step", END)
    graph.add_edge("investigate_step", END)
    app = graph.compile()

    out = await app.ainvoke({"cost": 0.0})
    return out["verdict"], out.get("cost", 0.0)
