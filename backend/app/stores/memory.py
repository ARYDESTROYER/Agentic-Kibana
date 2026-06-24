"""Operator MEMORY store — durable facts the agents remember (Claude.ai-style).

A MEMORY is a small TRUSTED operator fact ("10.0.0.0/8 is internal", "Nessus scans
run Sun 02:00 from 10.1.2.3", "bastion01 is a jump box") that is auto-injected into
BOTH automated investigations and chat so the LLM reasons WITH the operator's
knowledge. It NEVER overrides the deterministic case_manager — it only informs.

Backend-agnostic by construction: the whole memory set is ONE JSON list persisted
through the existing :class:`KVStore` abstraction (``ns="memory"``, ``key="entries"``)
— so it needs NO new ES index / SQL table / migration. The SQL backend uses
``SqlKVStore`` (the shared KV table); the ES backend uses the thin
:class:`EsKVStore` adapter below (a doc in the existing config index).

Reads + writes are read-modify-write over the single list — fine at our scale
(operator-authored facts, not log volume). The store NEVER raises: a load/save
failure degrades to an empty list / best-effort write and is logged, so a memory
glitch can never drop an alert or break chat.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import (
    CONFIG_INDEX,
    MEMORY_DOC_ID,
    MEMORY_KEY,
    MEMORY_NS,
    PROPOSALS_DOC_ID,
    PROPOSALS_KEY,
    PROPOSALS_NS,
)
from ..es.base import BaseESClient
from ..models import MemoryEntry
from ..utils import iso_now
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.memory")


class EsKVStore(KVStore):
    """A minimal :class:`KVStore` over an Elasticsearch client.

    The ES OWN-state backend has no generic KV table (config/cursor each call ES
    directly), so this adapter gives MemoryStore the SAME ``get/put`` contract the
    SQL backend already provides. Each (namespace, key) maps to a single doc in the
    existing ``CONFIG_INDEX`` (no new index), keyed ``<namespace>:<key>`` so it
    never collides with the preferences/cursor docs. Never raises."""

    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    @staticmethod
    def _doc_id(namespace: str, key: str) -> str:
        # The memory singleton keeps a stable, readable id; any other ns/key gets a
        # composed id so this adapter is reusable for future KV needs.
        if namespace == MEMORY_NS and key == MEMORY_KEY:
            return MEMORY_DOC_ID
        if namespace == PROPOSALS_NS and key == PROPOSALS_KEY:
            return PROPOSALS_DOC_ID
        return f"{namespace}:{key}"

    async def get(self, namespace: str, key: str) -> dict[str, Any] | None:
        try:
            return await self._es.get_doc(CONFIG_INDEX, self._doc_id(namespace, key))
        except Exception as exc:  # noqa: BLE001 — memory is best-effort
            logger.warning("KV get(%s/%s) failed: %s", namespace, key, exc)
            return None

    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None:
        try:
            await self._es.index_doc(
                CONFIG_INDEX, value, doc_id=self._doc_id(namespace, key), refresh=True
            )
        except Exception as exc:  # noqa: BLE001 — memory is best-effort
            logger.warning("KV put(%s/%s) failed: %s", namespace, key, exc)


class MemoryStore:
    """CRUD over the operator-memory list, persisted as one KV document.

    The KV value is ``{"entries": [<MemoryEntry json>, ...]}``. Methods are
    read-modify-write; none raises (a failure logs + returns a safe default)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def _load(self) -> list[MemoryEntry]:
        try:
            doc = await self._kv.get(MEMORY_NS, MEMORY_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading memory failed (%s); using empty set", exc)
            return []
        if not doc:
            return []
        raw = doc.get("entries", []) if isinstance(doc, dict) else []
        out: list[MemoryEntry] = []
        for item in raw or []:
            try:
                out.append(MemoryEntry.model_validate(item))
            except Exception:  # noqa: BLE001 — skip a single corrupt entry, keep the rest
                continue
        return out

    async def _save(self, entries: list[MemoryEntry]) -> None:
        try:
            await self._kv.put(
                MEMORY_NS, MEMORY_KEY,
                {"entries": [e.model_dump(mode="json") for e in entries]},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting memory failed (%s); continuing", exc)

    async def list(self, active_only: bool = True) -> list[MemoryEntry]:
        entries = await self._load()
        if active_only:
            entries = [e for e in entries if e.active]
        # Newest first so injection picks the most recent facts when bounded.
        return sorted(entries, key=lambda e: e.created_at, reverse=True)

    async def get(self, entry_id: str) -> MemoryEntry | None:
        for e in await self._load():
            if e.id == entry_id:
                return e
        return None

    async def add(
        self,
        text: str,
        category: str = "",
        tags: list[str] | None = None,
        source: str = "human",
        author: str = "",
    ) -> MemoryEntry:
        entry = MemoryEntry(
            text=(text or "").strip(),
            category=(category or "").strip(),
            tags=[str(t).strip() for t in (tags or []) if str(t).strip()],
            source=source if source in ("human", "agent") else "human",
            author=(author or "").strip(),
        )
        entries = await self._load()
        entries.append(entry)
        await self._save(entries)
        return entry

    async def update(self, entry_id: str, **fields: Any) -> MemoryEntry | None:
        entries = await self._load()
        updated: MemoryEntry | None = None
        allowed = {"text", "category", "tags", "active", "source", "author"}
        for idx, e in enumerate(entries):
            if e.id != entry_id:
                continue
            patch = {k: v for k, v in fields.items() if k in allowed and v is not None}
            if "tags" in patch and isinstance(patch["tags"], list):
                patch["tags"] = [str(t).strip() for t in patch["tags"] if str(t).strip()]
            patch["updated_at"] = iso_now()
            updated = e.model_copy(update=patch)
            entries[idx] = updated
            break
        if updated is not None:
            await self._save(entries)
        return updated

    async def delete(self, entry_id: str) -> bool:
        entries = await self._load()
        remaining = [e for e in entries if e.id != entry_id]
        if len(remaining) == len(entries):
            return False
        await self._save(remaining)
        return True

    async def delete_by_text(self, text: str) -> list[MemoryEntry]:
        """Fuzzy 'forget …' helper: delete every entry whose text CONTAINS the given
        phrase (case-insensitive). Returns the removed entries. Used by the chat
        memory_action 'remove' path when no id is supplied."""
        needle = (text or "").strip().lower()
        if not needle:
            return []
        entries = await self._load()
        removed = [e for e in entries if needle in e.text.lower()]
        if not removed:
            return []
        removed_ids = {e.id for e in removed}
        await self._save([e for e in entries if e.id not in removed_ids])
        return removed
