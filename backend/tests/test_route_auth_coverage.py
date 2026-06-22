"""CI guard: deny-by-default auth coverage.

Walks the REAL application (``app.main.app``, which mounts the auth gate on the
whole /api router) and asserts that every ``/api`` route is covered by the
``require_auth`` dependency, OR is one of the small explicitly-public paths. Adding
a new unauthenticated /api route fails this test — auth can't be silently skipped.
"""

from __future__ import annotations

from fastapi.routing import APIRoute
from starlette.routing import Mount, WebSocketRoute

from app.api.deps import (
    _PUBLIC_INGEST_RE,
    PUBLIC_API_PATHS,
    PUBLIC_GET_PATHS,
    require_auth,
)
from app.main import app


def _dependant_calls(dependant) -> set:
    calls = set()
    for dep in dependant.dependencies:
        if dep.call is not None:
            calls.add(dep.call)
        calls |= _dependant_calls(dep)
    return calls


def test_every_api_route_is_auth_covered() -> None:
    api_routes = [
        r for r in app.routes
        if isinstance(r, APIRoute) and r.path.startswith("/api")
    ]
    assert api_routes, "expected /api routes to be registered"
    uncovered: list[str] = []
    for route in api_routes:
        if require_auth in _dependant_calls(route.dependant):
            continue
        if route.path in PUBLIC_API_PATHS:
            continue
        uncovered.append(f"{sorted(route.methods)} {route.path}")
    assert not uncovered, (
        "these /api routes are neither auth-covered nor in PUBLIC_API_PATHS: "
        + ", ".join(uncovered)
    )


def test_public_paths_are_minimal_and_known() -> None:
    # A small, deliberate allowlist — guard against accidental growth.
    assert PUBLIC_API_PATHS <= {
        "/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me",
    }
    # GET-only public paths (read-only, non-sensitive) — also guarded.
    assert PUBLIC_GET_PATHS <= {"/api/branding"}


def test_no_unprotectable_routes_under_api() -> None:
    # Mounts / WebSocket routes under /api would bypass the route-level auth
    # dependency entirely — assert none exist (the gate only covers APIRoutes).
    bad = [
        getattr(r, "path", "?")
        for r in app.routes
        if isinstance(r, (Mount, WebSocketRoute)) and getattr(r, "path", "").startswith("/api")
    ]
    assert not bad, f"unprotectable mounts/ws under /api: {bad}"


def test_ingest_public_path_is_tight() -> None:
    # The receiver self-auth allowance must match ONLY the one-segment receiver
    # route — not a nested route that could be made public by accident.
    assert _PUBLIC_INGEST_RE.match("/api/ingest/my-source")
    assert not _PUBLIC_INGEST_RE.match("/api/ingest/my-source/config")
    assert not _PUBLIC_INGEST_RE.match("/api/ingestion-status")
    assert not _PUBLIC_INGEST_RE.match("/api/ingest/")
