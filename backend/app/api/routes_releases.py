"""Authenticated, read-only public upstream release discovery.

These endpoints expose only VERSION and branch-head metadata for the operator's
strictly validated public GitHub repository.  They do not download release artifacts
and cannot clone, pull, execute, deploy, migrate, restart, promote, activate, or roll
back the application.  The browser's separate same-origin deployed-release contract
remains the only activation affordance.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ..engine.release_discovery import ReleaseDiscoveryResponse
from ..state import AppState
from .deps import get_state, require_permission

router = APIRouter(prefix="/api", tags=["releases"])


@router.get("/releases/upstream", response_model=ReleaseDiscoveryResponse)
async def upstream_releases(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> ReleaseDiscoveryResponse:
    """Return cached metadata and refresh only when the configured TTL expires."""
    return await state.release_discovery.discover(state.prefs.release_updates)


@router.post("/releases/upstream/check", response_model=ReleaseDiscoveryResponse)
async def check_upstream_releases(
    state: AppState = Depends(get_state),
    _=Depends(require_permission("settings", "read")),
) -> ReleaseDiscoveryResponse:
    """Request a refresh, still respecting the anti-hammering manual cooldown."""
    return await state.release_discovery.discover(state.prefs.release_updates, force=True)
