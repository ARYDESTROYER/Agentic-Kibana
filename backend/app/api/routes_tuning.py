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
* ``POST /api/tuning/{rule_id}/apply`` — recompute and process every current proposal
                                        for ONE rule. Review-first is the default; an
                                        explicitly permitted automatic change still
                                        requires independent analyst evidence and a
                                        clean shadow evaluation.
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
from ..constants import ActionType
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
    cases — the tuner's window source. A status-store failure aborts the read rather
    than presenting partial evidence as a complete tuning window."""

    return tuner.terminal_case_reader(state.cases)


async def _window_cases(state: AppState) -> list[Case]:
    """Materialise the trailing-window CLOSED/RESOLVED cases (paged, not naive-200)."""
    reader = _closed_reader(state)
    out: list[Case] = []
    offset = 0
    try:
        for _ in range(200):  # generous page ceiling, far above the old 200-cap
            page = await reader(_PAGE_SIZE, offset)
            if not page:
                break
            out.extend(page)
            offset += len(page)
            if len(page) < _PAGE_SIZE:
                break
    except Exception as exc:  # noqa: BLE001 — never compute from a partial window
        logger.warning("tuning terminal-case window unavailable: %s", exc)
        raise HTTPException(
            status_code=503,
            detail="Terminal case evidence is temporarily unavailable; tuning was not run",
        ) from exc
    return out


async def _confirmed_ledger_and_guards(
    state: AppState,
    cfg: ThresholdTuningConfig,
) -> tuple[list[Any], dict[str, int], set[str]]:
    """Read one complete ledger snapshot and derive the shared window guards.

    Recommendations and explicit apply are authority-bearing views: if history is
    unavailable they must not say "no prior tuning" and derive another bump.  The
    background scheduler uses the same pure projection in ``run_once``.
    """
    try:
        ledger = await state.tuning_store.list_strict()
    except Exception as exc:  # noqa: BLE001 — false-empty would be unsafe here
        logger.warning("tuning ledger unavailable: %s", exc)
        raise HTTPException(
            status_code=503,
            detail=(
                "Tuning history is temporarily unavailable; recommendations and "
                "manual apply were not computed"
            ),
        ) from exc
    already_tuned, already_tuned_floors = tuner.tuning_guards_from_records(
        ledger,
        tuner.tuning_window_start(cfg.cadence),
    )
    return ledger, already_tuned, already_tuned_floors


def _proposal_json(
    prop: tuner.TuningProposal,
    *,
    shadow_blocked: bool,
    policy_allows: bool,
) -> dict[str, Any]:
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
        "analyst_samples": st.total,
        "observed_cases": st.observed,
        "unconfirmed_cases": st.unconfirmed,
        "confirmed_false_positives": st.fp,
        "confirmed_true_positives": st.tp,
        # A suppression DROP is HITL-only; a shadow-blocked raise is forced to review.
        "auto_apply": (
            prop.kind not in {"suppression", "evidence_collection"}
            and not shadow_blocked
            and policy_allows
        ),
        "shadow_blocked": shadow_blocked,
        "reason": (
            "insufficient_analyst_evidence" if prop.kind == "evidence_collection"
            else "suppression_drop" if prop.kind == "suppression"
            else "shadow_eval_would_hide_confirmed_tp" if shadow_blocked
            else "policy_requires_approval" if not policy_allows
            else "confirmed_evidence_candidate"
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
    ledger, already_tuned, already_tuned_floors = await _confirmed_ledger_and_guards(
        state, cfg
    )
    proposals = tuner.derive_proposals(
        prefs,
        stats,
        already_tuned=already_tuned,
        already_tuned_floors=already_tuned_floors,
    )
    recos: list[dict[str, Any]] = []
    for prop in proposals:
        blocked = bool(
            cfg.shadow_eval
            and prop.kind != "suppression"
            and tuner.shadow_eval_hides_true_positive(prop, cases)
        )
        recos.append(_proposal_json(
            prop,
            shadow_blocked=blocked,
            policy_allows=bool(cfg.auto_apply_confirmed),
        ))

    # Per-rule noise for EVERY observed rule (not only ones clearing the bar), so the
    # UI can show the full picture and why a rule did / didn't get a proposal.
    rule_noise: list[dict[str, Any]] = []
    for rid in sorted(stats):
        st = stats[rid]
        rule_noise.append({
            "rule_id": _safe(rid),
            "observed": st.observed,
            "total": st.total,
            "analyst_samples": st.total,
            "unconfirmed": st.unconfirmed,
            "fp": st.fp,
            "tp": st.tp,
            "fp_rate": round(st.fp_lower_bound, 4),
            "volume_ewma": (round(st.volume_ewma, 3) if st.volume_ewma is not None else None),
            "over_target": st.total >= int(cfg.min_samples) and st.fp_lower_bound > float(cfg.fp_rate_target),
        })

    return {
        "enabled": bool(cfg.enabled),
        "cadence": _safe(cfg.cadence),
        "fp_rate_target": float(cfg.fp_rate_target),
        "min_samples": int(cfg.min_samples),
        "auto_apply_confirmed": bool(cfg.auto_apply_confirmed),
        "window_cases": len(cases),
        "rule_noise": rule_noise,
        "recommendations": recos,
        "applied": [r.to_json() for r in ledger],
        "history_status": "available",
        "history_count": len(ledger),
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
    await state.mutate_execution_prefs(
        lambda prefs: prefs.model_copy(update={"threshold_tuning": body})
    )
    await _audit(
        state, request, "tuning_config_update",
        f"enabled={body.enabled} cadence={body.cadence} "
        f"fp_target={body.fp_rate_target} min_samples={body.min_samples} "
        f"max_n_step={body.max_n_step} shadow_eval={body.shadow_eval} "
        f"auto_apply_confirmed={body.auto_apply_confirmed}",
    )
    return {"ok": True, "config": body.model_dump(mode="json")}


# --------------------------------------------------------------------------- #
# POST /api/tuning/{rule_id}/apply — process current proposals for ONE rule
# --------------------------------------------------------------------------- #
@router.post("/tuning/{rule_id}/apply")
async def apply_tuning(
    rule_id: str,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("automation", "manage")),
) -> dict[str, Any]:
    """Recompute and process every current proposed change for ONE rule.

    Reuses the engine's SAFE per-proposal router (``_handle_proposal``): bounded
    changes enter the HITL Proposal queue by default after shadow evaluation. An
    explicitly enabled automatic policy still requires sufficient independent analyst
    evidence; suppression drops are never applied automatically. The router never
    calls ``decide()`` (#3). Returns the applied, queued, and shadow-blocked outcomes.

    404 when no proposal exists for ``rule_id`` (the rule isn't noisy / cleared the
    bar) so the caller gets an honest signal rather than a silent no-op."""
    rid = tuner.normalize_rule_id(rule_id)
    if not rid:
        raise HTTPException(status_code=400, detail="rule_id is required")

    prefs = state.execution_prefs
    cfg = getattr(prefs, "threshold_tuning", None) or ThresholdTuningConfig()
    cases = await _window_cases(state)
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=cfg.ewma_alpha, z=cfg.wilson_z)
    _ledger, already_tuned, already_tuned_floors = await _confirmed_ledger_and_guards(
        state, cfg
    )
    proposals = [
        p for p in tuner.derive_proposals(
            prefs,
            stats,
            already_tuned=already_tuned,
            already_tuned_floors=already_tuned_floors,
        )
        if tuner.normalize_rule_id(p.rule_id) == rid
    ]
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
    pending: list = []
    try:
        for prop in proposals:
            # _handle_proposal now returns (running_prefs, pending_record); the record is
            # persisted ONLY after the prefs write is confirmed (audit #24).
            current_prefs, rec = await tuner._handle_proposal(
                prop, current_prefs, cases, cfg,
                proposals=state.proposals, audit=state.audit,
                tuning_store=state.tuning_store, writers=writers, outcome=outcome,
            )
            if rec is not None:
                pending.append((prop, rec))
    except Exception as exc:  # noqa: BLE001 — the tuner must never break the caller
        logger.warning("tuning apply for %s failed: %s", rid, exc)
        raise HTTPException(status_code=500, detail=_safe(exc)) from exc

    if outcome.persistence_errors:
        logger.warning(
            "tuning apply for %s did not confirm its approval-queue writes: %s",
            rid,
            outcome.persistence_errors,
        )
        raise HTTPException(
            status_code=503,
            detail="Tuning review work could not be confirmed; no success was reported",
        )

    # Preferences and rollback provenance are separate KV documents.  Reuse the
    # engine's compensating commit so an explicit apply cannot leave an untracked
    # threshold behind when the ledger write fails.
    if pending:
        try:
            await tuner._commit_pending_auto_changes(
                pending=pending,
                current_prefs=current_prefs,
                tuning_store=state.tuning_store,
                write_prefs=state.update_execution_prefs,
                mutate_prefs=state.mutate_execution_prefs,
                writers=writers,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("tuning apply write for %s failed: %s", rid, exc)
            raise HTTPException(
                status_code=503,
                detail="Tuning apply could not be durably recorded; no success was reported",
            ) from exc
        for prop, rec in pending:
            outcome.auto_applied.append(rec)
            await tuner._audit_tuning(state.audit, prop, rec)

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
    rid = tuner.normalize_rule_id(rule_id)
    if not rid:
        raise HTTPException(status_code=400, detail="rule_id is required")

    try:
        active = [
            r
            for r in await state.tuning_store.list_strict(
                rule_id=rid, active_only=True
            )
        ]
    except Exception as exc:  # noqa: BLE001
        logger.warning("tuning ledger read for rollback failed (%s)", exc)
        raise HTTPException(
            status_code=503,
            detail="Tuning rollback ledger is temporarily unavailable",
        ) from exc
    if not active:
        raise HTTPException(
            status_code=404, detail=f"no active tuning record for {_safe(rid)}",
        )

    # list() is newest-first — roll back the most recent active record for the rule.
    record = active[0]
    ok = await tuner.rollback(
        record.id, state.execution_prefs,
        tuning_store=state.tuning_store, write_prefs=state.update_execution_prefs,
        mutate_prefs=state.mutate_execution_prefs,
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
