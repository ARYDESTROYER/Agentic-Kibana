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
    _=Depends(require_permission("automation", "read")),
) -> dict[str, Any]:
    """Enabled/gated/runtime status plus truthful last attempt/success/error.

    This is part of the continuous-improvement operator surface, so it deliberately
    shares the same ``automation:read`` grant as the Auto-tuning page that consumes
    it.  Keeping this route behind ``settings:read`` made the page silently lose its
    worker-health evidence for otherwise-authorized tuning operators.
    """
    return await state.scheduler_health()
