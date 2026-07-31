"""Capability-aware storage lifecycle for Agentic SOC's OWN state.

The routes separate *desired policy* from *effective provider state*.  Saving a
policy never changes infrastructure.  Preview is side-effect free.  Apply is an
explicit, fresh-authenticated management action and can only touch the allow-listed
append-only audit and usage ledgers on the Elasticsearch state backend.

Connected source indices are never in scope: the product remains their read-only
consumer.  Glacier is reported as a desired independent archive hand-off until a
checksummed export/restore pipeline is configured; this API never modifies an
Elasticsearch snapshot repository and never deletes records.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from ..config import StorageLifecycleConfig
from ..constants import ActionType
from ..engine.storage_lifecycle import (
    apply_elasticsearch_lifecycle,
    lifecycle_preview,
    lifecycle_status,
)
from ..state import AppState
from .deps import (
    current_username,
    get_state,
    require_fresh_auth,
    require_permission,
)

logger = logging.getLogger("tlsoc.api.storage")

router = APIRouter(prefix="/api", tags=["storage"])


def _backend(state: AppState) -> str:
    configured = str(
        getattr(state.secrets, "state_backend", "elasticsearch") or "elasticsearch"
    )
    if configured == "elasticsearch":
        return str(
            getattr(state.es, "storage_lifecycle_backend", "elasticsearch")
            or "elasticsearch"
        )
    return configured


def _state_es(state: AppState):
    return state.es if _backend(state) == "elasticsearch" else None


async def _status(state: AppState) -> dict[str, Any]:
    return await lifecycle_status(
        state_backend=_backend(state),
        config=state.prefs.storage_lifecycle,
        es=_state_es(state),
    )


@router.get("/storage/lifecycle")
async def storage_lifecycle_get(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> dict[str, Any]:
    """Return desired policy, effective capability, blockers, and safe scope."""
    return await _status(state)


@router.put("/storage/lifecycle")
async def storage_lifecycle_put(
    body: StorageLifecycleConfig,
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "manage")),
) -> dict[str, Any]:
    """Save desired policy only; never change infrastructure implicitly."""
    if state.prefs.read_only_settings_mode:
        raise HTTPException(status_code=403, detail="settings are read-only")
    await state.mutate_prefs(
        lambda prefs: prefs.model_copy(update={"storage_lifecycle": body})
    )
    try:
        await state.control_audit.record(
            action_type=ActionType.STATUS,
            surface="storage",
            actor=current_username(request) or "admin",
            result_summary=(
                "saved own-state lifecycle policy "
                f"hot={body.hot_days}d warm={body.warm_days}d "
                f"archive_from={body.archive_from_days}d delete=off"
            ),
        )
    except Exception:  # noqa: BLE001 — mirrors the general settings save path
        logger.warning("Could not audit storage lifecycle policy save", exc_info=True)
    return await _status(state)


@router.post("/storage/lifecycle/preview")
async def storage_lifecycle_preview(
    body: StorageLifecycleConfig | None = Body(default=None),
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "manage")),
) -> dict[str, Any]:
    """Preview a candidate plan. This endpoint performs reads only."""
    return await lifecycle_preview(
        state_backend=_backend(state),
        config=body or state.prefs.storage_lifecycle,
        es=_state_es(state),
    )


@router.post("/storage/lifecycle/apply")
async def storage_lifecycle_apply(
    request: Request,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "manage")),
    _fresh=Depends(require_fresh_auth()),
) -> dict[str, Any]:
    """Explicitly apply the persisted policy to supported owned-state targets."""
    if state.prefs.read_only_settings_mode:
        raise HTTPException(status_code=403, detail="settings are read-only")

    actor = current_username(request) or "admin"
    # Record intent before the provider mutation. If append-only audit is unavailable,
    # fail closed rather than perform an untracked control-plane change.
    try:
        await state.control_audit.record(
            action_type=ActionType.STATUS,
            surface="storage",
            actor=actor,
            result_summary="requested own-state lifecycle apply",
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(
            status_code=500,
            detail="could not record the lifecycle apply audit; apply aborted",
        ) from exc

    if _backend(state) != "elasticsearch":
        status = await _status(state)
        execution = {
            "applied": False,
            "state": "advisory",
            "managed_targets": [],
            "reason": (
                "Native lifecycle apply is currently available only for the "
                "Elasticsearch own-state backend."
            ),
        }
    else:
        try:
            execution = await apply_elasticsearch_lifecycle(
                state.es, state.prefs.storage_lifecycle
            )
        except Exception as exc:  # noqa: BLE001
            try:
                await state.control_audit.record(
                    action_type=ActionType.ERROR,
                    surface="storage",
                    actor=actor,
                    result_summary=f"own-state lifecycle apply failed: {type(exc).__name__}",
                )
            except Exception:  # noqa: BLE001
                pass
            raise HTTPException(
                status_code=502,
                detail="storage provider rejected the lifecycle apply",
            ) from exc
        status = await _status(state)

    try:
        await state.control_audit.record(
            action_type=ActionType.STATUS,
            surface="storage",
            actor=actor,
            result_summary=(
                f"own-state lifecycle apply state={execution.get('state')} "
                f"targets={','.join(execution.get('managed_targets') or []) or 'none'}"
            )[:500],
        )
    except Exception:  # noqa: BLE001 — intent is already durable; report remains truthful
        logger.warning("Could not record storage lifecycle apply result", exc_info=True)
    return {"execution": execution, "status": status}
