"""Per-case THREAD store — threaded case discussion (Round 3 collaboration).

A case THREAD is the ordered list of :class:`app.models.CaseMessage` for one case
(human + AI + system authors, threaded replies, @mentions, emoji reactions,
edit/delete tombstones). It is the friendly collaboration surface beside the
authoritative ``AuditDoc`` trail — advisory only, it NEVER feeds the deterministic
``case_manager.decide()`` (#3), and every ``body``/``mentions`` value is plain,
render-escaped user input (never an unfenced prompt instruction, #9).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory` / :mod:`app.stores.user_prefs`): the WHOLE thread set is
ONE KV document (``ns=CASE_THREAD_NS``, ``key=CASE_THREAD_KEY``) whose value is
``{"threads": {"<case_id>": [<CaseMessage json>, ...], ...}}`` — so it needs NO new
ES index / SQL table / migration. The SQL backend uses ``SqlKVStore`` (the shared
KV table); the ES backend uses the thin :class:`app.stores.memory.EsKVStore`
adapter (a doc in the existing config index).

Reads + writes are read-modify-write over the single dict — fine at our scale
(operator collaboration, not log volume). The store NEVER raises: a load/save
failure degrades to an empty thread / best-effort write and is logged, so a thread
glitch can never drop an alert or break a case page.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import CASE_THREAD_KEY, CASE_THREAD_NS
from ..models import CaseMessage
from ..utils import iso_now
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.case_thread")


def _norm_case_id(case_id: str | None) -> str:
    return (case_id or "").strip()


class CaseThreadStore:
    """CRUD over per-case message threads, persisted as one KV document.

    The KV value is ``{"threads": {"<case_id>": [<CaseMessage json>, ...]}}``.
    Methods are read-modify-write; none raises (a failure logs + returns a safe
    default). Messages within a case keep insertion order (chronological)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def _load_all(self) -> dict[str, list[CaseMessage]]:
        try:
            doc = await self._kv.get(CASE_THREAD_NS, CASE_THREAD_KEY)
        except Exception as exc:  # noqa: BLE001 — threads are best-effort
            logger.warning("Loading case threads failed (%s); using empty set", exc)
            return {}
        if not doc:
            return {}
        raw = doc.get("threads", {}) if isinstance(doc, dict) else {}
        out: dict[str, list[CaseMessage]] = {}
        for cid, items in (raw or {}).items():
            msgs: list[CaseMessage] = []
            for item in items or []:
                try:
                    msgs.append(CaseMessage.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt message, keep the rest
                    continue
            out[str(cid)] = msgs
        return out

    async def _save_all(self, threads: dict[str, list[CaseMessage]]) -> None:
        try:
            await self._kv.put(
                CASE_THREAD_NS, CASE_THREAD_KEY,
                {"threads": {cid: [m.model_dump(mode="json") for m in msgs]
                             for cid, msgs in threads.items()}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting case threads failed (%s); continuing", exc)

    async def list_for_case(self, case_id: str | None) -> list[CaseMessage]:
        """Every message for a case in insertion (chronological) order — including
        tombstoned (deleted) messages so the UI can render a 'message deleted'
        placeholder; the caller filters if it wants only live messages."""
        cid = _norm_case_id(case_id)
        if not cid:
            return []
        return list((await self._load_all()).get(cid, []))

    async def get(self, case_id: str | None, message_id: str) -> CaseMessage | None:
        for m in await self.list_for_case(case_id):
            if m.id == message_id:
                return m
        return None

    async def append(self, message: CaseMessage) -> CaseMessage:
        """Append a message to its case's thread (keyed by ``message.case_id``).

        The caller builds + validates the :class:`CaseMessage` (body already plain
        data, #9). Returns the stored message."""
        cid = _norm_case_id(message.case_id)
        if not cid:
            raise ValueError("message.case_id is required")
        threads = await self._load_all()
        msgs = list(threads.get(cid, []))
        msgs.append(message)
        threads[cid] = msgs
        await self._save_all(threads)
        return message

    async def edit(self, case_id: str | None, message_id: str, body: str,
                   *, editor: str = "") -> CaseMessage | None:
        """Edit a message body in place (stamps ``edited_at``). Editing a tombstoned
        (deleted) message is a no-op (returns None). ``body`` is plain data (#9)."""
        cid = _norm_case_id(case_id)
        threads = await self._load_all()
        msgs = list(threads.get(cid, []))
        updated: CaseMessage | None = None
        for idx, m in enumerate(msgs):
            if m.id != message_id or m.deleted_at:
                continue
            updated = m.model_copy(update={"body": body or "", "edited_at": iso_now()})
            msgs[idx] = updated
            break
        if updated is not None:
            threads[cid] = msgs
            await self._save_all(threads)
        return updated

    async def delete(self, case_id: str | None, message_id: str) -> CaseMessage | None:
        """Tombstone a message (sets ``deleted_at`` — the row STAYS so threaded
        replies keep their parent and the audit/UI can render 'deleted'). Returns
        the tombstoned message, or None if not found / already deleted."""
        cid = _norm_case_id(case_id)
        threads = await self._load_all()
        msgs = list(threads.get(cid, []))
        updated: CaseMessage | None = None
        for idx, m in enumerate(msgs):
            if m.id != message_id or m.deleted_at:
                continue
            updated = m.model_copy(update={"deleted_at": iso_now(), "body": ""})
            msgs[idx] = updated
            break
        if updated is not None:
            threads[cid] = msgs
            await self._save_all(threads)
        return updated

    async def react(self, case_id: str | None, message_id: str, emoji: str,
                    user: str, *, remove: bool = False) -> CaseMessage | None:
        """Toggle (add unless ``remove``) one ``{emoji, user}`` reaction on a message.

        Adding is idempotent (the same user can't double-react with the same emoji).
        ``emoji``/``user`` are plain data. Returns the updated message, or None."""
        cid = _norm_case_id(case_id)
        emoji = (emoji or "").strip()
        user = (user or "").strip()
        if not emoji:
            return await self.get(case_id, message_id)
        threads = await self._load_all()
        msgs = list(threads.get(cid, []))
        updated: CaseMessage | None = None
        for idx, m in enumerate(msgs):
            if m.id != message_id or m.deleted_at:
                continue
            reactions = [
                r for r in m.reactions
                if not (isinstance(r, dict) and r.get("emoji") == emoji and r.get("user") == user)
            ]
            if not remove:
                reactions.append({"emoji": emoji, "user": user})
            updated = m.model_copy(update={"reactions": reactions})
            msgs[idx] = updated
            break
        if updated is not None:
            threads[cid] = msgs
            await self._save_all(threads)
        return updated

    async def delete_case(self, case_id: str | None) -> bool:
        """Drop an entire case's thread (e.g. on case purge). Returns True if it
        existed."""
        cid = _norm_case_id(case_id)
        threads = await self._load_all()
        if cid not in threads:
            return False
        del threads[cid]
        await self._save_all(threads)
        return True
