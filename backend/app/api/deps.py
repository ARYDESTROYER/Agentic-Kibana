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
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    user = auth.verify(token) if token else None
    if user is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return user
