"""HTTP-based notification channels (F5) — over the repo's existing ``httpx``.

Channels: ``webhook`` (generic JSON POST), ``slack`` (Incoming Webhook),
``teams`` (Incoming Webhook / MessageCard), ``pagerduty`` (Events API v2),
``telegram`` (Bot ``sendMessage``). All POST over the ``httpx`` async client the
repo already ships (ZERO new deps). The destination URL / API key / bot token is
the per-channel SECRET resolved at send time (#10) — never persisted, never echoed.

Every ``send`` is fully error-isolated → :class:`SendResult` (never raises), so a
delivery failure can never block or alter the case decision/flow (#3). Payload
bodies carry the already-rendered, UNTRUSTED-safe text from :mod:`templates`; the
structured builders only read already-safe scalar fields from ``event``/``meta``.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

import httpx

from .channel import NotificationChannel, NotificationEvent, SendResult, register_channel

logger = logging.getLogger("tlsoc.notifications.webhook")

_TIMEOUT = 10.0

# An injectable async POSTer: (url, *, json|content, headers) -> (status_code, text).
# Defaults to the real httpx path; tests inject a stub so no network is touched.
Poster = Callable[..., Awaitable[tuple[int, str]]]


async def _httpx_post(
    url: str,
    *,
    json: Any | None = None,
    content: Any | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, str]:
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        resp = await client.post(url, json=json, content=content, headers=headers)
        return resp.status_code, (resp.text or "")


class _HttpChannel(NotificationChannel):
    """Shared base: holds the injectable poster + a small ``_post`` helper that
    isolates transport errors and reads the destination URL from the secret tier
    (falling back to a non-secret ``url`` in config for the generic webhook)."""

    def __init__(
        self,
        config: dict[str, Any],
        secret: str = "",
        *,
        poster: Poster | None = None,
    ) -> None:
        super().__init__(config, secret)
        self._poster = poster or _httpx_post

    def _url(self) -> str:
        """The destination URL: the per-channel secret first (sensitive webhook URLs
        live in the secret tier), then a non-secret ``url`` in config."""
        return (self._secret or str(self._config.get("url") or "")).strip()

    async def _post(
        self,
        url: str,
        *,
        json: Any | None = None,
        content: Any | None = None,
        headers: dict[str, str] | None = None,
        success_max: int = 300,
    ) -> SendResult:
        if not url:
            return SendResult(ok=False, detail=f"{self.type} channel has no destination URL configured")
        try:
            status, _text = await self._poster(url, json=json, content=content, headers=headers)
        except Exception as exc:  # noqa: BLE001 — never raises into the caller
            logger.warning("%s POST failed (%s): %s", self.type, self.name, exc)
            return SendResult(ok=False, detail=f"{self.type} POST failed: {type(exc).__name__}")
        ok = 200 <= int(status) < success_max
        # Redacted: status code only, never the URL/token or response body.
        return SendResult(ok=ok, detail=f"{self.type} responded HTTP {status}")


@register_channel
class WebhookChannel(_HttpChannel):
    """Generic JSON webhook: POSTs a structured event document to an operator URL."""

    type = "webhook"

    async def send(self, event: NotificationEvent) -> SendResult:
        payload = {
            "trigger": event.trigger,
            "subject": event.subject,
            "text": event.text,
            **{k: v for k, v in (event.meta or {}).items()},
        }
        return await self._post(self._url(), json=payload)


@register_channel
class SlackChannel(_HttpChannel):
    """Slack Incoming Webhook — a simple ``{text, blocks}`` message."""

    type = "slack"

    async def send(self, event: NotificationEvent) -> SendResult:
        meta = event.meta or {}
        fields = []
        for label, key in (("Severity", "severity"), ("Risk", "risk_score"),
                            ("Verdict", "verdict"), ("Status", "status")):
            val = meta.get(key)
            if val not in (None, ""):
                fields.append({"type": "mrkdwn", "text": f"*{label}:* {val}"})
        blocks: list[dict[str, Any]] = [
            {"type": "section", "text": {"type": "mrkdwn", "text": f"*{event.subject}*"}},
        ]
        if fields:
            blocks.append({"type": "section", "fields": fields[:10]})
        if event.text:
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": event.text[:2900]}})
        payload = {"text": event.subject, "blocks": blocks}
        return await self._post(self._url(), json=payload)


@register_channel
class TeamsChannel(_HttpChannel):
    """Microsoft Teams Incoming Webhook — a legacy MessageCard (broadly supported)."""

    type = "teams"

    async def send(self, event: NotificationEvent) -> SendResult:
        meta = event.meta or {}
        facts = []
        for label, key in (("Severity", "severity"), ("Risk", "risk_score"),
                            ("Verdict", "verdict"), ("Status", "status"),
                            ("Entity", "entity")):
            val = meta.get(key)
            if val not in (None, ""):
                facts.append({"name": label, "value": str(val)})
        payload = {
            "@type": "MessageCard",
            "@context": "http://schema.org/extensions",
            "summary": event.subject,
            "themeColor": meta.get("theme_color") or "D7263D",
            "title": event.subject,
            "sections": [{"facts": facts, "text": event.text[:4000]}],
        }
        return await self._post(self._url(), json=payload)


@register_channel
class PagerDutyChannel(_HttpChannel):
    """PagerDuty Events API v2 — a ``trigger`` event keyed by the routing key.

    The per-channel SECRET is the ROUTING (integration) KEY, not a URL; the Events
    API endpoint is fixed."""

    type = "pagerduty"
    _ENDPOINT = "https://events.pagerduty.com/v2/enqueue"

    _SEVERITY_MAP = {"critical": "critical", "high": "error", "medium": "warning", "low": "info"}

    async def send(self, event: NotificationEvent) -> SendResult:
        routing_key = (self._secret or str(self._config.get("routing_key") or "")).strip()
        if not routing_key:
            return SendResult(ok=False, detail="pagerduty channel has no routing key configured")
        meta = event.meta or {}
        sev_label = str(meta.get("severity_label") or "warning").lower()
        payload = {
            "routing_key": routing_key,
            "event_action": "trigger",
            "dedup_key": str(meta.get("case_id") or "")[:255] or None,
            "payload": {
                "summary": event.subject[:1024],
                "source": str(meta.get("source_name") or "Agentic SOC")[:255] or "Agentic SOC",
                "severity": self._SEVERITY_MAP.get(sev_label, "warning"),
                "custom_details": {
                    "trigger": event.trigger,
                    "verdict": meta.get("verdict"),
                    "risk_score": meta.get("risk_score"),
                    "entity": meta.get("entity"),
                    "case_url": meta.get("case_url"),
                },
            },
        }
        # Drop a None dedup_key so PagerDuty doesn't reject it.
        if payload["dedup_key"] is None:
            payload.pop("dedup_key")
        return await self._post(
            self._ENDPOINT, json=payload, headers={"Content-Type": "application/json"},
            success_max=300,
        )


@register_channel
class TelegramChannel(_HttpChannel):
    """Telegram Bot ``sendMessage``. The per-channel SECRET is the BOT TOKEN; the
    target ``chat_id`` is non-secret config."""

    type = "telegram"

    async def send(self, event: NotificationEvent) -> SendResult:
        token = (self._secret or str(self._config.get("bot_token") or "")).strip()
        chat_id = str(self._config.get("chat_id") or "").strip()
        if not token:
            return SendResult(ok=False, detail="telegram channel has no bot token configured")
        if not chat_id:
            return SendResult(ok=False, detail="telegram channel has no chat_id configured")
        body = f"{event.subject}\n\n{event.text}".strip()
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        payload = {"chat_id": chat_id, "text": body[:4096], "disable_web_page_preview": True}
        return await self._post(url, json=payload)
