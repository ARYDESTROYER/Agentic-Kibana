"""Syslog push receiver — RFC 3164 / RFC 5424 over UDP, TCP, or TLS.

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
import logging
from pathlib import Path
import ssl
from typing import Any

from ...config import Preferences
from ..base import AuthField, ConnectorManifest, EmitFn
from ...constants import IngestMode, SourceType
from .common import PayloadReceiver

logger = logging.getLogger("tlsoc.connectors.receivers.syslog")


class SyslogReceiver(PayloadReceiver):
    """RFC 3164 / RFC 5424 syslog over UDP/TCP/TLS.

    Config:
      * ``bind_host`` (default ``0.0.0.0``)
      * ``port`` (default ``514``)
      * ``protocol`` (``udp`` | ``tcp`` | ``tls``)
      * ``framing`` (``auto`` | ``octet-counting`` | ``newline``) — TCP only
      * ``format_hint`` (``auto`` | ``syslog5424`` | ``syslog3164``)
      * ``tls_cert_file`` / ``tls_key_file`` — mounted server certificate/key
      * ``tls_client_ca_file`` — optional mounted CA for client certificates
      * ``tls_require_client_cert`` — require mTLS when true
      * ``tls_key_password`` — optional write-only private-key password

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
                "Syslog listener over UDP/TCP/TLS. Parses RFC 5424 "
                "(structured-data aware) and RFC 3164 (BSD) and emits per message. "
                "TCP framing auto-detects octet-counting (RFC 6587) and newline."
            ),
            ingest_modes=[IngestMode.PUSH_SYSLOG, IngestMode.PUSH_SOCKET],
            capabilities=["subscribe"],
            docs_url="https://datatracker.ietf.org/doc/html/rfc5424",
            setup_help=(
                "## Connect Syslog\n"
                "1. **Bind address + port** — the interface/port this backend listens on "
                "(default `0.0.0.0:514`). Privileged ports (<1024) need "
                "`CAP_NET_BIND_SERVICE`; a high port like `5514` avoids that.\n"
                "2. **Protocol** — `udp` (lossy, simplest), `tcp` (reliable, framed), or "
                "`tls` (encrypted TCP using a mounted certificate and private key).\n"
                "3. **TLS files** — for `tls`, mount the certificate/key read-only into the "
                "backend and enter their container paths. Add a client CA and enable mTLS "
                "when senders must authenticate with certificates.\n"
                "4. **Point your devices/hosts/appliances** at `host:port` for syslog; "
                "RFC 5424 (structured-data aware) and RFC 3164 (BSD) are both parsed.\n"
                "UDP/TCP have no inbound auth; restrict reachability at the network layer."
            ),
            auth_fields=[
                AuthField(
                    key="tls_key_password", label="TLS private-key password",
                    type="password", secret=True, required=False,
                    help="Optional password for an encrypted TLS private key. Write-only.",
                    group="TLS",
                ),
            ],
            config_fields=[
                AuthField(key="bind_host", label="Bind address", type="string",
                          default="0.0.0.0", help="Interface to listen on."),
                AuthField(key="port", label="Port", type="number", default=514,
                          help="UDP/TCP port (privileged <1024 needs CAP_NET_BIND_SERVICE).",
                          placeholder="514"),
                AuthField(key="protocol", label="Protocol", type="select",
                          options=["udp", "tcp", "tls"], default="udp"),
                AuthField(key="framing", label="TCP framing", type="select",
                          options=["auto", "octet-counting", "newline"], default="auto",
                          help="How TCP streams are split into messages (TCP only)."),
                AuthField(key="format_hint", label="Syslog format", type="select",
                          options=["auto", "syslog5424", "syslog3164"], default="auto"),
                AuthField(
                    key="tls_cert_file", label="TLS certificate path", type="string",
                    help="Mounted PEM certificate chain path inside the backend container (TLS only).",
                    placeholder="/run/secrets/syslog-server.crt", group="TLS",
                ),
                AuthField(
                    key="tls_key_file", label="TLS private-key path", type="string",
                    help="Mounted PEM private-key path inside the backend container (TLS only).",
                    placeholder="/run/secrets/syslog-server.key", group="TLS",
                ),
                AuthField(
                    key="tls_client_ca_file", label="Client CA path", type="string",
                    help="Optional mounted CA bundle used to verify sender certificates.",
                    placeholder="/run/secrets/syslog-client-ca.crt", group="TLS",
                ),
                AuthField(
                    key="tls_require_client_cert", label="Require client certificate",
                    type="bool", default=False,
                    help="Require a valid sender certificate signed by the configured client CA.",
                    group="TLS",
                ),
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
            # TLS must fail closed: selecting it can never silently bind a plaintext
            # socket. _build_tls_context validates the mounted material before bind.
            ssl_ctx = self._build_tls_context() if protocol == "tls" else None
            self._server = await asyncio.start_server(
                lambda r, w: self._handle_tcp(r, w, emit, prefs),
                host, port, ssl=ssl_ctx,
            )
        else:
            raise ValueError(f"unsupported syslog protocol: {protocol!r}")

    def _build_tls_context(self) -> ssl.SSLContext:
        """Build a fail-closed TLS 1.2+ server context from mounted PEM files.

        Private key material stays outside persisted source configuration. The optional
        password is supplied through the connector's write-only secret bucket. A client
        CA enables sender-certificate verification; mTLS cannot be requested without it.
        """
        cert_file = _required_file(self.config.get("tls_cert_file"), "TLS certificate")
        key_file = _required_file(self.config.get("tls_key_file"), "TLS private key")
        client_ca_raw = str(self.config.get("tls_client_ca_file") or "").strip()
        require_client = _as_bool(self.config.get("tls_require_client_cert", False))
        if require_client and not client_ca_raw:
            raise ValueError("Syslog mTLS requires tls_client_ca_file")

        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        password = str(self.config.get("tls_key_password") or "") or None
        context.load_cert_chain(certfile=cert_file, keyfile=key_file, password=password)
        if client_ca_raw:
            client_ca = _required_file(client_ca_raw, "TLS client CA")
            context.load_verify_locations(cafile=client_ca)
            context.verify_mode = ssl.CERT_REQUIRED if require_client else ssl.CERT_OPTIONAL
        else:
            context.verify_mode = ssl.CERT_NONE
        return context

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


def _required_file(value: Any, label: str) -> str:
    path = Path(str(value or "").strip()).expanduser()
    if not str(value or "").strip():
        raise ValueError(f"Syslog TLS requires {label.lower()} path")
    if not path.is_file():
        raise ValueError(f"{label} file does not exist or is not readable: {path}")
    return str(path)


def _as_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


class _SyslogUDPProtocol(asyncio.DatagramProtocol):
    """One datagram == one (or more newline-joined) syslog message(s)."""

    def __init__(self, receiver: SyslogReceiver, emit: EmitFn, prefs: Preferences) -> None:
        self._receiver = receiver
        self._emit = emit
        self._prefs = prefs
        # Retain in-flight ingest tasks so they are NOT garbage-collected mid-flight, and
        # attach a done-callback that surfaces ingest failures instead of swallowing them
        # (audit #35). Completed tasks are discarded, so the set stays bounded by the
        # in-flight rate.
        self._tasks: set[asyncio.Future[Any]] = set()

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        # Schedule async normalisation; the protocol callback itself is sync.
        task = asyncio.ensure_future(
            self._receiver._emit_payload(data, self._prefs, self._emit)
        )
        self._tasks.add(task)
        task.add_done_callback(self._on_task_done)

    def _on_task_done(self, task: asyncio.Future[Any]) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        exc = task.exception()
        if exc is not None:
            logger.warning("syslog UDP datagram ingest failed: %s", exc)


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
