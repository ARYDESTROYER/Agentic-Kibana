"""Resend email channel (Wave 7) — over the repo's existing ``httpx`` (_HttpChannel).

Resend (https://resend.com) is an HTTPS-API transactional email provider. Unlike the
SMTP :class:`app.notifications.email.EmailChannel`, this channel POSTs the rendered
``{from,to,subject,html,text}`` to ``POST https://api.resend.com/emails`` with a
``Authorization: Bearer <api-key>`` header. The API key is the per-channel SECRET
(``self._secret``), resolved at send time (#10) — never persisted, never echoed in a
:class:`SendResult` (the audited ``detail`` carries only a status code / the returned
message id, never the key).

ZERO new deps: it reuses ``_HttpChannel``'s injectable async poster (``self._poster``)
and the same ``(status_code, text)`` contract the other HTTP channels use, so offline
tests inject a stub and no network is touched.

Safety (#3): ``send`` is fully error-isolated → :class:`SendResult` and NEVER raises,
so a delivery failure can never block or alter a case decision. The body is the
already-rendered, UNTRUSTED-safe HTML+text from :mod:`templates`; this channel only
adds the envelope (from/to/subject) and delivers verbatim — it never re-injects a raw
case field. Retries are bounded and apply ONLY to transient 429/5xx (NOT to 4xx
config/quota errors, which would just burn the budget); a small client-side
token-bucket caps the outbound rate.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Awaitable, Callable

from .channel import NotificationEvent, SendResult, register_channel
from .webhook import _HttpChannel

logger = logging.getLogger("tlsoc.notifications.resend")

_ENDPOINT = "https://api.resend.com/emails"
_USER_AGENT = "tlsoc-agentic-triage/notify (+resend)"

# Bounded transient-retry policy (NEVER on a 4xx config/quota error).
_MAX_ATTEMPTS = 3
_RETRY_STATUS = {429, 500, 502, 503, 504}
_DEFAULT_BACKOFF = 0.5  # seconds; multiplied by attempt, capped, honoring retry-after

# A tiny injectable sleeper so tests don't actually wait.
Sleeper = Callable[[float], Awaitable[None]]


class _TokenBucket:
    """A minimal client-side token bucket (~rate tokens/sec, small burst) so a flood
    of triggers can't exceed Resend's per-team request budget. Process-local; best
    effort — it never blocks longer than the configured rate, never raises."""

    __slots__ = ("rate", "capacity", "_tokens", "_ts")

    def __init__(self, rate: float = 4.0, capacity: float = 5.0) -> None:
        self.rate = max(0.1, float(rate))
        self.capacity = max(1.0, float(capacity))
        self._tokens = self.capacity
        self._ts = time.monotonic()

    def take(self) -> float:
        """Consume one token; return the seconds the caller SHOULD wait before the
        token is available (0.0 when one is available now)."""
        now = time.monotonic()
        self._tokens = min(self.capacity, self._tokens + (now - self._ts) * self.rate)
        self._ts = now
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return 0.0
        deficit = 1.0 - self._tokens
        self._tokens = 0.0
        return deficit / self.rate


# One shared bucket per process (Resend's default is ~5 rps per team).
_BUCKET = _TokenBucket(rate=4.0, capacity=5.0)


@register_channel
class ResendChannel(_HttpChannel):
    """Resend HTTPS-API email channel. The per-channel SECRET is the Resend API key."""

    type = "resend"

    def __init__(
        self,
        config: dict[str, Any],
        secret: str = "",
        *,
        poster: Any = None,
        sleeper: Sleeper | None = None,
        bucket: _TokenBucket | None = None,
    ) -> None:
        super().__init__(config, secret, poster=poster)
        self._sleep: Sleeper = sleeper or asyncio.sleep
        self._bucket = bucket or _BUCKET

    def _recipients(self) -> list[str]:
        raw = self._config.get("recipients") or self._config.get("to") or []
        if isinstance(raw, str):
            raw = [r.strip() for r in raw.replace(";", ",").split(",")]
        return [str(r).strip() for r in raw if str(r).strip()]

    @staticmethod
    def _retry_after(text: str) -> float | None:
        """Best-effort retry-after hint from a JSON error body (the poster contract
        does not surface response headers). Returns seconds or None."""
        try:
            doc = json.loads(text or "{}")
        except Exception:  # noqa: BLE001
            return None
        for key in ("retry_after", "retryAfter", "retry-after"):
            val = doc.get(key) if isinstance(doc, dict) else None
            if isinstance(val, (int, float)) and val >= 0:
                return min(float(val), 30.0)
        return None

    async def send(self, event: NotificationEvent) -> SendResult:
        try:
            api_key = (self._secret or str(self._config.get("api_key") or "")).strip()
            from_addr = str(self._config.get("from_addr") or self._config.get("from") or "").strip()
            recipients = self._recipients()
            if not api_key:
                return SendResult(ok=False, detail="resend channel has no API key configured")
            if not from_addr:
                return SendResult(ok=False, detail="resend channel has no from address configured")
            if not recipients:
                return SendResult(ok=False, detail="resend channel has no recipients configured")

            case_id = str((event.meta or {}).get("case_id") or "")
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "User-Agent": _USER_AGENT,
            }
            # An idempotency key keeps a retried/duplicated send from double-delivering.
            if case_id:
                headers["Idempotency-Key"] = f"case-notify/{case_id}/{event.trigger}"[:255]
            payload: dict[str, Any] = {
                "from": from_addr,
                "to": recipients,
                "subject": event.subject,
                "html": event.html,
                "text": event.text,
            }
            reply_to = str(self._config.get("reply_to") or "").strip()
            if reply_to:
                payload["reply_to"] = reply_to

            # Client-side rate cap (never blocks beyond the bucket's small wait).
            wait = self._bucket.take()
            if wait > 0:
                await self._sleep(min(wait, 2.0))

            status = 0
            text = ""
            for attempt in range(1, _MAX_ATTEMPTS + 1):
                try:
                    status, text = await self._poster(_ENDPOINT, json=payload, headers=headers)
                except Exception as exc:  # noqa: BLE001 — never raises into the caller
                    logger.warning("resend POST failed (%s): %s", self.name, exc)
                    return SendResult(ok=False, detail=f"resend POST failed: {type(exc).__name__}")
                status = int(status)
                if 200 <= status < 300:
                    msg_id = self._message_id(text)
                    detail = f"resend accepted HTTP {status}"
                    if msg_id:
                        detail += f" id={msg_id}"
                    return SendResult(ok=True, detail=detail)
                # Retry ONLY transient 429/5xx — NOT a 4xx config/quota error.
                if status in _RETRY_STATUS and attempt < _MAX_ATTEMPTS:
                    backoff = self._retry_after(text) or (_DEFAULT_BACKOFF * attempt)
                    await self._sleep(min(backoff, 30.0))
                    continue
                break
            # Non-2xx after attempts: redacted (status only, never the key/body).
            return SendResult(ok=False, detail=f"resend rejected HTTP {status}")
        except Exception as exc:  # noqa: BLE001 — a send failure NEVER raises into the caller
            logger.warning("resend send failed (%s): %s", self.name, exc)
            return SendResult(ok=False, detail=f"resend send failed: {type(exc).__name__}")

    @staticmethod
    def _message_id(text: str) -> str:
        """Pull the provider message id from a 200 body ``{"id": "..."}`` (audit
        breadcrumb). Empty when absent / unparseable — never raises."""
        try:
            doc = json.loads(text or "{}")
        except Exception:  # noqa: BLE001
            return ""
        mid = doc.get("id") if isinstance(doc, dict) else None
        return str(mid)[:120] if mid else ""
