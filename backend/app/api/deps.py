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
    {
        "/api/health",
        "/api/auth/login",
        "/api/auth/logout",
        "/api/auth/me",
        # OOBE first-run: status is needed to render the login/setup screen before a
        # session exists; init-admin is the ONLY way to create the first user and is
        # itself guarded (it 409s once any user exists).
        "/api/setup/status",
        "/api/setup/init-admin",
        # Wave 2 — login-phase-2 + SSO bootstrap. Each is itself guarded by a
        # single-use token/state (NOT a full session), so they are reachable before a
        # session exists WITHOUT weakening deny-by-default:
        #   * mfa/verify   — gated by the short-lived pending_token (mfa:"pending").
        #   * sso/providers — read-only list of ENABLED providers (no secrets).
        #   * sso/authorize — builds the IdP redirect (stashes single-use state/nonce).
        #   * sso/callback  — validates state, exchanges the code server-side.
        "/api/auth/mfa/verify",
        "/api/auth/sso/providers",
        "/api/auth/sso/authorize",
        "/api/auth/sso/callback",
    }
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


def current_user(request: Request):
    """The authenticated :class:`app.auth.service.AuthUser` for this request, or
    ``None`` when auth is disabled OR no valid session is presented. Best-effort:
    never raises (use :func:`require_auth` / :func:`require_permission` to ENFORCE).
    Carries ``role`` + ``must_change_password`` for callers that want to branch on
    the principal without gating."""
    state = get_state(request)
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return None
    token = request.cookies.get("tlsoc_token") or _bearer(request)
    return auth.verify(token) if token else None


def current_username(request: Request) -> str:
    """Best-effort username of the requester (``""`` when auth is disabled — the
    default no-auth profile). Used to attribute proposal approve/reject decisions."""
    user = current_user(request)
    return user.username if user else ""


def _rbac_enabled(state: AppState) -> bool:
    rbac = getattr(state.prefs, "rbac", None)
    return bool(getattr(rbac, "enabled", False))


async def _enforce(request: Request, resource: str, action: str):
    """Shared RBAC enforcement core. Three modes (see rbac/policy.py):

    * auth DISABLED        → allow (no-op; the no-auth "old version" default).
    * auth ON, rbac OFF    → authenticated users are treated as super_admin → allow.
    * auth ON, rbac ON     → consult ``rbac.policy.can(role, resource, action)``;
                              deny (403) when the role lacks the grant.

    Always runs the auth gate first (401s an unauthenticated caller when auth is on)."""
    user = await require_auth(request)
    state = get_state(request)
    auth = getattr(state, "auth", None)
    if auth is None or not auth.is_enabled:
        return user  # auth off → everything allowed
    if not _rbac_enabled(state):
        return user  # rbac off → authenticated == super_admin
    from ..rbac.policy import can

    role = getattr(user, "role", "") or ""
    if can(role, resource, action, getattr(state.prefs, "rbac", None)):
        return user
    # Append-only audit of the denial (#2) — best-effort, never blocks the 403.
    try:
        from ..constants import ActionType

        await state.audit.record(
            action_type=ActionType.ACCESS_DENIED,
            surface="rbac",
            actor=getattr(user, "username", "") or "",
            result_summary=f"denied {resource}:{action} for role {role or '?'}",
        )
    except Exception:  # noqa: BLE001
        pass
    raise HTTPException(status_code=403, detail=f"permission denied: {resource}:{action}")


def require_permission(resource: str, action: str):
    """FastAPI dependency factory: gate a route on a single ``resource:action``
    grant. Usage: ``_=Depends(require_permission("sources", "manage"))``."""

    async def _dep(request: Request):
        return await _enforce(request, resource, action)

    return _dep


def require_role(*roles: str):
    """FastAPI dependency factory: gate a route on the caller holding one of
    ``roles`` (by value). ``super_admin`` always passes. A strict no-op when auth is
    off; when auth is on but RBAC is off, an authenticated caller (treated as
    super_admin) passes."""
    wanted = {str(getattr(r, "value", r)) for r in roles}

    async def _dep(request: Request):
        user = await require_auth(request)
        state = get_state(request)
        auth = getattr(state, "auth", None)
        if auth is None or not auth.is_enabled:
            return user
        if not _rbac_enabled(state):
            return user
        from ..constants import UserRole

        role = getattr(user, "role", "") or ""
        if role == UserRole.SUPER_ADMIN.value or role in wanted:
            return user
        raise HTTPException(status_code=403, detail="permission denied: role")

    return _dep


# ``require_admin`` is retained for back-compat (the proposal approve/reject routes
# depend on it) but now ENFORCES the ``users:manage`` permission — the privileged
# administrative grant — instead of defaulting to allow. Same three-mode semantics
# as the other gates (no-op when auth off; super_admin when rbac off).
async def require_admin(request: Request):
    """Privileged-action gate — now backed by the ``users:manage`` permission.

    Historically a default-allow seam; with roles landed it enforces the
    administrative grant. Every approve/reject route still depends on THIS function,
    so privileged actions are gated in exactly one place."""
    return await _enforce(request, "users", "manage")
