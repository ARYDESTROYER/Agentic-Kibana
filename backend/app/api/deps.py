"""Request dependencies: access to the singleton AppState + the auth gate."""

from __future__ import annotations

import posixpath
import re

from fastapi import HTTPException, Request

from ..state import AppState

# Routes reachable WITHOUT a session even when auth is enabled. Kept deliberately
# tiny (deny-by-default). Matched against the NORMALISED path (so `//`, `.`, `..`
# tricks can't smuggle a protected route past the allowlist).
PUBLIC_API_PATHS = frozenset(
    {"/api/health", "/api/auth/login", "/api/auth/logout", "/api/auth/me"}
)
# Public for GET ONLY (read-only, non-sensitive) — e.g. branding so the login
# screen can render the org logo before a session exists. Writes stay protected.
PUBLIC_GET_PATHS = frozenset({"/api/branding"})
# The inbound ingest receivers self-authenticate (bearer / HMAC inside the
# receiver). Allow ONLY the exact one-segment receiver route shape — not a loose
# prefix — so a future nested route under /api/ingest can't be made public by
# accident. (Also guarded by test_route_auth_coverage.)
_PUBLIC_INGEST_RE = re.compile(r"^/api/ingest/[^/]+$")


def get_state(request: Request) -> AppState:
    state: AppState | None = getattr(request.app.state, "tlsoc", None)
    if state is None:  # pragma: no cover - only before startup
        raise RuntimeError("AppState not initialised")
    return state


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip() or None
    return None


async def require_auth(request: Request):
    """Auth gate applied to the whole /api router.

    A strict NO-OP when auth is disabled (the default — the "old version" without
    auth). When enabled, every /api route requires a valid JWT (cookie ``tlsoc_token``
    or ``Authorization: Bearer``) EXCEPT the small public allowlist; otherwise 401.
    Deny-by-default: a new route is protected automatically (verified by the CI
    route-coverage test)."""
    state = get_state(request)
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return None
    # Normalise before matching so `/api//health`, `/api/x/../health`, trailing
    # slashes, etc. cannot bypass (or be mistaken for) the public allowlist.
    path = posixpath.normpath(request.url.path)
    if path in PUBLIC_API_PATHS or _PUBLIC_INGEST_RE.match(path):
        return None
    if request.method == "GET" and path in PUBLIC_GET_PATHS:
        return None
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    user = auth.verify(token) if token else None
    if user is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return user


def current_username(request: Request) -> str:
    """Best-effort username of the requester (``""`` when auth is disabled — the
    default no-auth profile). Used to attribute proposal approve/reject decisions."""
    state = get_state(request)
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return ""
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    user = auth.verify(token) if token else None
    return user.username if user else ""


async def require_admin(request: Request):
    """RBAC seam — the SINGLE enforcement point for privileged actions (today:
    approving / rejecting an agent proposal, which writes a LIVE suppression rule or
    a memory fact).

    Roles do not exist on :class:`app.auth.service.AuthUser` yet (it carries only a
    username), so this resolves the caller's role and — for now — DEFAULTS TO ALLOW
    once they are authenticated under the active auth mode. Wiring real roles is a
    ONE-LINE change here, NOT scattered through the routes.

    # TODO(RBAC): enforce admin once roles land — see
    # docs/research/CUSTOMIZATION_AND_RBAC.md. When AuthUser gains `role`, replace
    # the default-allow below with `if role != "admin": raise HTTPException(403)`.
    """
    # Reuse the auth gate: when auth is ON this 401s an unauthenticated caller; when
    # auth is OFF (default) it is a no-op (the whole suite is open in that profile).
    user = await require_auth(request)
    role = getattr(user, "role", None) if user is not None else None
    # Default-allow until roles exist — but the seam (this function) is the obvious,
    # single place to flip to deny-by-default. Never silently unguarded: every
    # approve/reject route depends on THIS function.
    _ = role  # noqa: F841 — placeholder until AuthUser.role lands
    return user
