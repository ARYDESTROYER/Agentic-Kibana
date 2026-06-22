"""Double-submit-cookie CSRF protection.

On state-changing methods (POST/PUT/PATCH/DELETE) this requires that the request
carry a CSRF token in BOTH a header (``X-CSRF-Token`` by default) and a cookie
(``tlsoc_csrf`` by default), and that the two match (constant-time compare). A
cross-site forgery cannot read the cookie to populate the header, so the check
fails for it — this is the classic stateless "double-submit cookie" pattern,
implemented with the standard library only (no extra deps).

Safe methods (GET/HEAD/OPTIONS/TRACE) are always allowed. Selected path prefixes
are exempt (e.g. machine ingest endpoints and the login route that mints the
cookie in the first place). The middleware is pass-through when ``enabled`` is
``False`` and never raises from its own logic.
"""

from __future__ import annotations

import hmac

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


class CSRFMiddleware(BaseHTTPMiddleware):
    """Enforce a double-submit-cookie token on unsafe HTTP methods."""

    def __init__(
        self,
        app,
        *,
        enabled: bool = False,
        exempt_prefixes: tuple[str, ...] = ("/api/ingest", "/api/auth/login"),
        cookie_name: str = "tlsoc_csrf",
        header_name: str = "X-CSRF-Token",
    ) -> None:
        super().__init__(app)
        self._enabled = bool(enabled)
        self._exempt = tuple(exempt_prefixes or ())
        self._cookie_name = cookie_name
        self._header_name = header_name

    def _is_exempt(self, path: str) -> bool:
        return any(path.startswith(prefix) for prefix in self._exempt)

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if not self._enabled:
            return await call_next(request)
        if request.method.upper() in _SAFE_METHODS:
            return await call_next(request)
        if self._is_exempt(request.url.path):
            return await call_next(request)

        header_token = request.headers.get(self._header_name, "")
        cookie_token = request.cookies.get(self._cookie_name, "")
        if (
            not header_token
            or not cookie_token
            or not hmac.compare_digest(header_token, cookie_token)
        ):
            return JSONResponse(status_code=403, content={"detail": "CSRF token invalid or missing"})
        return await call_next(request)
