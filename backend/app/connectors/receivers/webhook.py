"""HTTP push receivers — the UNIVERSAL forward path.

A *webhook* is the lowest-common-denominator way to forward security events to
us: almost every SIEM, EDR, SOAR and cloud service can POST JSON/NDJSON/CEF/LEEF
to an HTTPS endpoint. :class:`WebhookReceiver` owns that path; :class:`HECReceiver`
is a thin specialisation that understands the Splunk HTTP Event Collector
envelope so anything already configured to ship to HEC works unchanged.

The FastAPI app owns the listening port (one shared port, many connectors). A
route resolves the connector for the path, calls :meth:`verify_auth` then
:meth:`handle_request`, and feeds the returned events to the same
correlate→risk→LLM pipeline the poller feeds. ``start``/``stop`` are therefore
lightweight bookkeeping — there is no socket to bind here.
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any

from ...config import Preferences
from ...models import RawEvent
from ..base import AuthField, ConnectorManifest, EmitFn
from ...constants import IngestMode, SourceType
from .common import PayloadReceiver


def _ctype_hint(headers: dict[str, str]) -> str | None:
    """Derive a parser hint from the request's Content-Type header."""
    for key, value in headers.items():
        if key.lower() == "content-type":
            return value
    return None


def _header(headers: dict[str, str], name: str) -> str | None:
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return None


class WebhookReceiver(PayloadReceiver):
    """Generic HTTP(S) push receiver (JSON/NDJSON/CEF/LEEF/GELF/kv).

    Auth modes (config ``auth_mode``):
      * ``none``   — accept anything reachable (use only behind a trusted proxy).
      * ``bearer`` — require ``Authorization: Bearer <token>`` to equal ``token``.
      * ``hmac``   — require an HMAC-SHA256 of the body (hex) in
        ``signature_header`` to match a key derived from ``shared_secret``.

    HEC compatibility: a Splunk-HEC sender ships ``Authorization: Splunk <token>``
    and a ``{"event": ...}`` envelope — use :class:`HECReceiver` for that shape.
    """

    source_type = SourceType.WEBHOOK
    default_hint = None  # auto-detect unless config pins format_hint

    def __init__(self, config: dict[str, Any] | None = None, connector_id: str | None = None) -> None:
        super().__init__(config=config, connector_id=connector_id)
        self._running = False

    # --- manifest ---------------------------------------------------------- #
    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=SourceType.WEBHOOK,
            display_name="Generic Webhook (HTTP push)",
            category="transport",
            description=(
                "Universal HTTP(S) push endpoint. Accepts JSON, NDJSON, CEF, LEEF, "
                "GELF or key=value bodies from any SIEM/EDR/SOAR/cloud service. "
                "Splunk-HEC compatible (see the HEC connector for the HEC envelope)."
            ),
            ingest_modes=[IngestMode.PUSH_HTTP],
            capabilities=["subscribe", "test"],
            setup_help=(
                "## Connect a Webhook (HTTP push)\n"
                "1. **Save the source** — it gets a stable endpoint: `POST "
                "/api/ingest/<source-id>` on this backend's base URL.\n"
                "2. **Authentication** — pick `bearer` (the sender sends "
                "`Authorization: Bearer <token>`) or `hmac` (the sender signs the body "
                "with a shared secret); use `none` ONLY behind a trusted proxy.\n"
                "3. **Set the secret** — after saving, set the bearer token / HMAC secret "
                "via the source's secrets (stored in the secret tier, never echoed).\n"
                "4. **Point your SIEM/EDR/SOAR/cloud service** at the endpoint, sending "
                "JSON / NDJSON / CEF / LEEF / GELF / key=value bodies (auto-detected).\n"
                "_Splunk-HEC senders should use the HEC connector instead._"
            ),
            auth_fields=[
                AuthField(
                    key="auth_mode", label="Authentication", type="select",
                    options=["none", "bearer", "hmac"], default="none",
                    help=("How inbound requests are authenticated. Use 'bearer' or "
                          "'hmac' in production; 'none' only behind a trusted proxy."),
                ),
                AuthField(
                    key="token", label="Bearer token", type="password", secret=True,
                    help="Required when auth=bearer. Sent as 'Authorization: Bearer <token>'.",
                    help_code="Authorization: Bearer <your-token>",
                    help_code_language="bash",
                ),
                AuthField(
                    key="shared_secret", label="HMAC shared secret", type="password", secret=True,
                    help="Required when auth=hmac. Used to sign the request body (HMAC-SHA256).",
                    help_code=(
                        "# hex HMAC-SHA256 of the exact request body, in the signature header:\n"
                        "X-Signature: sha256=$(printf '%s' \"$BODY\" | openssl dgst -sha256 -hmac \"$SECRET\" | awk '{print $2}')"
                    ),
                    help_code_language="bash",
                ),
                AuthField(
                    key="signature_header", label="Signature header", type="string",
                    default="X-Signature",
                    help="Header carrying the hex HMAC-SHA256 of the body (auth=hmac).",
                ),
            ],
            config_fields=[
                AuthField(
                    key="format_hint", label="Body format", type="select",
                    options=["auto", "json", "ndjson", "cef", "leef", "gelf", "kv"],
                    default="auto",
                    help="Pin the body parser; 'auto' sniffs per request (Content-Type aware).",
                ),
                AuthField(
                    key="path", label="URL path", type="string",
                    default="/webhook",
                    help="The path the source POSTs to (relative to the receiver base URL).",
                ),
            ],
            requires_pip=[],  # stdlib only — the FastAPI app already owns the port
        )

    # --- auth -------------------------------------------------------------- #
    def verify_auth(self, headers: dict[str, str], body: bytes, prefs: Preferences | None = None) -> bool:
        """Return True iff the request satisfies the configured auth mode.

        ``headers`` is case-insensitively matched. ``body`` is the exact raw bytes
        (HMAC is computed over them). Constant-time comparison is used for both
        the bearer token and the signature to avoid timing oracles."""
        mode = str(self.config.get("auth_mode", "none")).lower()
        if mode == "none":
            return True
        if mode == "bearer":
            expected = str(self.config.get("token", "") or "")
            if not expected:
                return False
            presented = _header(headers, "Authorization") or ""
            # Accept "Bearer <t>", "Splunk <t>" or a bare token.
            for prefix in ("Bearer ", "bearer ", "Splunk ", "splunk "):
                if presented.startswith(prefix):
                    presented = presented[len(prefix):]
                    break
            return hmac.compare_digest(presented.strip(), expected)
        if mode == "hmac":
            secret = str(self.config.get("shared_secret", "") or "")
            if not secret:
                return False
            header_name = str(self.config.get("signature_header", "X-Signature") or "X-Signature")
            presented = (_header(headers, header_name) or "").strip()
            if not presented:
                return False
            # Tolerate a "sha256=" prefix (GitHub/GitLab style).
            if "=" in presented and presented.split("=", 1)[0].lower() in ("sha256", "hmac-sha256"):
                presented = presented.split("=", 1)[1]
            digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
            return hmac.compare_digest(presented.lower(), digest.lower())
        return False

    # --- the route entrypoint --------------------------------------------- #
    def handle_request(
        self,
        body: bytes,
        headers: dict[str, str] | None = None,
        prefs: Preferences | None = None,
    ) -> list[RawEvent]:
        """Verify auth, parse the body and return normalised events.

        Raises :class:`PermissionError` when auth fails (the route maps it to
        401). Parsing never raises — malformed bodies become best-effort events.
        ``prefs`` is required for normalisation; callers pass the live prefs."""
        headers = headers or {}
        if prefs is None:
            raise ValueError("handle_request requires prefs for OCSF normalisation")
        if not self.verify_auth(headers, body, prefs):
            raise PermissionError("webhook authentication failed")
        payload = self._preprocess(body)
        # The configured hint wins; otherwise fall back to the request Content-Type
        # so a sender that declares 'application/x-ndjson' is parsed correctly even
        # when format_hint is 'auto'.
        hint = self._hint() or _ctype_hint(headers)
        records = self._records_with_hint(payload, hint)
        return self._normalise(records, prefs)

    def _records_with_hint(
        self, payload: bytes | str | dict[str, Any] | list[Any], hint: str | None
    ) -> list[dict[str, Any]]:
        from .formats import records_from_payload

        if isinstance(payload, list):
            return [r if isinstance(r, dict) else {"message": str(r)} for r in payload]
        if isinstance(payload, dict):
            return [payload]
        return records_from_payload(payload, hint=hint)

    def _normalise(self, records: list[dict[str, Any]], prefs: Preferences) -> list[RawEvent]:
        from ...ocsf import generic_to_ocsf

        out: list[RawEvent] = []
        for record in records:
            if not isinstance(record, dict):
                record = {"message": str(record)}
            ev = generic_to_ocsf(
                record, prefs, source_type=self.source_type, connector_id=self.connector_id
            )
            out.append(RawEvent.from_ocsf(ev))
        return out

    def _preprocess(self, body: bytes) -> bytes | str | dict[str, Any] | list[Any]:
        """Hook for subclasses (e.g. HEC) to unwrap an envelope. Default: pass through."""
        return body

    # --- lifecycle (lightweight; the FastAPI app owns the port) ----------- #
    async def start(self, emit: EmitFn, prefs: Preferences) -> None:
        """Register as active. The HTTP route — not this method — receives
        traffic: it calls :meth:`handle_request` then ``emit``. We retain ``emit``
        so a route that only has the connector instance can deliver events."""
        self._emit = emit
        self._prefs = prefs
        self._running = True

    async def stop(self) -> None:
        self._running = False

    async def deliver(self, body: bytes, headers: dict[str, str], prefs: Preferences) -> int:
        """Convenience for a route holding only the started instance: handle +
        emit in one call. Returns the number of events delivered."""
        events = self.handle_request(body, headers, prefs)
        emit = getattr(self, "_emit", None)
        if events and emit is not None:
            await emit(events)
        return len(events)


class HECReceiver(WebhookReceiver):
    """Splunk HTTP Event Collector-compatible receiver.

    HEC senders POST one or more ``{"event": <payload>, "fields": {...},
    "time": <epoch>, "host": ..., "source": ..., "sourcetype": ...}`` envelopes
    (newline-delimited for batches). We unwrap ``event`` (a string or an object),
    merge the indexed ``fields``/``host``/``source``, and normalise the inner
    payload — so an existing HEC pipeline forwards to us with no change."""

    source_type = SourceType.HEC

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        base = WebhookReceiver.manifest()
        return base.model_copy(update={
            "source_type": SourceType.HEC,
            "display_name": "Splunk HEC (HTTP Event Collector)",
            "description": (
                "HEC-compatible endpoint. Accepts the Splunk HEC envelope "
                "({\"event\": ..., \"fields\": {...}, \"time\": ...}); unwraps the "
                "'event' payload and merges indexed fields. Auth via 'Authorization: "
                "Splunk <token>' (bearer mode)."
            ),
        })

    def _preprocess(self, body: bytes) -> list[dict[str, Any]]:
        """Unwrap one or more HEC envelopes into inner generic records."""
        from .formats import _to_text  # local import; stdlib-only helper

        text = _to_text(body).strip()
        if not text:
            return []
        out: list[dict[str, Any]] = []
        # HEC batches are concatenated JSON objects, commonly newline-delimited.
        for chunk in self._iter_json_objects(text):
            out.extend(self._unwrap_envelope(chunk))
        return out or [{"message": text}]

    @staticmethod
    def _iter_json_objects(text: str) -> list[Any]:
        import json

        objs: list[Any] = []
        # Fast path: newline-delimited.
        lines = [ln for ln in text.splitlines() if ln.strip()]
        if len(lines) > 1:
            ok = True
            tmp: list[Any] = []
            for ln in lines:
                try:
                    tmp.append(json.loads(ln))
                except json.JSONDecodeError:
                    ok = False
                    break
            if ok:
                return tmp
        # Whole-document path (single object/array).
        try:
            obj = json.loads(text)
            return obj if isinstance(obj, list) else [obj]
        except json.JSONDecodeError:
            # Concatenated objects without newlines: decode greedily.
            decoder = json.JSONDecoder()
            idx = 0
            n = len(text)
            while idx < n:
                while idx < n and text[idx] in " \t\r\n":
                    idx += 1
                if idx >= n:
                    break
                try:
                    obj, end = decoder.raw_decode(text, idx)
                except json.JSONDecodeError:
                    break
                objs.append(obj)
                idx = end
        return objs or [{"message": text}]

    @staticmethod
    def _unwrap_envelope(chunk: Any) -> list[dict[str, Any]]:
        if not isinstance(chunk, dict):
            return [{"message": chunk if isinstance(chunk, str) else str(chunk)}]
        if "event" not in chunk:
            # Not an HEC envelope — treat the object as the record itself.
            return [chunk]
        event = chunk.get("event")
        record: dict[str, Any]
        if isinstance(event, dict):
            record = dict(event)
        elif isinstance(event, str):
            # The inner event may itself be JSON or a raw line.
            import json

            try:
                inner = json.loads(event)
                record = inner if isinstance(inner, dict) else {"message": event}
            except json.JSONDecodeError:
                record = {"message": event}
        else:
            record = {"message": "" if event is None else str(event)}
        # Merge HEC metadata so generic_to_ocsf can find host/time/severity.
        fields = chunk.get("fields")
        if isinstance(fields, dict):
            for key, value in fields.items():
                record.setdefault(key, value)
        for meta in ("host", "source", "sourcetype", "index"):
            if meta in chunk and meta not in record:
                record[meta] = chunk[meta]
        if "time" in chunk and "timestamp" not in record and "@timestamp" not in record:
            record["timestamp"] = chunk["time"]
        return [record]
