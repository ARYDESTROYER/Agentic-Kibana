"""Request dependencies: access to the singleton AppState."""

from __future__ import annotations

from fastapi import Request

from ..state import AppState


def get_state(request: Request) -> AppState:
    state: AppState | None = getattr(request.app.state, "tlsoc", None)
    if state is None:  # pragma: no cover - only before startup
        raise RuntimeError("AppState not initialised")
    return state
