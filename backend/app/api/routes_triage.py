"""Round 3 — Feature 12: clearer cases + agent-work visualization.

Two READ-ONLY endpoints assembled at READ TIME from already-recorded facts (the
case + its audit rows + the usage/cost ledger) — they NEVER mutate state and NEVER
call the LLM:

* ``GET /api/cases/{id}/triage`` — the FOUR honestly-distinct advisory chips
  ``{risk, severity, impact, priority}``, each with the inputs a UI HelpTip shows.
  Pure derivation via :mod:`app.engine.priority`.
* ``GET /api/cases/{id}/timeline`` — a TYPED ReAct span timeline (the ``TraceSpan``
  shape) projected from the audit rows + the usage ledger, with the deterministic
  ``case_manager`` DECISION rendered as a distinct TERMINAL step showing its exact
  ``(verdict, confidence, risk_score, policy clause)`` so #3's determinism is VISIBLE.

⛔ NON-NEGOTIABLE #3: every advisory band here is PRESENTATION/ORDERING ONLY and is
never fed to ``case_manager.decide()``. The timeline's terminal decision step
RE-DERIVES the decision via ``decide()`` purely to DISPLAY the exact clause — it
mutates nothing.

⛔ NON-NEGOTIABLE #9: the projection separates TRUSTED agent prose (router/
investigator/formatter/decision summaries) from UNTRUSTED tool/log payloads
(es_query / tool output, which carry source-influenceable data). Each span carries a
``trusted`` flag; the returned values are plain DATA the UI render-escapes — nothing
here is interpolated into a prompt.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..constants import ActionType
from ..engine.case_manager import decide
from ..engine.priority import derive_triage
from ..models import TraceSpan
from .deps import get_state, require_permission

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- #
# GET /api/cases/{id}/triage — the four honest chips
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/triage")
async def case_triage(
    case_id: str,
    state: "Any" = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """The FOUR honestly-distinct advisory chips for a case.

    ``risk`` (the existing deterministic 0-100 score + breakdown), ``severity``
    (SOURCE-asserted, NOT risk), ``impact`` (asset criticality), and ``priority``
    (ITIL Impact×Urgency). Each carries an ``inputs`` bag for a UI HelpTip. NEVER
    404s — an unknown case returns an empty-but-renderable shell. Pure derivation
    (#3: advisory only, never feeds the decision)."""
    case = await state.cases.get(case_id)
    if case is None:
        return {"case_id": case_id, "found": False, "chips": _empty_chips()}
    chips = derive_triage(case, state.prefs)
    return {"case_id": case_id, "found": True, "chips": chips}


def _empty_chips() -> dict[str, Any]:
    """A renderable zero-state for an unknown case (never 404, never raises)."""
    low = {"band": "low", "value": 0.0}
    return {
        "risk": {**low, "breakdown": {}, "inputs": {}},
        "severity": {**low, "raw": None, "source": "derived", "inputs": {}},
        "impact": {**low, "criticality": 0.0, "entity": "", "inputs": {}},
        "priority": {
            "level": None, "impact": "low", "matched": False, "default": "P3",
            "urgency": {"band": "low", "value": 0.0, "escalated": False},
            "inputs": {},
        },
    }


# --------------------------------------------------------------------------- #
# GET /api/cases/{id}/timeline — typed ReAct span timeline
# --------------------------------------------------------------------------- #
@router.get("/cases/{case_id}/timeline")
async def case_timeline(
    case_id: str,
    state: "Any" = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """A TYPED ReAct span timeline for a case (the ``TraceSpan`` shape).

    Assembled from the already-recorded ``tlsoc-agent-audit`` rows (oldest-first) +
    the per-case usage/cost ledger. Each audit row becomes ONE span classified by
    ``kind`` (invoke_agent | chat | execute_tool | decision) with ``step_index`` /
    ``latency`` / ``cost`` / ``tokens`` / ``trusted``. The ``case_manager`` DECISION
    is rendered as a distinct TERMINAL ``decision`` span whose summary shows the exact
    ``(verdict, confidence, risk_score, policy clause)`` the deterministic ``decide()``
    produced — re-derived at read time, mutating nothing (#3 made visible).

    TRUSTED agent prose (router/investigator/formatter/decision) vs UNTRUSTED tool/log
    payloads (es_query / tool output) are separated by the per-span ``trusted`` flag
    (#9). NEVER 404s — an unknown / not-yet-investigated case returns empty spans.
    ``prompt_excerpt`` text is dropped from a span summary when
    ``prefs.trace.include_prompts`` is false (the untrusted-prompt toggle)."""
    rows = await state.audit.records_for_case(case_id)
    include_prompts = getattr(state.prefs.trace, "include_prompts", True)

    # Per-role cost/token attribution from the usage ledger (aggregate → per-span).
    cost_by_role, tokens_by_role = await _usage_attribution(state, case_id)

    # Count the audit LLM rows (PROMPT + VERDICT) per role from the SAME rows the spans
    # are built from. The role's ledger TOTAL is split across exactly the spans that
    # receive a slice — NOT the ledger call count — so the per-role span sum reconciles
    # with the ledger for any N (a single-call normal run AND a multi-step ReAct loop).
    # See routes_triage tests test_timeline_totals_reconcile_*.
    audit_llm_rows_by_role = _count_llm_rows_by_role(rows)

    spans: list[TraceSpan] = []
    step = 0
    for row in rows:
        # The case_manager DECISION row is rendered as a distinct terminal span below,
        # re-derived from decide() — skip the raw audit projection for it here.
        actor = str(_get(row, "actor", ""))
        at = str(_get(row, "action_type", "") or "")
        if actor == "case_manager" and at == ActionType.DECISION.value:
            continue
        span = _row_to_span(case_id, row, step, include_prompts,
                            cost_by_role, tokens_by_role, audit_llm_rows_by_role)
        spans.append(span)
        step += 1

    # --- the distinct TERMINAL decision span (re-derive decide() for the EXACT clause) -
    case = await state.cases.get(case_id)
    decision_span = _decision_span(case_id, case, state, step)
    if decision_span is not None:
        spans.append(decision_span)

    return {
        "case_id": case_id,
        "spans": [s.model_dump(mode="json") for s in spans],
        "total": len(spans),
        "totals": {
            "cost": round(sum(s.cost or 0.0 for s in spans), 6),
            "tokens": sum(s.tokens or 0 for s in spans),
        },
    }


# --------------------------------------------------------------------------- #
# Helpers — pure projection (defensive; never raise)
# --------------------------------------------------------------------------- #
def _get(row: Any, key: str, default: Any = None) -> Any:
    """Read a field from an audit row that may be a dict OR a pydantic AuditDoc."""
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


# Audit action types that represent ONE LLM-producing step (a gateway completion the
# ledger metered). These are exactly the rows ``_row_to_span`` attributes a cost slice
# to (``is_llm_row``), so dividing a role's ledger total by their per-role COUNT makes
# the per-role span sum reconcile with the ledger truth (#6 source of truth).
_LLM_ROW_ACTIONS: frozenset[str] = frozenset({
    ActionType.PROMPT.value,
    ActionType.VERDICT.value,
})


def _count_llm_rows_by_role(rows: Any) -> dict[str, int]:
    """Count the LLM-producing audit rows (PROMPT/VERDICT) per actor role.

    This is the EXACT divisor for cost/token attribution: the role's ledger total is
    split across precisely the spans that receive a slice. The case_manager DECISION row
    is excluded (it is rendered as the deterministic terminal span, never an LLM step).
    Defensive: tolerates dict OR pydantic rows; never raises."""
    by_role: dict[str, int] = {}
    for row in rows:
        actor = str(_get(row, "actor", "") or "")
        at = str(_get(row, "action_type", "") or "")
        if actor == "case_manager" and at == ActionType.DECISION.value:
            continue
        if at in _LLM_ROW_ACTIONS:
            by_role[actor] = by_role.get(actor, 0) + 1
    return by_role


# audit action_type → TraceSpan.kind. Agent invocations (PROMPT/VERDICT/CONTEXT/the
# router DECISION) are ``invoke_agent``; tool + es_query rows are ``execute_tool``;
# the case_manager DECISION is ``decision`` (handled separately). Anything else
# defaults to ``invoke_agent`` (a generic pipeline step).
_KIND_BY_ACTION: dict[str, str] = {
    ActionType.PROMPT.value: "invoke_agent",
    ActionType.VERDICT.value: "invoke_agent",
    ActionType.CONTEXT.value: "invoke_agent",
    ActionType.DECISION.value: "invoke_agent",   # router triage decision (not case_manager)
    ActionType.TOOL_CALL.value: "execute_tool",
    ActionType.ES_QUERY.value: "execute_tool",
    ActionType.ERROR.value: "invoke_agent",
}

# Action types whose payload carries source/log-influenceable data → UNTRUSTED (#9).
_UNTRUSTED_ACTIONS: frozenset[str] = frozenset({
    ActionType.TOOL_CALL.value,
    ActionType.ES_QUERY.value,
})


def _row_to_span(
    case_id: str,
    row: Any,
    step: int,
    include_prompts: bool,
    cost_by_role: dict[str, float],
    tokens_by_role: dict[str, int],
    llm_rows_by_role: dict[str, int],
) -> TraceSpan:
    """Project one audit row into a typed TraceSpan.

    Classifies the span ``kind``, marks tool/log payloads UNTRUSTED (#9), and
    attributes a per-role cost/token slice from the usage ledger to the LLM-producing
    rows (PROMPT/VERDICT). The slice divisor is the per-role COUNT of those same audit
    rows (``llm_rows_by_role``) — NOT the ledger call count — so the per-role span sum
    reconciles with the ledger for both a single-call run and a multi-step ReAct loop.
    The ``summary`` carries SHORT prose only — the heavy payload is left in the audit doc
    (referenced by ``payload_ref``), never re-inlined here."""
    actor = str(_get(row, "actor", "") or "")
    at = str(_get(row, "action_type", "") or "")
    kind = _KIND_BY_ACTION.get(at, "invoke_agent")
    untrusted = at in _UNTRUSTED_ACTIONS

    # Build a short, render-safe summary (TRUSTED prose vs an UNTRUSTED payload note).
    tool_name = _get(row, "tool_name") or ""
    query_text = _get(row, "query_text") or ""
    result_summary = str(_get(row, "result_summary") or "")
    tool_out = str(_get(row, "tool_output_summary") or "")
    if untrusted:
        # UNTRUSTED: do NOT inline the log/tool output as if it were trusted prose;
        # name the tool + query and point at the audit row for the payload.
        bits = []
        if tool_name:
            bits.append(f"tool={tool_name}")
        if query_text:
            bits.append(f"query={query_text}")
        summary = " · ".join(bits) or (tool_out[:200] if tool_out else "(tool call)")
    else:
        # TRUSTED agent prose. Drop the untrusted prompt excerpt unless allowed.
        summary = result_summary
        if not summary and at == ActionType.PROMPT.value and include_prompts:
            summary = str(_get(row, "prompt_excerpt") or "")
        if not summary:
            summary = f"{actor or kind} step"

    # Cost / token attribution: only LLM-producing rows (a PROMPT or VERDICT by an LLM
    # role) take a slice of that role's ledger total (split evenly across that role's
    # LLM AUDIT ROWS so per-case totals reconcile with the ledger — see #6).
    cost = None
    tokens = None
    model = _get(row, "model")
    is_llm_row = at in _LLM_ROW_ACTIONS
    if is_llm_row and actor in cost_by_role:
        n = max(1, llm_rows_by_role.get(actor, 1))
        cost = round(cost_by_role.get(actor, 0.0) / n, 6)
        tokens = int(tokens_by_role.get(actor, 0) / n)

    return TraceSpan(
        case_id=case_id,
        step_index=step,
        kind=kind,
        name=(actor or at or kind),
        ts=str(_get(row, "ts", "") or ""),
        latency_ms=None,
        cost=cost,
        tokens=tokens,
        trusted=not untrusted,
        summary=summary[:2000],
        payload_ref={
            "action_type": at,
            "actor": actor,
            "model": model,
            "tool_name": tool_name or None,
        },
    )


def _decision_span(case_id: str, case: Any, state: Any, step: int) -> TraceSpan | None:
    """The distinct TERMINAL ``decision`` span — re-derives ``decide()`` at read time
    to surface its EXACT clause, making #3's determinism visible.

    Returns None for a case that never reached a verdict (no decision to show). The
    span is ALWAYS ``trusted`` (it is our own deterministic prose) and carries the
    decision INPUTS (verdict / confidence / risk_score / the matched policy clause)
    in ``payload_ref`` so the UI can render the exact truth-table evaluation. This
    call MUTATES NOTHING (decide() is a pure, side-effect-free function)."""
    if case is None or case.verdict is None:
        return None
    prefs = state.prefs
    decision = decide(
        case.verdict,
        case.confidence,
        case.risk_score,
        prefs.auto_close,
        escalation_confidence=prefs.escalation_confidence,
        critical_severity=prefs.critical_severity,
    )
    verdict_v = case.verdict.value if case.verdict else None
    return TraceSpan(
        case_id=case_id,
        step_index=step,
        kind="decision",
        name="case_manager",
        ts=case.updated_at or "",
        latency_ms=None,
        cost=0.0,         # the deterministic decision costs nothing (no LLM call)
        tokens=0,
        trusted=True,     # our own deterministic rationale — never untrusted log data
        summary=decision.rationale,
        payload_ref={
            "deterministic": True,
            "verdict": verdict_v,
            "confidence": round(float(case.confidence), 4),
            "risk_score": round(float(case.risk_score), 2),
            "decision_status": decision.status.value,
            "decision_by": decision.decision_by.value,
            "escalate": decision.escalate,
            "objection_window_expires_at": decision.objection_window_expires_at,
            "policy_clause": _policy_clause(case, prefs),
        },
    )


def _policy_clause(case: Any, prefs: Any) -> dict[str, Any]:
    """Surface the exact AutoClosePolicy clause that decide() evaluated for this
    verdict class (the thresholds the deterministic truth table compared against).
    Read-only display of config — never changes anything."""
    from ..constants import Verdict

    entry = None
    if case.verdict == Verdict.FALSE_POSITIVE:
        entry = prefs.auto_close.false_positive
    elif case.verdict == Verdict.TRUE_POSITIVE:
        entry = prefs.auto_close.true_positive
    if entry is None:
        # NEEDS_HUMAN / unknown verdict: code-enforced, never auto-closable.
        return {
            "verdict_class": (case.verdict.value if case.verdict else None),
            "auto_closable": False,
            "note": "NEEDS_HUMAN / unknown verdict never auto-closes (code-enforced).",
        }
    return {
        "verdict_class": case.verdict.value,
        "enabled": entry.enabled,
        "min_confidence": entry.min_confidence,
        "max_risk_score": entry.max_risk_score,
        "objection_window_minutes": entry.objection_window_minutes,
        "auto_closable": bool(entry.enabled),
    }


async def _usage_attribution(
    state: Any, case_id: str
) -> tuple[dict[str, float], dict[str, int]]:
    """Per-role cost/token TOTALS for a case from the usage ledger (#6 source of truth).

    Returns the per-role ledger totals; the per-span divisor is the count of LLM AUDIT
    rows (see :func:`_count_llm_rows_by_role`), NOT the ledger call count — that is what
    makes the per-role span sum reconcile with the ledger for a multi-step ReAct run
    (N gateway calls metered, but only the PROMPT + VERDICT audit rows carry a slice).
    Defensive: a ledger miss degrades to empty maps (no cost shown), never raises. Reads
    the aggregate ``summary(case_id=...)`` — does NOT touch the gateway write path (#6
    stays the single writer)."""
    cost_by_role: dict[str, float] = {}
    tokens_by_role: dict[str, int] = {}
    try:
        summary = await state.usage_store.summary(window_hours=24 * 365, case_id=case_id)
    except Exception:  # noqa: BLE001 — the timeline must never 500 on a ledger miss
        return cost_by_role, tokens_by_role
    for entry in (summary.get("by_role") or []):
        if not isinstance(entry, dict):
            continue
        key = str(entry.get("key", ""))
        if not key:
            continue
        cost_by_role[key] = float(entry.get("cost", 0.0) or 0.0)
        tokens_by_role[key] = int(entry.get("tokens", 0) or 0)
    return cost_by_role, tokens_by_role
