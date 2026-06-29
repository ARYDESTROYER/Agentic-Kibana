"""Email notification channel (F5) — stdlib ``smtplib`` only (ZERO new deps).

The blocking SMTP I/O runs inside :func:`asyncio.to_thread` so it never blocks the
event loop. The actual transport is INJECTABLE (``sender=``) so offline tests mock
it and no real network is touched. Provider presets cover the top consumer/business
SMTP relays; ``custom`` lets the operator supply host/port/security directly.

Security (#3/#10): the SMTP password is the per-channel SECRET (resolved at send
time), never persisted to Preferences and never echoed in a :class:`SendResult`.
The body is the already-rendered, UNTRUSTED-safe HTML+text from :mod:`templates`.
"""

from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from email.message import EmailMessage
from typing import Any, Callable

from .channel import NotificationChannel, NotificationEvent, SendResult, register_channel

logger = logging.getLogger("tlsoc.notifications.email")

# security ∈ {starttls, ssl, none}
_STARTTLS = "starttls"
_SSL = "ssl"
_NONE = "none"


class EmailPreset:
    """One SMTP provider preset (host/port/security + optional fixed username)."""

    __slots__ = ("id", "host", "port", "security", "username_hint", "fixed_username")

    def __init__(
        self,
        id: str,
        host: str,
        port: int,
        security: str,
        *,
        username_hint: str = "",
        fixed_username: str | None = None,
    ) -> None:
        self.id = id
        self.host = host
        self.port = port
        self.security = security
        self.username_hint = username_hint
        # When set, the SMTP username is FIXED by the provider (e.g. SendGrid uses
        # the literal "apikey"); the API key goes in the password (the secret tier).
        self.fixed_username = fixed_username

    def resolve_host(self, config: dict[str, Any]) -> str:
        """The effective host — SES embeds a ``{region}`` placeholder filled from
        the source's ``region`` config (default us-east-1)."""
        if "{region}" in self.host:
            region = str(config.get("region") or "us-east-1").strip() or "us-east-1"
            return self.host.replace("{region}", region)
        return self.host

    def as_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "host": self.host,
            "port": self.port,
            "security": self.security,
            "username_hint": self.username_hint,
            "fixed_username": self.fixed_username,
        }


# The provider preset table (F5 contract). ``custom`` carries no defaults — the
# operator supplies host/port/security.
EMAIL_PRESETS: dict[str, EmailPreset] = {
    "gmail": EmailPreset("gmail", "smtp.gmail.com", 587, _STARTTLS,
                         username_hint="your full Gmail address; use an App Password"),
    "o365": EmailPreset("o365", "smtp.office365.com", 587, _STARTTLS,
                        username_hint="your Microsoft 365 mailbox address"),
    "yahoo": EmailPreset("yahoo", "smtp.mail.yahoo.com", 465, _SSL,
                         username_hint="your Yahoo address; use an App Password"),
    "zoho": EmailPreset("zoho", "smtp.zoho.com", 587, _STARTTLS,
                        username_hint="your Zoho Mail address"),
    "icloud": EmailPreset("icloud", "smtp.mail.me.com", 587, _STARTTLS,
                          username_hint="your iCloud address; use an App-Specific Password"),
    "sendgrid": EmailPreset("sendgrid", "smtp.sendgrid.net", 587, _STARTTLS,
                            username_hint='literal "apikey" (the API key is the password)',
                            fixed_username="apikey"),
    "ses": EmailPreset("ses", "email-smtp.{region}.amazonaws.com", 587, _STARTTLS,
                       username_hint="your SES SMTP username (set region in config)"),
    "mailgun": EmailPreset("mailgun", "smtp.mailgun.org", 587, _STARTTLS,
                           username_hint="your Mailgun SMTP login (postmaster@your-domain)"),
    "postmark": EmailPreset("postmark", "smtp.postmarkapp.com", 587, _STARTTLS,
                            username_hint="your Postmark Server API token (as user AND pass)"),
    "brevo": EmailPreset("brevo", "smtp-relay.brevo.com", 587, _STARTTLS,
                         username_hint="your Brevo login email"),
    "mailjet": EmailPreset("mailjet", "in-v3.mailjet.com", 587, _STARTTLS,
                           username_hint="your Mailjet API key (user) / secret key (pass)"),
    "sparkpost": EmailPreset("sparkpost", "smtp.sparkpostmail.com", 587, _STARTTLS,
                             username_hint='literal "SMTP_Injection" (API key as password)',
                             fixed_username="SMTP_Injection"),
    "custom": EmailPreset("custom", "", 0, _STARTTLS,
                          username_hint="your SMTP username"),
}


def preset_list() -> list[dict[str, Any]]:
    """Serialisable preset table for the ``GET /api/notifications/providers`` route."""
    return [p.as_dict() for p in EMAIL_PRESETS.values()]


def resolve_smtp(config: dict[str, Any]) -> tuple[str, int, str, str]:
    """Resolve (host, port, security, username) from a channel config.

    Precedence: an explicit ``host``/``port``/``security`` in config overrides the
    provider preset (so ``custom`` works and a preset can be tuned). A preset with a
    ``fixed_username`` (SendGrid/SparkPost) pins the username regardless of config."""
    provider = str(config.get("provider") or "custom").strip().lower()
    preset = EMAIL_PRESETS.get(provider, EMAIL_PRESETS["custom"])
    host = str(config.get("host") or preset.resolve_host(config) or "").strip()
    port = int(config.get("port") or preset.port or 587)
    security = str(config.get("security") or preset.security or _STARTTLS).strip().lower()
    if security not in (_STARTTLS, _SSL, _NONE):
        security = _STARTTLS
    username = preset.fixed_username or str(config.get("username") or "").strip()
    return host, port, security, username


def _send_via_smtp(
    *,
    host: str,
    port: int,
    security: str,
    username: str,
    password: str,
    from_addr: str,
    recipients: list[str],
    subject: str,
    text: str,
    html: str,
    timeout: float = 15.0,
) -> None:
    """BLOCKING SMTP send (runs in a worker thread). Raises on failure — the caller
    converts that into a SendResult. STARTTLS vs SSL vs plaintext is selected by
    ``security``. Auth is attempted only when a username+password are present."""
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = ", ".join(recipients)
    msg.set_content(text or "")
    if html:
        msg.add_alternative(html, subtype="html")

    context = ssl.create_default_context()
    if security == _SSL:
        with smtplib.SMTP_SSL(host, port, timeout=timeout, context=context) as smtp:
            if username and password:
                smtp.login(username, password)
            smtp.send_message(msg)
        return
    with smtplib.SMTP(host, port, timeout=timeout) as smtp:
        smtp.ehlo()
        if security == _STARTTLS:
            smtp.starttls(context=context)
            smtp.ehlo()
        if username and password:
            smtp.login(username, password)
        smtp.send_message(msg)


@register_channel
class EmailChannel(NotificationChannel):
    """SMTP email channel. The blocking send runs in a thread; the transport is
    injectable for tests via ``sender=``."""

    type = "email"

    def __init__(
        self,
        config: dict[str, Any],
        secret: str = "",
        *,
        sender: Callable[..., None] | None = None,
    ) -> None:
        super().__init__(config, secret)
        # Injectable blocking transport (defaults to the real stdlib smtplib path).
        self._sender = sender or _send_via_smtp

    def _recipients(self) -> list[str]:
        raw = self._config.get("recipients") or []
        if isinstance(raw, str):
            raw = [r.strip() for r in raw.replace(";", ",").split(",")]
        return [str(r).strip() for r in raw if str(r).strip()]

    async def send(self, event: NotificationEvent) -> SendResult:
        try:
            host, port, security, username = resolve_smtp(self._config)
            from_addr = str(self._config.get("from_addr") or username or "").strip()
            recipients = self._recipients()
            if not host:
                return SendResult(ok=False, detail="email channel has no SMTP host configured")
            if not from_addr:
                return SendResult(ok=False, detail="email channel has no from address configured")
            if not recipients:
                return SendResult(ok=False, detail="email channel has no recipients configured")
            # The password is the per-channel SECRET (never persisted / echoed).
            password = self._secret or str(self._config.get("password") or "")
            await asyncio.to_thread(
                self._sender,
                host=host,
                port=port,
                security=security,
                username=username,
                password=password,
                from_addr=from_addr,
                recipients=recipients,
                subject=event.subject,
                text=event.text,
                html=event.html,
            )
            return SendResult(
                ok=True,
                detail=f"email sent to {len(recipients)} recipient(s) via {host}:{port}/{security}",
            )
        except Exception as exc:  # noqa: BLE001 — a send failure NEVER raises into the caller
            logger.warning("Email send failed (%s): %s", self.name, exc)
            # Redacted: only the exception class + a short message, never credentials.
            return SendResult(ok=False, detail=f"email send failed: {type(exc).__name__}")
