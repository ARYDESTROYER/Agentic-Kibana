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
import base64
import hashlib
import hmac
import logging
import smtplib
import ssl
from email.message import EmailMessage
from typing import Any, Callable

from .channel import NotificationChannel, NotificationEvent, SendResult, register_channel
from .templates import header_safe

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
                       username_hint=(
                           "EITHER a pre-made SES SMTP username (secret = SMTP password) "
                           "OR set config.aws_access_key_id (username) + secret = the IAM "
                           "SECRET access key; the SMTP password is derived automatically. "
                           "Set config.region."
                       )),
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


# --------------------------------------------------------------------------- #
# Amazon SES SMTP credential derivation (stdlib HMAC only — ZERO new deps).
#
# SES exposes SMTP on ``email-smtp.{region}.amazonaws.com``. The SMTP *password* is
# NOT the IAM secret access key — it is a DERIVED value: a fixed AWS Signature V4
# key-ladder over the literal message ``SendRawEmail``, prefixed with a version byte
# (0x04) and base64-encoded. This lets an operator supply EITHER a pre-made SES SMTP
# password OR a raw IAM access-key/secret pair (no boto3, no AWS console step) — we
# derive the SMTP password here at send time. The IAM access-key id becomes the SMTP
# username. The IAM SECRET access key stays in the secret tier (#10) and is never
# echoed (only the derived password is used to authenticate, never logged).
# --------------------------------------------------------------------------- #
_SES_DATE = "11111111"          # a FIXED literal, NOT a real date (per the AWS algo)
_SES_SERVICE = "ses"
_SES_TERMINATOR = "aws4_request"
_SES_MESSAGE = "SendRawEmail"
_SES_VERSION = 0x04


def _hmac_sha256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def derive_ses_smtp_password(secret_access_key: str, region: str) -> str:
    """Derive the SES SMTP password from an IAM secret access key + region.

    Implements AWS's published key ladder:
    ``HMAC("AWS4"+secret, "11111111") → region → "ses" → "aws4_request" →
    "SendRawEmail"``, then ``base64(bytes([0x04]) + signature)``. Pure stdlib."""
    region = (region or "us-east-1").strip() or "us-east-1"
    sig = _hmac_sha256(("AWS4" + (secret_access_key or "")).encode("utf-8"), _SES_DATE)
    sig = _hmac_sha256(sig, region)
    sig = _hmac_sha256(sig, _SES_SERVICE)
    sig = _hmac_sha256(sig, _SES_TERMINATOR)
    sig = _hmac_sha256(sig, _SES_MESSAGE)
    signature_and_version = bytes([_SES_VERSION]) + sig
    return base64.b64encode(signature_and_version).decode("ascii")


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
    headers: dict[str, str] | None = None,
    timeout: float = 15.0,
) -> None:
    """BLOCKING SMTP send (runs in a worker thread). Raises on failure — the caller
    converts that into a SendResult. STARTTLS vs SSL vs plaintext is selected by
    ``security``. Auth is attempted only when a username+password are present.

    ``headers`` are extra threading/routing headers (Message-Id / In-Reply-To /
    References / X-TLSOC-*). Every header value is ``header_safe``'d (CRLF/control
    stripped) before it reaches the header block (#9 — no header injection)."""
    msg = EmailMessage()
    msg["Subject"] = header_safe(subject, 200)
    msg["From"] = from_addr
    msg["To"] = ", ".join(recipients)
    for hk, hv in (headers or {}).items():
        safe_v = header_safe(hv, 998)
        if hk and safe_v:
            # email.message rejects a duplicate; replace defensively.
            if hk in msg:
                del msg[hk]
            msg[hk] = safe_v
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

    def _credentials(self, username: str) -> tuple[str, str]:
        """Resolve the SMTP (username, password) — the password is the per-channel
        SECRET (never persisted / echoed).

        SES dual-credential mode: when ``provider == 'ses'`` AND
        ``config['aws_access_key_id']`` is set, the channel secret is treated as the
        IAM SECRET access key and the SMTP password is DERIVED (stdlib HMAC); the
        access-key id becomes the SMTP username. Otherwise the secret is used as a
        pre-made SMTP password verbatim."""
        provider = str(self._config.get("provider") or "").strip().lower()
        secret = self._secret or str(self._config.get("password") or "")
        access_key_id = str(self._config.get("aws_access_key_id") or "").strip()
        if provider == "ses" and access_key_id and secret:
            region = str(self._config.get("region") or "us-east-1").strip() or "us-east-1"
            return access_key_id, derive_ses_smtp_password(secret, region)
        return username, secret

    async def send(self, event: NotificationEvent) -> SendResult:
        try:
            host, port, security, username = resolve_smtp(self._config)
            username, password = self._credentials(username)
            from_addr = str(self._config.get("from_addr") or username or "").strip()
            recipients = self._recipients()
            if not host:
                return SendResult(ok=False, detail="email channel has no SMTP host configured")
            if not from_addr:
                return SendResult(ok=False, detail="email channel has no from address configured")
            if not recipients:
                return SendResult(ok=False, detail="email channel has no recipients configured")
            # Threading/routing headers (already CRLF-safe in the sender too).
            headers = dict(getattr(event, "headers", None) or {})
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
                headers=headers,
            )
            return SendResult(
                ok=True,
                detail=f"email sent to {len(recipients)} recipient(s) via {host}:{port}/{security}",
            )
        except Exception as exc:  # noqa: BLE001 — a send failure NEVER raises into the caller
            logger.warning("Email send failed (%s): %s", self.name, exc)
            # Redacted: only the exception class + a short message, never credentials.
            return SendResult(ok=False, detail=f"email send failed: {type(exc).__name__}")
