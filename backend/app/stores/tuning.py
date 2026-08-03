"""Adaptive-threshold TUNING history store (Round 4 / Wave 3).

The nightly deterministic tuner (:mod:`app.engine.threshold_tuner`) records every
threshold change applied through approval or explicit automatic policy here so an
operator can see the before/after and ROLL BACK a single rule with one click. This
store owns ONLY the audit/rollback
ledger — it never writes ``Preferences`` itself (the tuner's config-writer callback
does that); it never touches a case, a verdict, a risk weight, or a cluster
signature.

Backend-agnostic by construction (the same JSON-in-KV pattern as
:mod:`app.stores.user_prefs` / :mod:`app.stores.proposals`): the WHOLE tuning ledger
is ONE KV document (``ns="tuning"``, ``key="tuning"``) persisted through the existing
:class:`KVStore` abstraction — so it needs NO new ES index / SQL table / migration.
The SQL backend uses ``SqlKVStore`` (the shared KV table); the ES backend uses the
thin :class:`app.stores.memory.EsKVStore` adapter (a doc in the existing config
index).

Ordinary observability reads/writes go through the fail-soft :class:`KVStore` API so
a tuning-screen outage cannot break case processing. Automatic threshold writes and
rollback finalisation use the explicit ``*_strict`` methods below: those operations
raise unless the rollback ledger transition is durably confirmed. Both paths use the
same per-key lock + ``_rev`` compare-and-set discipline, so concurrent tuner passes or
manual rollbacks cannot lost-update each other.
"""

from __future__ import annotations

import logging
import asyncio
from typing import Any, Literal

from ..constants import TUNING_KEY, TUNING_NS
from ..utils import iso_now, new_id
from .base import KVStore, kv_mutate_strict

logger = logging.getLogger("tlsoc.stores.tuning")

# The KV key (same namespace) recording the LAST effective tuner run instant, so the
# scheduler can honour the configured cadence and never re-run within the window
# (FINDING #14 — unbounded knob growth from every-tick re-raises).
TUNING_LAST_RUN_KEY = "last_run"

# A tuning record's target kind — which knob was moved.
TuningTarget = Literal["correlation_n", "severity_floor"]


class TuningRecord:
    """One applied (and possibly rolled-back) threshold change.

    Pure data (a thin dict wrapper so the store stays dependency-light and mirrors
    the loose-JSON KV entries the other Round-4 stores use). Fields:

    * ``id``          — stable record id (``tune-…``).
    * ``rule_id``     — the CorrelationRule key OR the ``"<source_id>:<feed_id>"``
                        feed key whose threshold moved (the rollback key).
    * ``target``      — ``correlation_n`` | ``severity_floor``.
    * ``before`` / ``after`` — the prior / new integer threshold value (the rollback
                        restores ``before``).
    * ``fp_rate`` / ``samples`` — the Wilson-LB FP rate + sample count that justified
                        the change (audit provenance).
    * ``applied_at``  — ISO timestamp the change went live.
    * ``rolled_back`` / ``rolled_back_at`` — rollback state.
    * ``rationale``   — a short human-readable why.
    * ``evidence_source`` — independent-label provenance, or
                            ``legacy_unverified`` for pre-provenance records.
    * ``review_proposal_id`` — the approval row that materialised the change, if any.
    """

    __slots__ = (
        "id", "rule_id", "target", "before", "after", "fp_rate", "samples",
        "applied_at", "rolled_back", "rolled_back_at", "rationale",
        "evidence_source", "review_proposal_id",
    )

    def __init__(
        self,
        *,
        rule_id: str,
        target: TuningTarget,
        before: int,
        after: int,
        fp_rate: float = 0.0,
        samples: int = 0,
        rationale: str = "",
        id: str | None = None,
        applied_at: str | None = None,
        rolled_back: bool = False,
        rolled_back_at: str | None = None,
        evidence_source: str = "legacy_unverified",
        review_proposal_id: str | None = None,
    ) -> None:
        self.id = id or new_id("tune-")
        self.rule_id = str(rule_id or "").strip()
        self.target = target
        self.before = int(before)
        self.after = int(after)
        self.fp_rate = float(fp_rate)
        self.samples = int(samples)
        self.rationale = rationale
        self.applied_at = applied_at or iso_now()
        self.rolled_back = bool(rolled_back)
        self.rolled_back_at = rolled_back_at
        self.evidence_source = str(evidence_source or "legacy_unverified")
        self.review_proposal_id = review_proposal_id

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "rule_id": self.rule_id,
            "target": self.target,
            "before": self.before,
            "after": self.after,
            "fp_rate": round(self.fp_rate, 4),
            "samples": self.samples,
            "rationale": self.rationale,
            "applied_at": self.applied_at,
            "rolled_back": self.rolled_back,
            "rolled_back_at": self.rolled_back_at,
            "evidence_source": self.evidence_source,
            "review_proposal_id": self.review_proposal_id,
        }

    @classmethod
    def from_json(cls, raw: dict[str, Any]) -> "TuningRecord":
        return cls(
            id=str(raw.get("id") or "") or None,
            rule_id=str(raw.get("rule_id") or ""),
            target=raw.get("target") or "correlation_n",  # type: ignore[arg-type]
            before=int(raw.get("before") or 0),
            after=int(raw.get("after") or 0),
            fp_rate=float(raw.get("fp_rate") or 0.0),
            samples=int(raw.get("samples") or 0),
            rationale=str(raw.get("rationale") or ""),
            applied_at=str(raw.get("applied_at") or "") or None,
            rolled_back=bool(raw.get("rolled_back") or False),
            rolled_back_at=raw.get("rolled_back_at"),
            evidence_source=str(raw.get("evidence_source") or "legacy_unverified"),
            review_proposal_id=(str(raw.get("review_proposal_id") or "") or None),
        )


class TuningStore:
    """CRUD over the tuning ledger, persisted as one KV document.

    The KV value is ``{"entries": [<TuningRecord json>, ...]}``. Reads never raise
    (a failure logs + returns an empty list); writes go through the CAS ``mutate``
    helper so concurrent passes are safe."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._approval_lock = asyncio.Lock()

    async def _load_strict(self) -> list[TuningRecord]:
        """Load the ledger or raise when persistence is unavailable.

        Operational tuning remains fail-open through :meth:`_load`; evidence reports
        use this strict projection so a backend failure cannot look like "no changes".
        """
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(TUNING_NS, TUNING_KEY)
        if doc is None:
            return []
        if not isinstance(doc, dict):
            raise ValueError("tuning ledger is not a JSON object")
        raw = doc.get("entries", [])
        if not isinstance(raw, list):
            raise ValueError("tuning ledger entries are not a list")
        try:
            return [TuningRecord.from_json(item) for item in raw]
        except Exception as exc:  # noqa: BLE001 — strict evidence reads fail closed
            raise ValueError("tuning ledger contains an invalid entry") from exc

    async def _load(self) -> list[TuningRecord]:
        try:
            return await self._load_strict()
        except Exception as exc:  # noqa: BLE001 — the ledger is best-effort
            logger.warning("Loading tuning ledger failed (%s); using empty set", exc)
            return []

    @staticmethod
    def _filter_entries(
        entries: list[TuningRecord],
        *,
        rule_id: str | None,
        active_only: bool,
    ) -> list[TuningRecord]:
        if rule_id is not None:
            normalised = str(rule_id or "").strip()
            entries = [e for e in entries if str(e.rule_id or "").strip() == normalised]
        if active_only:
            entries = [e for e in entries if not e.rolled_back]
        return sorted(entries, key=lambda e: e.applied_at, reverse=True)

    async def list(self, *, rule_id: str | None = None, active_only: bool = False) -> list[TuningRecord]:
        """All tuning records, NEWEST first. Optionally scoped to one ``rule_id`` and/or
        only the not-yet-rolled-back ones (``active_only``)."""
        return self._filter_entries(
            await self._load(), rule_id=rule_id, active_only=active_only
        )

    async def list_strict(
        self, *, rule_id: str | None = None, active_only: bool = False
    ) -> list[TuningRecord]:
        """Newest-first records, raising when ledger availability is unknown."""
        return self._filter_entries(
            await self._load_strict(), rule_id=rule_id, active_only=active_only
        )

    async def get(self, record_id: str) -> TuningRecord | None:
        for e in await self._load():
            if e.id == record_id:
                return e
        return None

    async def get_strict(self, record_id: str) -> TuningRecord | None:
        """Return one record, raising when ledger availability is unknown."""
        for entry in await self._load_strict():
            if entry.id == record_id:
                return entry
        return None

    async def latest_active(self, rule_id: str, target: TuningTarget) -> TuningRecord | None:
        """The most recent NOT-rolled-back record for a rule+target — the one a
        rollback restores. Used by the tuner to find the current baseline / avoid
        re-tuning a knob it already moved."""
        recs = [
            e for e in await self._load()
            if str(e.rule_id or "").strip() == str(rule_id or "").strip()
            and e.target == target and not e.rolled_back
        ]
        if not recs:
            return None
        return max(recs, key=lambda e: e.applied_at)

    async def add(self, record: TuningRecord) -> TuningRecord:
        """Append one applied change to the ledger (CAS-safe)."""
        def _mutate(cur: dict[str, Any] | None) -> dict[str, Any]:
            entries = list((cur or {}).get("entries", []) or [])
            entries.append(record.to_json())
            return {"entries": entries}

        try:
            await self._kv.mutate(TUNING_NS, TUNING_KEY, _mutate)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting tuning record failed (%s); continuing", exc)
        return record

    async def add_many_strict(
        self, records: list[TuningRecord]
    ) -> list[TuningRecord]:
        """Persist automatic-apply ledger rows atomically and idempotently.

        ``TuningRecord.id`` is the retry key. Every supplied row is appended in one
        strict KV transition, or the call raises and no success may be reported. An
        existing byte-equivalent row is accepted as a retry; reusing an id for
        different provenance fails closed.
        """
        if not records:
            return []
        ids = [str(record.id or "").strip() for record in records]
        if any(not record_id for record_id in ids) or len(set(ids)) != len(ids):
            raise ValueError("automatic tuning record ids must be unique and non-empty")
        requested = {record.id: record for record in records}

        def _append_once(cur: dict[str, Any] | None) -> dict[str, Any]:
            entries = list((cur or {}).get("entries", []) or [])
            existing: dict[str, dict[str, Any]] = {
                str(raw.get("id") or ""): raw
                for raw in entries
                if isinstance(raw, dict) and raw.get("id")
            }
            for record_id, record in requested.items():
                raw = existing.get(record_id)
                if raw is not None:
                    if TuningRecord.from_json(raw).to_json() != record.to_json():
                        raise ValueError(
                            f"tuning record id {record_id!r} already has different provenance"
                        )
                    continue
                entries.append(record.to_json())
            return {"entries": entries}

        await kv_mutate_strict(
            self._kv,
            TUNING_NS,
            TUNING_KEY,
            _append_once,
            lock=self._approval_lock,
        )
        return records

    async def add_approved_proposal_strict(
        self, record: TuningRecord
    ) -> tuple[TuningRecord, bool]:
        """Persist an approval ledger row exactly once or raise.

        ``review_proposal_id`` is the stable idempotency key across a replay after
        proposal finalisation failed. The returned bool is true only for a new row.
        """
        proposal_id = str(record.review_proposal_id or "").strip()
        if not proposal_id:
            raise ValueError("review_proposal_id is required")
        selected: dict[str, Any] = {"record": record, "created": True}

        def _append_once(cur: dict[str, Any] | None) -> dict[str, Any]:
            entries = list((cur or {}).get("entries", []) or [])
            for raw in entries:
                if not isinstance(raw, dict):
                    continue
                if str(raw.get("review_proposal_id") or "") == proposal_id:
                    selected["record"] = TuningRecord.from_json(raw)
                    selected["created"] = False
                    return {"entries": entries}
            entries.append(record.to_json())
            selected["record"] = record
            selected["created"] = True
            return {"entries": entries}

        await kv_mutate_strict(
            self._kv,
            TUNING_NS,
            TUNING_KEY,
            _append_once,
            lock=self._approval_lock,
        )
        return selected["record"], bool(selected["created"])

    async def get_last_run_at(self) -> str | None:
        """The ISO instant of the last effective tuner run, or None if never run. Used
        by the scheduler to honour the cadence window (FINDING #14). Never raises."""
        try:
            doc = await self._kv.get(TUNING_NS, TUNING_LAST_RUN_KEY)
        except Exception as exc:  # noqa: BLE001 — best-effort; treat as "never ran"
            logger.warning("Loading tuner last_run failed (%s); treating as never-ran", exc)
            return None
        if not isinstance(doc, dict):
            return None
        ts = doc.get("at")
        return str(ts) if ts else None

    async def set_last_run_at(self, at: str | None = None) -> None:
        """Stamp the last effective tuner run instant (defaults to now). CAS-safe.
        Best-effort — a failure only means the cadence gate may allow one extra run."""
        try:
            await self.set_last_run_at_strict(at)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting tuner last_run failed (%s); continuing", exc)

    async def set_last_run_at_strict(self, at: str | None = None) -> None:
        """Persist the scheduler success anchor or raise.

        The background worker uses this boundary so a failed cadence stamp is visible
        as unhealthy and retried rather than being reported as a completed pass.
        """
        stamp = at or iso_now()

        def _mutate(_cur: dict[str, Any] | None) -> dict[str, Any]:
            return {"at": stamp}

        await kv_mutate_strict(
            self._kv,
            TUNING_NS,
            TUNING_LAST_RUN_KEY,
            _mutate,
            lock=self._approval_lock,
        )

    async def mark_rolled_back(self, record_id: str) -> TuningRecord | None:
        """Flag a record rolled-back (CAS-safe). Returns the updated record, or None
        for an unknown / already-rolled-back id."""
        try:
            return await self.mark_rolled_back_strict(record_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Marking tuning record rolled-back failed (%s); continuing", exc)
            return None

    async def mark_rolled_back_strict(self, record_id: str) -> TuningRecord | None:
        """Durably finalise one rollback, or raise when persistence is uncertain."""
        result: dict[str, TuningRecord | None] = {"rec": None}

        def _mutate(cur: dict[str, Any] | None) -> dict[str, Any]:
            entries = list((cur or {}).get("entries", []) or [])
            for idx, raw in enumerate(entries):
                if isinstance(raw, dict) and raw.get("id") == record_id and not raw.get("rolled_back"):
                    updated = dict(raw)
                    updated["rolled_back"] = True
                    updated["rolled_back_at"] = iso_now()
                    entries[idx] = updated
                    result["rec"] = TuningRecord.from_json(updated)
                    break
            return {"entries": entries}

        await kv_mutate_strict(
            self._kv,
            TUNING_NS,
            TUNING_KEY,
            _mutate,
            lock=self._approval_lock,
        )
        return result["rec"]
