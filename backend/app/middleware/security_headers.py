"""Response security-headers middleware.

Adds a conservative set of hardening headers to every response. Each header is
individually toggleable via the constructor (all default ``True``) so a deployment
can relax any single one without re-rolling the others. The
``Strict-Transport-Security`` header is only emitted when the request arrived over
HTTPS (detected via the ``X-Forwarded-Proto`` header set by a TLS-terminating
proxy, or the request URL scheme), since HSTS over plain HTTP is meaningless and
can break local/dev access.
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

_DEFAULT_CSP = "default-src 'self'; frame-ancestors 'none'; object-src 'none'"
_DEFAULT_HSTS = "max-age=31536000; includeSubDomains"


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Attach hardening headers to responses; each header is toggleable."""

    def __init__(
        self,
        app,
        *,
        content_security_policy: bool = True,
        content_type_options: bool = True,
        frame_options: bool = True,
        referrer_policy: bool = True,
        hsts: bool = True,
        csp_value: str = _DEFAULT_CSP,
        hsts_value: str = _DEFAULT_HSTS,
    ) -> None:
        super().__init__(app)
        self._csp = content_security_policy
        self._cto = content_type_options
        self._frame = frame_options
        self._referrer = referrer_policy
        self._hsts = hsts
        self._csp_value = csp_value
        self._hsts_value = hsts_value

    @staticmethod
    def _is_https(request: Request) -> bool:
        forwarded = request.headers.get("x-forwarded-proto", "")
        if forwarded:
            # May be a comma-list (proxy chain); the first hop is the client-facing one.
            return forwarded.split(",")[0].strip().lower() == "https"
        return request.url.scheme == "https"

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        response = await call_next(request)
        headers = response.headers
        if self._csp:
            headers.setdefault("Content-Security-Policy", self._csp_value)
        if self._cto:
            headers.setdefault("X-Content-Type-Options", "nosniff")
        if self._frame:
            headers.setdefault("X-Frame-Options", "DENY")
        if self._referrer:
            headers.setdefault("Referrer-Policy", "no-referrer")
        if self._hsts and self._is_https(request):
            headers.setdefault("Strict-Transport-Security", self._hsts_value)
        return response
