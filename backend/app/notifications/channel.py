"""Pluggable notification channel SPI (F5).

A :class:`NotificationChannel` knows how to deliver ONE :class:`NotificationEvent`
to ONE destination (email inbox, Slack/Teams webhook, PagerDuty, Telegram, a
generic JSON webhook). Channels are constructed per-send from the operator's
``ChannelConfig`` (non-secret) + the channel's secret (SMTP password / API key /
webhook URL) resolved from the SECRET tier at send time — secrets NEVER live in
Preferences (#10).

Design rules that keep notifications safe (Non-negotiable #3 + #9):

* ``send`` returns a :class:`SendResult`; it NEVER raises into the caller. Every
  channel wraps its transport in try/except → ``SendResult(ok=False, detail=...)``
  so a send failure can never block, delay, or alter the case decision/flow. The
  dispatcher fires sends fire-and-forget; this is the second line of defence.
* The rendered body (subject/html/text) is produced by :mod:`templates`, which
  fences/escapes all log-derived/case text as UNTRUSTED before it reaches HTML or
  plain text. A channel must treat ``event.html``/``event.text`` as already-safe
  rendered output and never re-inject raw case fields.
* ``detail`` is a SHORT, redacted status string — it must never carry a secret
  (password / token / full webhook URL). The dispatcher audits it verbatim.

The registry maps a channel ``type`` string → channel class so the dispatcher can
build the right channel for each configured entry without an if-ladder.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Callable

logger = logging.getLogger("tlsoc.notifications.channel")

#: Entry-point group third-party channels register under. ``pip install
#: tlsoc-channel-<x>`` that declares ``[project.entry-points."tlsoc.channels"]``
#: appears in the catalog with ZERO core change — same detachability the connector
#: and enrichment registries have (Round 5 / Coupling-F).
ENTRY_POINT_GROUP = "tlsoc.channels"


@dataclass(slots=True)
class NotificationEvent:
    """A fully-rendered notification ready for any channel to deliver.

    ``subject``/``html``/``text`` are the rendered, UNTRUSTED-safe body produced by
    :mod:`app.notifications.templates` (case/log text already escaped/fenced). ``case``
    is the originating :class:`app.models.Case` (or a dict projection) for channels
    that build a structured payload (Slack blocks / PagerDuty custom_details); a
    channel must only read already-safe scalar fields from it, never re-render raw
    untrusted text into HTML. ``trigger`` is the firing trigger name (e.g.
    ``case_created`` / ``escalated``). ``meta`` carries derived scalars (severity,
    risk, verdict, disposition, case_url, entity) the structured channels surface.
    """

    case: Any
    trigger: str
    subject: str
    html: str
    text: str
    meta: dict[str, Any] = field(default_factory=dict)
    # Threading/routing email headers (Message-Id / In-Reply-To / References /
    # X-TLSOC-*). Already CRLF/control-stripped by templates.threading_headers; the
    # email channels add them to the message. Empty for non-email channels.
    headers: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class SendResult:
    """Outcome of one channel send. ``detail`` is a short, REDACTED status string
    (never a secret) the dispatcher records in the audit log."""

    ok: bool
    detail: str = ""

    def model_dump(self) -> dict[str, Any]:  # convenience for JSON responses
        return {"ok": self.ok, "detail": self.detail}


class NotificationChannel(ABC):
    """One delivery transport. Built per-send from ``config`` (non-secret) + the
    resolved per-channel ``secret`` (SMTP password / API key / webhook URL).

    Subclasses implement :meth:`send`; it MUST NOT raise — wrap transport failures
    into ``SendResult(ok=False, detail=...)``."""

    #: the ``ChannelConfig.type`` value this class handles (set by subclasses).
    type: str = ""

    def __init__(self, config: dict[str, Any], secret: str = "") -> None:
        self._config = dict(config or {})
        self._secret = secret or ""

    @property
    def name(self) -> str:
        return str(self._config.get("name") or self._config.get("id") or self.type)

    @abstractmethod
    async def send(self, event: NotificationEvent) -> SendResult:
        """Deliver ``event``. NEVER raises — returns a :class:`SendResult`."""


# --------------------------------------------------------------------------- #
# Channel-type registry (type string -> channel class).
# --------------------------------------------------------------------------- #
_REGISTRY: dict[str, type[NotificationChannel]] = {}


def register_channel(channel_cls: type[NotificationChannel]) -> type[NotificationChannel]:
    """Register a channel class under its ``type`` (decorator-friendly)."""
    t = (channel_cls.type or "").strip().lower()
    if t:
        _REGISTRY[t] = channel_cls
    return channel_cls


def get_channel_class(channel_type: str) -> type[NotificationChannel] | None:
    return _REGISTRY.get((channel_type or "").strip().lower())


def channel_types() -> list[str]:
    """All registered channel type ids (sorted, stable for the UI/providers route)."""
    return sorted(_REGISTRY.keys())


def build_channel(
    channel_type: str, config: dict[str, Any], secret: str = ""
) -> NotificationChannel | None:
    """Construct a channel for ``channel_type`` (None when the type is unknown)."""
    cls = get_channel_class(channel_type)
    if cls is None:
        return None
    return cls(config, secret)


_BUILTINS_LOADED = False


def _load_builtins() -> None:
    """Import the built-in channel modules so their classes self-register. Imported
    lazily (and idempotently) the first time the registry is used so importing this
    module alone has no side effects / import cycles.

    Guarded by a module-level flag (NOT ``if _REGISTRY``): if one channel module was
    imported first and self-registered, an ``if _REGISTRY: return`` would skip the
    REST, leaving the registry partial (e.g. only ``email``). The flag guarantees
    every built-in is imported exactly once. Module imports are idempotent, so a
    re-entrant/duplicate call is harmless."""
    global _BUILTINS_LOADED
    if _BUILTINS_LOADED:
        return
    _BUILTINS_LOADED = True
    # Importing these modules triggers @register_channel at definition time.
    from . import email as _email  # noqa: F401
    from . import resend as _resend  # noqa: F401  (Wave 7 — Resend HTTPS-API)
    from . import webhook as _webhook  # noqa: F401


_DISCOVERED = False


def _discover_third_party() -> None:
    """Discover out-of-tree channels registered under ``tlsoc.channels`` (once).

    A discovered class is fed through the SAME ``register_channel`` path the built-ins
    use, so a third-party channel appears in ``channel_types()`` / ``build_channel``
    with zero core change. Fully isolated + warned end-to-end (a bad plugin never
    breaks channel dispatch) via the shared plugin discovery helper (Round 5)."""
    global _DISCOVERED
    if _DISCOVERED:
        return
    _DISCOVERED = True
    from ..plugins.registry import discover_entry_points

    discover_entry_points(
        ENTRY_POINT_GROUP, register_channel, what="notification channel", log=logger,
    )


# Public hook callers use to guarantee the registry is populated (built-ins + any
# third-party channels discovered via the ``tlsoc.channels`` entry-point group).
def ensure_registered() -> None:
    _load_builtins()
    _discover_third_party()


# A typed alias the dispatcher uses for an injectable SMTP transport in tests.
SmtpSender = Callable[..., Any]
