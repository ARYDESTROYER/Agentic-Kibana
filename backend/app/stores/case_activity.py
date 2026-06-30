"""Per-case ACTIVITY-TIMELINE store — friendly collaboration feed (Round 3).

A case ACTIVITY entry (:class:`app.models.CaseActivity`) is one APPEND-ONLY record
of who-did-what on a case (assigned / commented / reacted / status-changed) for the
human-facing overview. It is DISTINCT from the authoritative ``AuditDoc`` trail
(which stays the source of truth, #2); this is the friendly UI feed. Advisory only —
it NEVER feeds ``case_manager.decide()`` (#3), and every ``summary``/``ref`` value is
plain, render-escaped data (#9).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory`): the WHOLE timeline set is ONE KV document
(``ns=CASE_ACTIVITY_NS``, ``key=CASE_ACTIVITY_KEY``) whose value is
``{"activity": {"<case_id>": [<CaseActivity json>, ...], ...}}`` — so it needs NO new
ES index / SQL table / migration. The SQL backend uses ``SqlKVStore``; the ES backend
uses the thin :class:`app.stores.memory.EsKVStore` adapter.

Append-only by design: there is intentionally NO edit/delete-of-an-entry here (a
recorded activity is immutable, mirroring the audit ethos). Reads + the append are
read-modify-write over the single dict. The store NEVER raises: a failure degrades
to an empty timeline / best-effort write and is logged.
"""

from __future__ import annotations

import logging

from ..constants import CASE_ACTIVITY_KEY, CASE_ACTIVITY_NS
from ..models import CaseActivity
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.case_activity")

# Bound the per-case timeline so one very active case can't bloat the shared doc;
# the OLDEST entries are trimmed (the recent feed is what the overview shows).
_MAX_PER_CASE = 500


def _norm_case_id(case_id: str | None) -> str:
    return (case_id or "").strip()


class CaseActivityStore:
    """Append-only per-case activity timeline, persisted as one KV document.

    The KV value is ``{"activity": {"<case_id>": [<CaseActivity json>, ...]}}``.
    The append is read-modify-write; nothing raises (a failure logs + degrades)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def _load_all(self) -> dict[str, list[CaseActivity]]:
        try:
            doc = await self._kv.get(CASE_ACTIVITY_NS, CASE_ACTIVITY_KEY)
        except Exception as exc:  # noqa: BLE001 — activity is best-effort
            logger.warning("Loading case activity failed (%s); using empty set", exc)
            return {}
        if not doc:
            return {}
        raw = doc.get("activity", {}) if isinstance(doc, dict) else {}
        out: dict[str, list[CaseActivity]] = {}
        for cid, items in (raw or {}).items():
            entries: list[CaseActivity] = []
            for item in items or []:
                try:
                    entries.append(CaseActivity.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt entry, keep the rest
                    continue
            out[str(cid)] = entries
        return out

    async def _save_all(self, timelines: dict[str, list[CaseActivity]]) -> None:
        try:
            await self._kv.put(
                CASE_ACTIVITY_NS, CASE_ACTIVITY_KEY,
                {"activity": {cid: [a.model_dump(mode="json") for a in entries]
                              for cid, entries in timelines.items()}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting case activity failed (%s); continuing", exc)

    async def append(self, activity: CaseActivity) -> CaseActivity:
        """Append one activity entry to its case's timeline (keyed by
        ``activity.case_id``). The caller builds + validates the entry. The OLDEST
        entries past the per-case cap are trimmed. Returns the stored entry."""
        cid = _norm_case_id(activity.case_id)
        if not cid:
            raise ValueError("activity.case_id is required")
        timelines = await self._load_all()
        entries = list(timelines.get(cid, []))
        entries.append(activity)
        if len(entries) > _MAX_PER_CASE:
            entries = entries[-_MAX_PER_CASE:]
        timelines[cid] = entries
        await self._save_all(timelines)
        return activity

    async def list_for_case(self, case_id: str | None, *, newest_first: bool = True,
                            limit: int = 0) -> list[CaseActivity]:
        """The activity timeline for a case (NEWEST first by default — the overview
        feed renders most-recent-first). ``limit`` (>0) bounds the result."""
        cid = _norm_case_id(case_id)
        if not cid:
            return []
        entries = list((await self._load_all()).get(cid, []))
        if newest_first:
            entries = list(reversed(entries))
        if limit and limit > 0:
            entries = entries[:limit]
        return entries

    async def delete_case(self, case_id: str | None) -> bool:
        """Drop an entire case's timeline (e.g. on case purge). Returns True if it
        existed."""
        cid = _norm_case_id(case_id)
        timelines = await self._load_all()
        if cid not in timelines:
            return False
        del timelines[cid]
        await self._save_all(timelines)
        return True
