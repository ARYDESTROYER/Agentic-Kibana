"""Durable operator-authored playbook Markdown.

Bundled playbooks remain immutable package data. This store owns only the
operator layer and uses the existing strict-CAS KV abstraction, so a successful
management response means the document is durable on Elasticsearch, PostgreSQL,
or SQLite without a new table/index migration.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from ..constants import PLAYBOOKS_KEY, PLAYBOOKS_NS
from ..utils import iso_now
from .base import KVStore, kv_mutate_strict

_T = TypeVar("_T")

MAX_OPERATOR_PLAYBOOKS = 100
MAX_OPERATOR_PLAYBOOK_BYTES = 2 * 1024 * 1024


class PlaybookStoreConflict(ValueError):
    pass


class PlaybookStoreNotFound(KeyError):
    pass


class PlaybookStoreRevisionConflict(ValueError):
    pass


class PlaybookStore:
    """Strict CRUD over one org-scoped ``id -> Markdown`` KV document."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode(doc: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
        raw = doc.get("documents", {}) if isinstance(doc, dict) else {}
        out: dict[str, dict[str, Any]] = {}
        for playbook_id, value in (raw or {}).items():
            if not isinstance(value, dict):
                continue
            content = value.get("content")
            key = str(playbook_id or "").strip()
            if not key or not isinstance(content, str) or not content.strip():
                continue
            out[key] = {
                "content": content,
                "revision": max(1, int(value.get("revision", 1) or 1)),
                "created_at": str(value.get("created_at") or ""),
                "updated_at": str(value.get("updated_at") or ""),
                "created_by": str(value.get("created_by") or ""),
                "updated_by": str(value.get("updated_by") or ""),
            }
        return out

    @staticmethod
    def _decode_strict(doc: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
        """Decode the complete catalog before any strict CAS rewrite.

        A malformed sibling is evidence of corruption or a forward-version row;
        silently skipping it and saving the remaining projection would destroy
        data. Unknown fields on valid rows are preserved verbatim.
        """
        if doc is None:
            return {}
        if not isinstance(doc, dict):
            raise ValueError("operator playbook catalog is not a JSON object")
        raw = doc.get("documents", {})
        if not isinstance(raw, dict):
            raise ValueError("operator playbook documents are not a JSON object")
        out: dict[str, dict[str, Any]] = {}
        for playbook_id, value in raw.items():
            if (
                not isinstance(playbook_id, str)
                or not playbook_id
                or playbook_id.strip() != playbook_id
                or not isinstance(value, dict)
            ):
                raise ValueError("operator playbook catalog contains an invalid document")
            content = value.get("content")
            if not isinstance(content, str) or not content.strip():
                raise ValueError("operator playbook catalog contains an invalid document")
            try:
                revision = max(1, int(value.get("revision", 1) or 1))
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    "operator playbook catalog contains an invalid document"
                ) from exc
            row = dict(value)
            row.update({
                "content": content,
                "revision": revision,
                "created_at": str(value.get("created_at") or ""),
                "updated_at": str(value.get("updated_at") or ""),
                "created_by": str(value.get("created_by") or ""),
                "updated_by": str(value.get("updated_by") or ""),
            })
            out[playbook_id] = row
        return out

    @staticmethod
    def _encode(documents: dict[str, dict[str, Any]]) -> dict[str, Any]:
        return {"documents": documents}

    async def _load(self) -> dict[str, dict[str, Any]]:
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        return self._decode(await getter(PLAYBOOKS_NS, PLAYBOOKS_KEY))

    async def _mutate(
        self, change: Callable[[dict[str, dict[str, Any]]], _T]
    ) -> _T:
        result: dict[str, _T] = {}

        def _change(current: dict[str, Any] | None) -> dict[str, Any]:
            documents = self._decode_strict(current)
            result["value"] = change(documents)
            updated = dict(current or {})
            updated.update(self._encode(documents))
            return updated

        await kv_mutate_strict(
            self._kv, PLAYBOOKS_NS, PLAYBOOKS_KEY, _change, lock=self._lock
        )
        return result["value"]

    async def list(self) -> dict[str, dict[str, Any]]:
        return dict(await self._load())

    async def list_strict(self) -> dict[str, dict[str, Any]]:
        """Return the complete catalog or fail instead of dropping damaged rows."""
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        return dict(self._decode_strict(await getter(PLAYBOOKS_NS, PLAYBOOKS_KEY)))

    async def get(self, playbook_id: str) -> dict[str, Any] | None:
        return (await self._load()).get(playbook_id)

    async def create(self, playbook_id: str, content: str, *, actor: str) -> dict[str, Any]:
        now = iso_now()

        def _create(documents: dict[str, dict[str, Any]]) -> dict[str, Any]:
            if playbook_id in documents:
                raise PlaybookStoreConflict(playbook_id)
            if len(documents) >= MAX_OPERATOR_PLAYBOOKS:
                raise ValueError(f"operator playbook limit reached ({MAX_OPERATOR_PLAYBOOKS})")
            aggregate = sum(
                len(str(row.get("content") or "").encode("utf-8"))
                for row in documents.values()
            )
            if aggregate + len(content.encode("utf-8")) > MAX_OPERATOR_PLAYBOOK_BYTES:
                raise ValueError("operator playbook catalog exceeds the 2 MiB limit")
            row = {
                "content": content,
                "revision": 1,
                "created_at": now,
                "updated_at": now,
                "created_by": actor,
                "updated_by": actor,
            }
            documents[playbook_id] = row
            return dict(row)

        return await self._mutate(_create)

    async def update(
        self,
        playbook_id: str,
        content: str,
        *,
        actor: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        now = iso_now()

        def _update(documents: dict[str, dict[str, Any]]) -> dict[str, Any]:
            current = documents.get(playbook_id)
            if current is None:
                raise PlaybookStoreNotFound(playbook_id)
            revision = int(current.get("revision", 1) or 1)
            if int(expected_revision) != revision:
                raise PlaybookStoreRevisionConflict(playbook_id)
            aggregate = sum(
                len(str(row.get("content") or "").encode("utf-8"))
                for key, row in documents.items()
                if key != playbook_id
            )
            if aggregate + len(content.encode("utf-8")) > MAX_OPERATOR_PLAYBOOK_BYTES:
                raise ValueError("operator playbook catalog exceeds the 2 MiB limit")
            row = {
                "content": content,
                "revision": revision + 1,
                "created_at": current.get("created_at") or now,
                "updated_at": now,
                "created_by": current.get("created_by") or actor,
                "updated_by": actor,
            }
            documents[playbook_id] = row
            return dict(row)

        return await self._mutate(_update)
