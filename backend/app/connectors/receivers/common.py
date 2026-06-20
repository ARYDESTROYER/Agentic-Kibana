"""Shared base for push receivers that normalise *payloads* (bytes/str/dict).

Almost every push transport — webhook, syslog, Kafka, SQS, S3, … — ultimately
hands us an opaque payload (an HTTP body, a syslog datagram, a broker message, an
object's bytes) in one of the common log formats. :class:`PayloadReceiver`
factors out the one normalisation pipeline they all share:

    payload  →  records_from_payload()  →  generic_to_ocsf()  →  RawEvent.from_ocsf()

Concrete receivers only implement the TRANSPORT (``start``/``stop``) and set
``source_type`` + ``manifest``. ``parse`` and ``_emit_payload`` are inherited, so
the engine and unit tests can drive them with raw bytes and no socket/broker.
"""

from __future__ import annotations

from typing import Any

from ...config import Preferences
from ...models import RawEvent
from ...ocsf import generic_to_ocsf
from ..base import EmitFn, PushReceiver
from .formats import records_from_payload


class PayloadReceiver(PushReceiver):
    """A :class:`PushReceiver` whose payloads are parseable log formats.

    Subclasses set ``source_type`` and implement ``manifest``/``start``/``stop``.
    The ``format_hint`` config field (when present) pins the parser; otherwise the
    format is sniffed per payload. Everything is preserved under OCSF ``raw_data``
    so nothing is lost.
    """

    #: Default parser hint; overridden per-instance from config when present.
    default_hint: str | None = None

    def _hint(self) -> str | None:
        """Resolve the format hint for this instance from its config."""
        hint = self.config.get("format_hint") or self.config.get("format")
        if hint in (None, "", "auto"):
            return self.default_hint
        return str(hint)

    def parse(self, payload: bytes | str | dict[str, Any], prefs: Preferences) -> list[RawEvent]:
        """Normalise one pushed payload into a list of :class:`RawEvent`.

        Accepts bytes/str (any supported log format) OR an already-decoded dict /
        list-of-dicts (e.g. a broker that hands back JSON objects). Never raises:
        malformed input becomes a best-effort low-fidelity event so no alert is
        silently dropped (non-negotiable #4 spirit)."""
        records = self._records(payload)
        out: list[RawEvent] = []
        for record in records:
            if not isinstance(record, dict):
                record = {"message": str(record)}
            ev = generic_to_ocsf(
                record,
                prefs,
                source_type=self.source_type,
                connector_id=self.connector_id,
            )
            out.append(RawEvent.from_ocsf(ev))
        return out

    def _records(self, payload: bytes | str | dict[str, Any]) -> list[dict[str, Any]]:
        """Turn a payload into generic dict records (the parsing seam)."""
        if isinstance(payload, dict):
            return [payload]
        if isinstance(payload, list):
            return [r if isinstance(r, dict) else {"message": str(r)} for r in payload]
        return records_from_payload(payload, hint=self._hint())

    async def _emit_payload(
        self,
        payload: bytes | str | dict[str, Any],
        prefs: Preferences,
        emit: EmitFn,
    ) -> int:
        """Normalise ``payload`` and deliver the batch via ``emit``.

        Returns the number of events emitted (0 when the payload yields none, so a
        consume loop can decide whether to commit/ack). Errors in normalisation
        are contained (never raised) so a single bad message can't kill a loop."""
        events = self.parse(payload, prefs)
        if events:
            await emit(events)
        return len(events)
