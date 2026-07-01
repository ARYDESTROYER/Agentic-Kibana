"""BATCH-inference job routes — Round 4 / Wave 4 (READ-ONLY).

A SEPARATE feature router (the integrator mounts it with the same ``require_auth``
mount the monolith uses). It surfaces the durable async LLM batch-job registry
(:class:`app.stores.batch_jobs.BatchJobStore`) so an operator can see which
low-urgency investigations were routed through a provider's discounted async batch
API, and how far each has progressed (submit → poll → retrieve).

This router is READ-ONLY: it lists / gets :class:`app.models.BatchJob` rows. Submit /
poll / retrieve is driven OUT-OF-BAND by the Wave-4 batch service — not exposed here.

⚠ NON-NEGOTIABLES held here. #6: the batch service writes EXACTLY ONE ``UsageDoc`` per
result (deduped by ``custom_id`` at the 0.5× batch rate); this router only READS the
job registry — it never records a ledger row or folds a result. #3: nothing here
imports or calls ``case_manager.decide()`` — a batch job is advisory plumbing. #9:
every value returned (job id / provider / model / states) is PLAIN, attacker-
influenceable data — the UI renders it escaped; no secret is ever returned (a
``BatchJob`` carries no credential — ``provider_batch_id`` is the provider's opaque
job handle, not a key).
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from ..models import BatchJob
from ..state import AppState
from .deps import get_state, require_permission

logger = logging.getLogger("tlsoc.api.batch")

router = APIRouter(prefix="/api")


def _safe(value: Any) -> str:
    """Plain, length-bounded string for the client (#9)."""
    return str(value)[:2000]


def _job_json(job: BatchJob) -> dict[str, Any]:
    """PLAIN, secret-free JSON for one batch job (#9).

    The per-request ``custom_ids`` map is summarised to COUNTS (total / retrieved)
    rather than echoed verbatim, so a large job stays a small, bounded response and no
    case-scoped custom_id text is leaked into the body."""
    tracked = {k: v for k, v in (job.custom_ids or {}).items() if k != "__meta__"}
    retrieved = sum(1 for v in tracked.values() if isinstance(v, dict) and v.get("retrieved"))
    return {
        "id": _safe(job.id),
        "provider": _safe(job.provider),
        "provider_batch_id": _safe(job.provider_batch_id) if job.provider_batch_id else None,
        "state": _safe(getattr(job.state, "value", job.state)),
        "model": _safe(job.model),
        "discount": float(job.discount),
        "requests": len(tracked),
        "retrieved": retrieved,
        "submitted_at": _safe(job.submitted_at) if job.submitted_at else None,
        "polled_at": _safe(job.polled_at) if job.polled_at else None,
    }


# --------------------------------------------------------------------------- #
# GET /api/batch/jobs — list every tracked batch job
# --------------------------------------------------------------------------- #
@router.get("/batch/jobs")
async def list_batch_jobs(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    """List every tracked batch job (secret-free, bounded). Newest-submitted first."""
    try:
        jobs = await state.batch_job_store.list()
    except Exception as exc:  # noqa: BLE001 — the registry read is best-effort
        logger.warning("batch job list failed (%s); returning empty", exc)
        jobs = []
    rows = [_job_json(j) for j in jobs]
    # Newest first (submitted_at is ISO; None sorts last).
    rows.sort(key=lambda r: (r["submitted_at"] or ""), reverse=True)
    return {"jobs": rows, "count": len(rows)}


# --------------------------------------------------------------------------- #
# GET /api/batch/jobs/{job_id} — one job
# --------------------------------------------------------------------------- #
@router.get("/batch/jobs/{job_id}")
async def get_batch_job(
    job_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("models", "read")),
) -> dict[str, Any]:
    """One batch job by id (secret-free, bounded). 404 when unknown."""
    jid = (job_id or "").strip()
    try:
        job = await state.batch_job_store.get(jid)
    except Exception as exc:  # noqa: BLE001
        logger.warning("batch job get failed (%s)", exc)
        job = None
    if job is None:
        raise HTTPException(status_code=404, detail="batch job not found")
    return {"job": _job_json(job)}
