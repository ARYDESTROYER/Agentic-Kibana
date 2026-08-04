"""Operator-authorized control plane for supervised application updates.

The browser supplies only an exact Stable release ID plus opaque supervisor tokens
and idempotency keys.  Artifact URLs, repository coordinates, component images,
migration policy, deployment topology, backup targets, and host operations are never
accepted from the browser.  They are fixed/derived independently by the backend and
external updater supervisor.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import NoReturn

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from ..constants import ActionType
from ..engine.update_audit import audit_terminal_job
from ..engine.update_service import UpdateCapabilityError, UpdateService
from ..engine.update_supervisor import (
    SupervisorRejected,
    SupervisorUnavailable,
    UpdateJob,
    UpdatePreflight,
    UpdateReceipt,
    UpdateStatus,
)
from ..state import AppState
from .deps import (
    get_state,
    require_permission,
    require_system_update_operator,
)

logger = logging.getLogger("tlsoc.api.system_updates")

router = APIRouter(prefix="/api/system-updates", tags=["system-updates"])

_IDEMPOTENCY_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$"
_RELEASE_PATTERN = r"^v[0-9]+\.[0-9]+\.[0-9]+$"


class UpdatePreflightRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    release_id: str = Field(pattern=_RELEASE_PATTERN)
    idempotency_key: str = Field(pattern=_IDEMPOTENCY_PATTERN)


class UpdateStartRequest(UpdatePreflightRequest):
    preflight_token: str = Field(
        min_length=16, max_length=512, pattern=r"^[A-Za-z0-9_-]+$"
    )


class UpdateOperationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    idempotency_key: str = Field(pattern=_IDEMPOTENCY_PATTERN)


def _service(state: AppState) -> UpdateService:
    return UpdateService(state)


def _operator_name(operator) -> str:
    return str(getattr(operator, "username", "") or "super_admin")[:128]


def _audit_event_id(
    *, phase: str, operation: str, target: str, idempotency_key: str
) -> str:
    """Opaque deterministic audit identity for an idempotent browser operation."""
    digest = hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:32]
    return f"system-update:{phase}:{operation}:{target}:{digest}"[:512]


def _rejected_outcome(exc: Exception) -> str:
    """Return a bounded, stable rejection identity without persisting internals."""
    raw_code = str(getattr(exc, "code", "") or "")
    safe_code = re.sub(r"[^a-z0-9_]+", "_", raw_code.lower()).strip("_")[:80]
    suffix = f":{safe_code}" if safe_code else ""
    return f"rejected:{type(exc).__name__}{suffix}"


async def _audit_intent(
    state: AppState,
    *,
    actor: str,
    operation: str,
    target: str,
    idempotency_key: str,
) -> None:
    """Strict intent barrier: no supervisor mutation happens if this append fails."""
    try:
        await state.control_audit.record_strict(
            action_type=ActionType.SYSTEM_UPDATE,
            event_id=_audit_event_id(
                phase="intent",
                operation=operation,
                target=target,
                idempotency_key=idempotency_key,
            ),
            surface="system_updates",
            actor=actor,
            result_summary=f"intent operation={operation} target={target}"[:500],
        )
    except Exception as exc:  # Privileged operation fails closed.
        raise HTTPException(
            status_code=503,
            detail={
                "code": "update_audit_unavailable",
                "message": "The append-only audit trail is unavailable; no update action was sent.",
            },
        ) from exc


async def _audit_result(
    state: AppState,
    *,
    actor: str,
    operation: str,
    target: str,
    outcome: str,
    idempotency_key: str,
) -> None:
    """Strict terminal/acceptance evidence; a retry remains supervisor-idempotent."""
    try:
        await state.control_audit.record_strict(
            action_type=ActionType.SYSTEM_UPDATE,
            event_id=_audit_event_id(
                phase=f"result-{outcome}",
                operation=operation,
                target=target,
                idempotency_key=idempotency_key,
            ),
            surface="system_updates",
            actor=actor,
            result_summary=(
                f"result operation={operation} target={target} outcome={outcome}"
            )[:500],
        )
    except Exception as exc:
        raise HTTPException(
            status_code=503,
            detail={
                "code": "update_result_audit_unavailable",
                "message": (
                    "The supervisor response could not be confirmed in the audit trail. "
                    "Retry the same operation with the same idempotency key."
                ),
            },
        ) from exc


async def _audit_terminal_job(state: AppState, job: UpdateJob) -> None:
    """Persist a supervisor terminal outcome exactly once across polling/restarts."""
    try:
        await audit_terminal_job(state.control_audit, job)
    except Exception as exc:  # Completion evidence is fail-closed.
        raise HTTPException(
            status_code=503,
            detail={
                "code": "update_terminal_audit_unavailable",
                "message": (
                    "The terminal update outcome could not be confirmed in the "
                    "append-only audit trail. Retry this status request."
                ),
            },
        ) from exc


def _raise_api_error(exc: Exception) -> NoReturn:
    if isinstance(exc, UpdateCapabilityError):
        raise HTTPException(
            status_code=exc.status_code,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    if isinstance(exc, SupervisorRejected):
        status = exc.status_code if exc.status_code in {404, 409, 422, 503} else 502
        raise HTTPException(
            status_code=status,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    if isinstance(exc, (SupervisorUnavailable, ValidationError)):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "supervisor_unavailable",
                "message": "The update supervisor could not provide a valid response.",
            },
        ) from exc
    raise exc


@router.get("/status", response_model=UpdateStatus)
async def update_status(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("system_updates", "read")),
) -> UpdateStatus:
    """Capability, observed Stable metadata, and resumable supervisor job state."""
    result = await _service(state).status()
    if result.active_job is not None:
        await _audit_terminal_job(state, result.active_job)
    if result.last_job is not None and (
        result.active_job is None or result.last_job.job_id != result.active_job.job_id
    ):
        await _audit_terminal_job(state, result.last_job)
    return result


@router.post("/preflight", response_model=UpdatePreflight)
async def update_preflight(
    body: UpdatePreflightRequest,
    state: AppState = Depends(get_state),
    _permission=Depends(require_permission("system_updates", "apply")),
    operator=Depends(require_system_update_operator()),
) -> UpdatePreflight:
    actor = _operator_name(operator)
    await _audit_intent(
        state,
        actor=actor,
        operation="preflight",
        target=body.release_id,
        idempotency_key=body.idempotency_key,
    )
    try:
        result = await _service(state).preflight(
            body.release_id, idempotency_key=body.idempotency_key
        )
    except Exception as exc:  # noqa: BLE001 — curate every supervisor failure
        await _audit_result(
            state,
            actor=actor,
            operation="preflight",
            target=body.release_id,
            outcome=_rejected_outcome(exc),
            idempotency_key=body.idempotency_key,
        )
        _raise_api_error(exc)
    await _audit_result(
        state,
        actor=actor,
        operation="preflight",
        target=body.release_id,
        outcome="accepted",
        idempotency_key=body.idempotency_key,
    )
    return result


@router.post("/jobs", response_model=UpdateJob, status_code=202)
async def start_update(
    body: UpdateStartRequest,
    state: AppState = Depends(get_state),
    _permission=Depends(require_permission("system_updates", "apply")),
    operator=Depends(require_system_update_operator()),
) -> UpdateJob:
    actor = _operator_name(operator)
    await _audit_intent(
        state,
        actor=actor,
        operation="start",
        target=body.release_id,
        idempotency_key=body.idempotency_key,
    )
    try:
        result = await _service(state).start(
            body.release_id,
            preflight_token=body.preflight_token,
            idempotency_key=body.idempotency_key,
        )
    except Exception as exc:  # noqa: BLE001
        await _audit_result(
            state,
            actor=actor,
            operation="start",
            target=body.release_id,
            outcome=_rejected_outcome(exc),
            idempotency_key=body.idempotency_key,
        )
        _raise_api_error(exc)
    await _audit_result(
        state,
        actor=actor,
        operation="start",
        target=body.release_id,
        outcome=f"accepted:{result.job_id}:{result.status}",
        idempotency_key=body.idempotency_key,
    )
    return result


@router.get("/jobs/{job_id}", response_model=UpdateJob)
async def get_update_job(
    job_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("system_updates", "read")),
) -> UpdateJob:
    try:
        result = await _service(state).job(job_id)
        await _audit_terminal_job(state, result)
        return result
    except Exception as exc:  # noqa: BLE001
        _raise_api_error(exc)


@router.get("/jobs/{job_id}/receipt", response_model=UpdateReceipt)
async def get_update_receipt(
    job_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("system_updates", "read")),
) -> UpdateReceipt:
    try:
        result = await _service(state).receipt(job_id)
        job = await _service(state).job(job_id)
        await _audit_terminal_job(state, job)
        return result
    except Exception as exc:  # noqa: BLE001
        _raise_api_error(exc)


async def _job_operation(
    *,
    operation: str,
    job_id: str,
    idempotency_key: str,
    actor: str,
    state: AppState,
) -> UpdateJob:
    await _audit_intent(
        state,
        actor=actor,
        operation=operation,
        target=job_id,
        idempotency_key=idempotency_key,
    )
    try:
        service = _service(state)
        result = (
            await service.cancel(job_id, idempotency_key=idempotency_key)
            if operation == "cancel"
            else await service.rollback(job_id, idempotency_key=idempotency_key)
        )
    except Exception as exc:  # noqa: BLE001
        await _audit_result(
            state,
            actor=actor,
            operation=operation,
            target=job_id,
            outcome=_rejected_outcome(exc),
            idempotency_key=idempotency_key,
        )
        _raise_api_error(exc)
    await _audit_result(
        state,
        actor=actor,
        operation=operation,
        target=job_id,
        outcome=f"accepted:{result.status}",
        idempotency_key=idempotency_key,
    )
    await _audit_terminal_job(state, result)
    return result


@router.post("/jobs/{job_id}/cancel", response_model=UpdateJob)
async def cancel_update_job(
    job_id: str,
    body: UpdateOperationRequest,
    state: AppState = Depends(get_state),
    _permission=Depends(require_permission("system_updates", "apply")),
    operator=Depends(require_system_update_operator()),
) -> UpdateJob:
    return await _job_operation(
        operation="cancel",
        job_id=job_id,
        idempotency_key=body.idempotency_key,
        actor=_operator_name(operator),
        state=state,
    )


@router.post("/jobs/{job_id}/rollback", response_model=UpdateJob)
async def rollback_update_job(
    job_id: str,
    body: UpdateOperationRequest,
    state: AppState = Depends(get_state),
    _permission=Depends(require_permission("system_updates", "rollback")),
    operator=Depends(require_system_update_operator()),
) -> UpdateJob:
    return await _job_operation(
        operation="rollback",
        job_id=job_id,
        idempotency_key=body.idempotency_key,
        actor=_operator_name(operator),
        state=state,
    )
