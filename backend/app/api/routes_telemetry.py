"""Read-only, evidence-qualified telemetry improvement recommendations."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from ..engine.telemetry_recommendations import TELEMETRY_GAP_SCHEMA, recommend_sources
from ..state import AppState
from .deps import get_state, require_permission

router = APIRouter(prefix="/api")


@router.get("/tuning/source-recommendations")
async def source_recommendations(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("cases", "read")),
) -> dict[str, Any]:
    """Recommend sources only after stored query evidence proves a telemetry gap."""
    cases = []
    offset = 0
    page_size = 500
    max_cases = 20_000
    while len(cases) < max_cases:
        page, total = await state.cases.list(limit=page_size, offset=offset)
        if not page:
            break
        cases.extend(page[: max_cases - len(cases)])
        offset += len(page)
        if offset >= total or len(page) < page_size:
            break
    rows = recommend_sources(cases)
    return {
        "status": "available" if rows else "not_available",
        "recommendations": rows,
        "scanned_cases": len(cases),
        "truncated": len(cases) >= max_cases,
        "evidence_schema": TELEMETRY_GAP_SCHEMA,
        "not_available_reason": (
            "No query-backed telemetry gap has been recorded. Missing connector configuration alone is not evidence."
            if not rows
            else ""
        ),
    }

