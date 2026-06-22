"""In-process per-client-IP token-bucket rate limiting.

A dependency-free rate limiter (no Redis, no ``slowapi``): each client IP gets a
token bucket that refills continuously at ``refill_per_second`` up to ``capacity``.
Each request consumes one token; when the bucket is empty the request is rejected
with ``429``. This is per-process (good enough for a single backend instance or as
a coarse first line of defence behind a proxy); for multi-replica global limits a
shared store would be needed, which we deliberately avoid here to keep zero deps.

The limiter is graceful: it never raises from its own logic, and when ``enabled``
is ``False`` it is a pure pass-through.
"""

from __future__ import annotations

import threading
import time

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import JSONResponse, Response


class _TokenBucket:
    __slots__ = ("tokens", "last")

    def __init__(self, tokens: float, last: float) -> None:
        self.tokens = tokens
        self.last = last


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Reject requests from an IP that exceeds its token-bucket allowance."""

    def __init__(
        self,
        app,
        *,
        capacity: int = 120,
        refill_per_second: float = 2.0,
        enabled: bool = True,
        trust_forwarded_for: bool = False,
    ) -> None:
        super().__init__(app)
        self._capacity = float(max(1, capacity))
        self._refill = float(max(0.0, refill_per_second))
        self._enabled = bool(enabled)
        # Only honour X-Forwarded-For when explicitly behind a trusted proxy — an
        # untrusted client can otherwise spoof it to rotate buckets and bypass the
        # limit (or, with no XFF, collapse all clients onto one proxy IP).
        self._trust_xff = bool(trust_forwarded_for)
        self._buckets: dict[str, _TokenBucket] = {}
        self._lock = threading.Lock()

    def _client_ip(self, request: Request) -> str:
        if self._trust_xff:
            forwarded = request.headers.get("x-forwarded-for", "")
            if forwarded:
                return forwarded.split(",")[0].strip()
        client = request.client
        return client.host if client else "unknown"

    def _allow(self, key: str) -> bool:
        now = time.monotonic()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _TokenBucket(tokens=self._capacity, last=now)
                self._buckets[key] = bucket
            elapsed = max(0.0, now - bucket.last)
            bucket.tokens = min(self._capacity, bucket.tokens + elapsed * self._refill)
            bucket.last = now
            if bucket.tokens >= 1.0:
                bucket.tokens -= 1.0
                return True
            return False

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        if not self._enabled:
            return await call_next(request)
        try:
            allowed = self._allow(self._client_ip(request))
        except Exception:  # pragma: no cover - never let limiter logic break a request
            return await call_next(request)
        if not allowed:
            return JSONResponse(status_code=429, content={"detail": "rate limit exceeded"})
        return await call_next(request)
