"""Operator health for continuous-improvement background workers."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..state import AppState
from .deps import get_state, require_permission

router = APIRouter(prefix="/api")


@router.get("/schedulers/health")
async def scheduler_health(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> dict[str, Any]:
    """Enabled/gated/runtime status plus truthful last attempt/success/error."""
    return await state.scheduler_health()

