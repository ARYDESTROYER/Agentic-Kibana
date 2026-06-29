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
        "/api/setup/status", "/api/setup/init-admin",
        # Wave 2 — each guarded by a single-use token/state, not a session.
        "/api/auth/mfa/verify",
        "/api/auth/sso/providers", "/api/auth/sso/authorize", "/api/auth/sso/callback",
        # Wave 3 — refresh is self-authenticating via the opaque refresh token (the
        # access token may have expired); guarded by the refresh-hash match + reuse
        # detection, not a session.
        "/api/auth/refresh",
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


def test_wave1_identity_routes_are_registered() -> None:
    # The Wave-1 OOBE / multi-user / RBAC routes exist on the real app (so the
    # coverage walk above actually guards them).
    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    for expected in (
        "/api/setup/init-admin",
        "/api/auth/change-password",
        "/api/roles",
        "/api/users",
        "/api/users/{username}",
    ):
        assert expected in paths, f"missing Wave-1 identity route {expected}"


def test_wave1_public_paths_present_in_allowlist() -> None:
    # The two new OOBE public paths are in the allowlist (reachable pre-session).
    assert "/api/setup/status" in PUBLIC_API_PATHS
    assert "/api/setup/init-admin" in PUBLIC_API_PATHS
    # ...and the user-management routes are NOT public (deny-by-default).
    assert "/api/users" not in PUBLIC_API_PATHS
    assert "/api/roles" not in PUBLIC_API_PATHS
    assert "/api/auth/change-password" not in PUBLIC_API_PATHS


def test_wave3_session_routes_registered_and_not_public() -> None:
    # The Wave-3 session/access-policy routes exist on the real app (so the coverage
    # walk guards them). All require a live session EXCEPT /auth/refresh, which is
    # self-authenticating via the opaque refresh token (so it is in the allowlist).
    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    session_gated = (
        "/api/sessions",
        "/api/sessions/{sid}/revoke",
        "/api/sessions/revoke-others",
        "/api/auth/reauth",
        "/api/account/activity",
        "/api/admin/sessions",
        "/api/admin/sessions/{sid}/revoke",
        "/api/admin/users/{username}/revoke-all",
    )
    for expected in session_gated:
        assert expected in paths, f"missing Wave-3 session route {expected}"
        assert expected not in PUBLIC_API_PATHS, f"{expected} must NOT be public"
    # Refresh exists + IS public (guarded by the refresh-token match, not a session).
    assert "/api/auth/refresh" in paths
    assert "/api/auth/refresh" in PUBLIC_API_PATHS
