"""Adaptive-threshold TUNING routes — Round 4 / Wave 4.

A SEPARATE feature router (the integrator mounts it with the same ``require_auth``
mount the monolith uses). It surfaces the deterministic, no-LLM nightly tuner
(:mod:`app.engine.threshold_tuner`) + its audit/rollback ledger
(:class:`app.stores.tuning.TuningStore`) to an operator:

* ``GET  /api/tuning/recommendations`` — the current per-rule noise (Wilson-LB FP
                                        rate + sample counts) + the tuner's PROPOSED
                                        bounded change per rule (a pure DRY-RUN — no
                                        write) + the applied/rolled-back ledger.
* ``GET  /api/tuning/config``          — read ``Preferences.threshold_tuning``.
* ``PUT  /api/tuning/config``          — update ``Preferences.threshold_tuning``.
* ``POST /api/tuning/{rule_id}/apply`` — apply the proposed bounded change for ONE
                                        rule (shadow-evaluated first; a suppression
                                        DROP is NEVER auto-applied — it is routed to
                                        the existing HITL Proposal queue).
* ``POST /api/tuning/{rule_id}/rollback`` — reverse the latest active auto-applied
                                        change for one rule (restore its ``before``).

⚠ NON-NEGOTIABLES held here. #3: nothing in this router imports or calls
``case_manager.decide()``; the tuner only moves detection-VOLUME knobs
(``CorrelationRule.n`` / a feed ``severity_floor``) that the pipeline already reads
live — it never sets a case status/disposition/verdict/risk. #4: the tuner never
recomputes a ``cluster_signature``. #2: every apply / rollback / config change writes
an append-only ``ActionType.TUNING`` audit row (best-effort). #9: every rule id /
error string returned is PLAIN, length-bounded, attacker-influenceable data — the UI
renders it escaped and it is never fed back into a prompt. A suppression DROP proposal
is returned as a HITL Proposal (linked to ``/api/proposals``); the router NEVER
auto-applies a DROP.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from ..config import ThresholdTuningConfig
from ..constants import ActionType, CaseStatus
from ..engine import threshold_tuner as tuner
from ..models import Case
from ..state import AppState
from .deps import current_username, get_state, require_permission

logger = logging.getLogger("tlsoc.api.tuning")

router = APIRouter(prefix="/api")

# How many CLOSED cases we page for the trailing window when computing a dry-run
# recommendation / applying a single-rule change. Bounded so a busy tenant can't
# unbound the read; the tuner pages until a short page, capped by this page size.
_PAGE_SIZE = 500


def _safe(value: Any) -> str:
    """Plain, length-bounded string for the client (#9): the UI renders it escaped and
    it is never fed back into a prompt. Bounds a runaway error body."""
    return str(value)[:2000]


def _closed_reader(state: AppState):
    """An async ``read(limit, offset) -> list[Case]`` pager over CLOSED + RESOLVED
    cases — the tuner's window source. Never raises (a store glitch → an empty page →
    the tuner degrades to "no recommendation")."""

    async def _read(limit: int, offset: int) -> list[Case]:
        collected: list[Case] = []
        for status in (CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value):
            try:
                cases, _total = await state.cases.list(
                    status=status, limit=limit, offset=offset,
                )
            except Exception as exc:  # noqa: BLE001 — a read glitch never breaks tuning
                logger.warning("tuning window read failed (%s); using empty page", exc)
                continue
            collected.extend(cases)
        return collected

    return _read


async def _window_cases(state: AppState) -> list[Case]:
    """Materialise the trailing-window CLOSED/RESOLVED cases (paged, not naive-200)."""
    reader = _closed_reader(state)
    out: list[Case] = []
    offset = 0
    for _ in range(200):  # generous page ceiling, far above the old 200-cap
        page = await reader(_PAGE_SIZE, offset)
        if not page:
            break
        out.extend(page)
        offset += _PAGE_SIZE
        if len(page) < _PAGE_SIZE:
            break
    return out


def _proposal_json(prop: tuner.TuningProposal, *, shadow_blocked: bool) -> dict[str, Any]:
    """PLAIN JSON for one dry-run proposed change (#9)."""
    st = prop.stat
    return {
        "rule_id": _safe(prop.rule_id),
        "kind": _safe(prop.kind),
        "before": prop.before,
        "after": prop.after,
        "feed_key": _safe(prop.feed_key) if prop.feed_key else None,
        "source_id": _safe(prop.source_id) if prop.source_id else None,
        "feed_id": _safe(prop.feed_id) if prop.feed_id else None,
        "fp_rate": round(st.fp_lower_bound, 4),
        "samples": st.total,
        # A suppression DROP is HITL-only; a shadow-blocked raise is forced to review.
        "auto_apply": prop.kind != "suppression" and not shadow_blocked,
        "shadow_blocked": shadow_blocked,
        "reason": (
            "suppression_drop" if prop.kind == "suppression"
            else "shadow_eval_would_hide_tp" if shadow_blocked
            else "auto_apply_candidate"
        ),
    }


# --------------------------------------------------------------------------- #
# GET /api/tuning/recommendations — per-rule noise + proposed changes (DRY-RUN)
# --------------------------------------------------------------------------- #
@router.get("/tuning/recommendations")
async def tuning_recommendations(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("automation", "read")),
) -> dict[str, Any]:
    """Current per-rule noise + the tuner's PROPOSED bounded change per rule.

    This is a pure DRY-RUN: it accumulates the per-rule Wilson-LB FP rate over the
    trailing CLOSED-case window and derives the proposals the tuner WOULD make — but
    writes NOTHING (no ledger row, no Proposal, no prefs change). It also returns the
    applied/rolled-back ledger so the UI can show before/after + offer a rollback.
    Enabled/disabled is advisory here — the dry-run always computes so an operator can
    preview before switching the tuner on."""
    prefs = state.execution_prefs
    cfg = getattr(prefs, "threshold_tuning", None) or ThresholdTuningConfig()

    cases = await _window_cases(state)
    stats = tuner._accumulate_rule_stats(
        cases, ewma_alpha=cfg.ewma_alpha, z=cfg.wilson_z,
    )
    proposals = tuner.derive_proposals(prefs, stats)
    recos: list[dict[str, Any]] = []
    for prop in proposals:
        blocked = bool(
            cfg.shadow_eval
            and prop.kind != "suppression"
            and tuner.shadow_eval_hides_true_positive(prop, cases)
        )
        recos.append(_proposal_json(prop, shadow_blocked=blocked))

    # Per-rule noise for EVERY observed rule (not only ones clearing the bar), so the
    # UI can show the full picture and why a rule did / didn't get a proposal.
    rule_noise: list[dict[str, Any]] = []
    for rid in sorted(stats):
        st = stats[rid]
        rule_noise.append({
            "rule_id": _safe(rid),
            "total": st.total,
            "fp": st.fp,
            "tp": st.tp,
            "fp_rate": round(st.fp_lower_bound, 4),
            "volume_ewma": (round(st.volume_ewma, 3) if st.volume_ewma is not None else None),
            "over_target": st.total >= int(cfg.min_samples) and st.fp_lower_bound > float(cfg.fp_rate_target),
        })

    try:
        ledger = await state.tuning_store.list()
    except Exception as exc:  # noqa: BLE001 — ledger is best-effort
        logger.warning("tuning ledger read failed (%s); returning empty", exc)
        ledger = []

    return {
        "enabled": bool(cfg.enabled),
        "cadence": _safe(cfg.cadence),
        "fp_rate_target": float(cfg.fp_rate_target),
        "min_samples": int(cfg.min_samples),
        "window_cases": len(cases),
        "rule_noise": rule_noise,
        "recommendations": recos,
        "applied": [r.to_json() for r in ledger],
    }


# --------------------------------------------------------------------------- #
# GET / PUT /api/tuning/config — read/update Preferences.threshold_tuning
# --------------------------------------------------------------------------- #
@router.get("/tuning/config")
async def get_tuning_config(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("automation", "read")),
) -> dict[str, Any]:
    cfg = getattr(state.execution_prefs, "threshold_tuning", None) or ThresholdTuningConfig()
    return {"config": cfg.model_dump(mode="json")}


@router.put("/tuning/config")
async def put_tuning_config(
    body: ThresholdTuningConfig,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("automation", "manage")),
) -> dict[str, Any]:
    """Update the ``threshold_tuning`` policy. Additive + validated by the Pydantic
    model; never touches ``decide()`` (#3). Audited (#2)."""
    prefs = state.execution_prefs.model_copy(update={"threshold_tuning": body})
    await state.update_execution_prefs(prefs)
    await _audit(
        state, request, "tuning_config_update",
        f"enabled={body.enabled} cadence={body.cadence} "
        f"fp_target={body.fp_rate_target} min_samples={body.min_samples} "
        f"max_n_step={body.max_n_step} shadow_eval={body.shadow_eval}",
    )
    return {"ok": True, "config": body.model_dump(mode="json")}


# --------------------------------------------------------------------------- #
# POST /api/tuning/{rule_id}/apply — apply the proposed change for ONE rule
# --------------------------------------------------------------------------- #
@router.post("/tuning/{rule_id}/apply")
async def apply_tuning(
    rule_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("automation", "manage")),
) -> dict[str, Any]:
    """Apply the tuner's proposed bounded change for ONE rule (shadow-evaluated).

    Reuses the engine's SAFE per-proposal router (``_handle_proposal``): a bounded
    ``correlation_n`` / ``severity_floor`` raise is auto-applied (after shadow-eval) +
    recorded in the ledger; a suppression DROP or a shadow-blocked raise is routed to
    the existing HITL Proposal queue and is NEVER auto-applied here. The router never
    calls ``decide()`` (#3). Returns whether it applied or queued.

    404 when no proposal exists for ``rule_id`` (the rule isn't noisy / cleared the
    bar) so the caller gets an honest signal rather than a silent no-op."""
    rid = (rule_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="rule_id is required")

    prefs = state.execution_prefs
    cfg = getattr(prefs, "threshold_tuning", None) or ThresholdTuningConfig()
    cases = await _window_cases(state)
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=cfg.ewma_alpha, z=cfg.wilson_z)
    proposals = [p for p in tuner.derive_proposals(prefs, stats) if p.rule_id == rid]
    if not proposals:
        raise HTTPException(
            status_code=404,
            detail=f"no tuning recommendation for rule {_safe(rid)}",
        )

    writers = {
        "correlation_n": tuner.apply_correlation_n,
        "severity_floor": tuner.apply_severity_floor,
    }
    outcome = tuner.TuningOutcome(ran=True, rule_stats=stats)
    current_prefs = prefs
    try:
        for prop in proposals:
            current_prefs = await tuner._handle_proposal(
                prop, current_prefs, cases, cfg,
                proposals=state.proposals, audit=state.audit,
                tuning_store=state.tuning_store, writers=writers, outcome=outcome,
            )
    except Exception as exc:  # noqa: BLE001 — the tuner must never break the caller
        logger.warning("tuning apply for %s failed: %s", rid, exc)
        raise HTTPException(status_code=500, detail=_safe(exc)) from exc

    # Persist the composed prefs change ONCE (only when something auto-applied).
    if current_prefs is not prefs:
        await state.update_execution_prefs(current_prefs)

    applied = [r.to_json() for r in outcome.auto_applied]
    queued = [
        {"id": _safe(p.id), "kind": _safe(p.kind), "status": _safe(p.status)}
        for p in outcome.proposals
    ]
    # #2 — an explicit apply is audited even if the engine already audited an auto-apply.
    await _audit(
        state, request, "tuning_apply",
        f"rule={rid} applied={len(applied)} queued={len(queued)} "
        f"shadow_blocked={outcome.shadow_blocked}",
    )
    return {
        "ok": True,
        "rule_id": _safe(rid),
        "applied": applied,
        "queued_proposals": queued,
        "shadow_blocked": [_safe(x) for x in outcome.shadow_blocked],
    }


# --------------------------------------------------------------------------- #
# POST /api/tuning/{rule_id}/rollback — reverse the latest active change
# --------------------------------------------------------------------------- #
@router.post("/tuning/{rule_id}/rollback")
async def rollback_tuning(
    rule_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("automation", "manage")),
) -> dict[str, Any]:
    """Reverse the most recent active auto-applied change keyed on ``rule_id``.

    ``rule_id`` here is the LEDGER key: a ``CorrelationRule`` id for an ``n`` raise, or
    the ``"<source_id>:<feed_id>"`` feed key for a ``severity_floor`` raise. Restores
    the record's ``before`` via the SAME config-writers the apply used (never a case /
    verdict / signature). 404 when there is no active record for the key."""
    rid = (rule_id or "").strip()
    if not rid:
        raise HTTPException(status_code=400, detail="rule_id is required")

    try:
        active = [r for r in await state.tuning_store.list(rule_id=rid, active_only=True)]
    except Exception as exc:  # noqa: BLE001
        logger.warning("tuning ledger read for rollback failed (%s)", exc)
        active = []
    if not active:
        raise HTTPException(
            status_code=404, detail=f"no active tuning record for {_safe(rid)}",
        )

    # list() is newest-first — roll back the most recent active record for the rule.
    record = active[0]
    ok = await tuner.rollback(
        record.id, state.execution_prefs,
        tuning_store=state.tuning_store, write_prefs=state.update_execution_prefs,
        audit=state.audit,
    )
    if not ok:
        raise HTTPException(status_code=409, detail="rollback could not be applied")
    await _audit(
        state, request, "tuning_rollback",
        f"rule={rid} record={record.id} {record.target} {record.after}->{record.before}",
    )
    return {"ok": True, "rule_id": _safe(rid), "record_id": _safe(record.id)}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
async def _audit(state: AppState, request: Request, event: str, detail: str) -> None:
    """Append-only ``ActionType.TUNING`` audit of an operator tuning mutation (#2).
    Best-effort; the actor is the authenticated username when present."""
    audit = getattr(state, "_real_audit", None) or getattr(state, "audit", None)
    if audit is None:
        return
    try:
        await audit.record(
            action_type=ActionType.TUNING,
            surface="tuning",
            actor=current_username(request) or "",
            result_summary=f"{event}: {detail}"[:500],
        )
    except Exception:  # noqa: BLE001
        pass
