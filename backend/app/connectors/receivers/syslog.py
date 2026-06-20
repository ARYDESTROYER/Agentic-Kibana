"""Syslog push receiver — RFC 3164 / RFC 5424 over UDP, TCP (and TLS, TODO).

Syslog is the oldest and most universal log-forward transport: routers,
firewalls, *nix hosts and appliances all speak it. :class:`SyslogReceiver` binds
an asyncio UDP and/or TCP listener (pure stdlib — NO new dependency) on the
configured host/port and emits one batch per datagram (UDP) or per framed
message (TCP). Framing supports both newline-delimited and RFC 6587
octet-counting (``<len> <msg>``), auto-detected.

The format parsers live in :mod:`.formats`; ``parse`` reuses them so the receiver
is fully unit-testable with a raw line and no socket.
"""

from __future__ import annotations

import asyncio
from typing import Any

from ...config import Preferences
from ..base import AuthField, ConnectorManifest, EmitFn
from ...constants import IngestMode, SourceType
from .common import PayloadReceiver


class SyslogReceiver(PayloadReceiver):
    """RFC 3164 / RFC 5424 syslog over UDP/TCP (TLS is a documented TODO).

    Config:
      * ``bind_host`` (default ``0.0.0.0``)
      * ``port`` (default ``514``)
      * ``protocol`` (``udp`` | ``tcp`` | ``tls``)
      * ``framing`` (``auto`` | ``octet-counting`` | ``newline``) — TCP only
      * ``format_hint`` (``auto`` | ``syslog5424`` | ``syslog3164``)

    Each datagram / framed message is parsed with the syslog format parsers and
    emitted as a batch. ``auto`` format detection distinguishes 5424 (version
    digit after the PRI) from 3164.
    """

    source_type = SourceType.SYSLOG
    default_hint = None  # auto: detect 5424 vs 3164 per message

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._transport: asyncio.BaseTransport | None = None
        self._server: asyncio.AbstractServer | None = None
        self._running = False

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.SYSLOG,
            display_name="Syslog (RFC 3164 / 5424)",
            category="transport",
            description=(
                "Syslog listener over UDP/TCP (TLS planned). Parses RFC 5424 "
                "(structured-data aware) and RFC 3164 (BSD) and emits per message. "
                "TCP framing auto-detects octet-counting (RFC 6587) and newline."
            ),
            ingest_modes=[IngestMode.PUSH_SYSLOG, IngestMode.PUSH_SOCKET],
            capabilities=["subscribe"],
            auth_fields=[],
            config_fields=[
                AuthField(key="bind_host", label="Bind address", type="string",
                          default="0.0.0.0", help="Interface to listen on."),
                AuthField(key="port", label="Port", type="number", default=514,
                          help="UDP/TCP port (privileged <1024 needs CAP_NET_BIND_SERVICE)."),
                AuthField(key="protocol", label="Protocol", type="select",
                          options=["udp", "tcp", "tls"], default="udp"),
                AuthField(key="framing", label="TCP framing", type="select",
                          options=["auto", "octet-counting", "newline"], default="auto",
                          help="How TCP streams are split into messages (TCP only)."),
                AuthField(key="format_hint", label="Syslog format", type="select",
                          options=["auto", "syslog5424", "syslog3164"], default="auto"),
            ],
            requires_pip=[],  # stdlib asyncio only
        )

    # ------------------------------------------------------------------ #
    # Lifecycle: bind UDP and/or TCP listeners.
    # ------------------------------------------------------------------ #
    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        host = str(self.config.get("bind_host", "0.0.0.0"))
        port = int(self.config.get("port", 514) or 514)
        protocol = str(self.config.get("protocol", "udp")).lower()
        loop = asyncio.get_running_loop()
        self._running = True

        if protocol == "udp":
            self._transport, _ = await loop.create_datagram_endpoint(
                lambda: _SyslogUDPProtocol(self, emit, prefs),
                local_addr=(host, port),
            )
        elif protocol in ("tcp", "tls"):
            ssl_ctx = None
            if protocol == "tls":
                # TODO: wire up an ssl.SSLContext from cert/key config. We still
                # bind plain TCP so the transport works; TLS termination is a
                # follow-up. Declared in the manifest so the wizard exposes it.
                ssl_ctx = self._build_tls_context()
            self._server = await asyncio.start_server(
                lambda r, w: self._handle_tcp(r, w, emit, prefs),
                host, port, ssl=ssl_ctx,
            )
        else:
            raise ValueError(f"unsupported syslog protocol: {protocol!r}")

    def _build_tls_context(self) -> Any:
        """Best-effort TLS context (TODO: cert/key wiring). Returns None today so
        the listener still binds; documented as a follow-up in the manifest."""
        return None

    async def _handle_tcp(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        emit: EmitFn,
        prefs: Preferences,
    ) -> None:
        framing = str(self.config.get("framing", "auto")).lower()
        try:
            async for message in _read_framed(reader, framing):
                if message.strip():
                    await self._emit_payload(message, prefs, emit)
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    async def stop(self) -> None:
        self._running = False
        if self._transport is not None:
            self._transport.close()
            self._transport = None
        if self._server is not None:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:  # noqa: BLE001
                pass
            self._server = None


class _SyslogUDPProtocol(asyncio.DatagramProtocol):
    """One datagram == one (or more newline-joined) syslog message(s)."""

    def __init__(self, receiver: SyslogReceiver, emit: EmitFn, prefs: Preferences) -> None:
        self._receiver = receiver
        self._emit = emit
        self._prefs = prefs

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        # Schedule async normalisation; the protocol callback itself is sync.
        asyncio.ensure_future(
            self._receiver._emit_payload(data, self._prefs, self._emit)
        )


async def _read_framed(reader: asyncio.StreamReader, framing: str):
    """Yield syslog messages from a TCP stream.

    ``octet-counting`` (RFC 6587): ``<MSGLEN> SP MSG``. ``newline``: messages are
    LF-terminated. ``auto``: peek the first byte — a leading digit selects
    octet-counting, otherwise newline framing."""
    if framing == "auto":
        first = await reader.read(1)
        if not first:
            return
        if first.isdigit():
            async for msg in _read_octet_counted(reader, prefix=first):
                yield msg
        else:
            # Put the byte back logically by prepending to the first line read.
            line = await reader.readline()
            yield (first + line).decode("utf-8", errors="replace")
            async for raw in _iter_lines(reader):
                yield raw
    elif framing == "octet-counting":
        async for msg in _read_octet_counted(reader):
            yield msg
    else:  # newline
        async for raw in _iter_lines(reader):
            yield raw


async def _iter_lines(reader: asyncio.StreamReader):
    while True:
        line = await reader.readline()
        if not line:
            return
        yield line.decode("utf-8", errors="replace")


async def _read_octet_counted(reader: asyncio.StreamReader, prefix: bytes = b""):
    """RFC 6587 octet-counting frames: ``<len> SP <msg>``."""
    buf = prefix
    while True:
        # Read the length token up to the space.
        while b" " not in buf:
            chunk = await reader.read(1)
            if not chunk:
                if buf.strip():
                    yield buf.decode("utf-8", errors="replace")
                return
            buf += chunk
        length_str, _, rest = buf.partition(b" ")
        try:
            length = int(length_str)
        except ValueError:
            # Not a valid count — degrade to newline framing for the rest.
            yield (length_str + b" " + rest).decode("utf-8", errors="replace")
            async for raw in _iter_lines(reader):
                yield raw
            return
        body = rest
        while len(body) < length:
            chunk = await reader.read(length - len(body))
            if not chunk:
                break
            body += chunk
        yield body[:length].decode("utf-8", errors="replace")
        buf = body[length:]
