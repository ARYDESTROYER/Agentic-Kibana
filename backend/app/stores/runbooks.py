"""Durable operator-authored runbook Markdown.

Bundled reference runbooks continue to ship as files under ``app/runbooks``. This
store owns only the operator-created layer and persists it through the existing
backend-agnostic KV abstraction, so Elasticsearch, PostgreSQL, and SQLite require
no new index/table/migration. Writes use the strict CAS path: a successful API
response means the Markdown was durably stored, including across backend replicas.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from ..constants import RUNBOOKS_KEY, RUNBOOKS_NS
from ..utils import iso_now
from .base import KVStore, kv_mutate_strict

_T = TypeVar("_T")

MAX_OPERATOR_RUNBOOKS = 100
MAX_OPERATOR_RUNBOOK_BYTES = 8 * 1024 * 1024


class RunbookStoreConflict(ValueError):
    """An operator runbook with the requested id already exists."""


class RunbookStoreNotFound(KeyError):
    """The requested operator runbook does not exist."""


class RunbookStoreRevisionConflict(ValueError):
    """The caller edited an older revision and must reload before replacing it."""


class RunbookStore:
    """Strict CRUD over one org-scoped ``id -> Markdown`` KV document."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode(doc: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
        raw = doc.get("documents", {}) if isinstance(doc, dict) else {}
        out: dict[str, dict[str, Any]] = {}
        for runbook_id, value in (raw or {}).items():
            if not isinstance(value, dict):
                continue
            content = value.get("content")
            if not isinstance(content, str) or not content.strip():
                continue
            key = str(runbook_id or "").strip()
            if not key:
                continue
            out[key] = {
                "content": content,
                "revision": max(1, int(value.get("revision", 1) or 1)),
                "created_at": str(value.get("created_at") or ""),
                "updated_at": str(value.get("updated_at") or ""),
                "created_by": str(value.get("created_by") or ""),
                "updated_by": str(value.get("updated_by") or ""),
                "index_status": str(value.get("index_status") or "pending"),
                "indexed_revision": max(0, int(value.get("indexed_revision", 0) or 0)),
                "last_indexed_at": str(value.get("last_indexed_at") or ""),
                "index_error": str(value.get("index_error") or ""),
            }
        return out

    @staticmethod
    def _encode(
        documents: dict[str, dict[str, Any]], pending_deletes: list[str]
    ) -> dict[str, Any]:
        return {"documents": documents, "pending_deletes": sorted(set(pending_deletes))}

    async def _load_document(self) -> dict[str, Any]:
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        raw = await getter(RUNBOOKS_NS, RUNBOOKS_KEY)
        return {
            "documents": self._decode(raw),
            "pending_deletes": [
                str(value)
                for value in ((raw or {}).get("pending_deletes", []) if isinstance(raw, dict) else [])
                if str(value or "").strip()
            ],
        }

    async def _mutate(
        self,
        change: Callable[[dict[str, dict[str, Any]], list[str]], _T],
    ) -> _T:
        result: dict[str, _T] = {}

        def _change(current: dict[str, Any] | None) -> dict[str, Any]:
            documents = self._decode(current)
            pending = [
                str(value)
                for value in ((current or {}).get("pending_deletes", []) if isinstance(current, dict) else [])
                if str(value or "").strip()
            ]
            result["value"] = change(documents, pending)
            return self._encode(documents, pending)

        await kv_mutate_strict(
            self._kv,
            RUNBOOKS_NS,
            RUNBOOKS_KEY,
            _change,
            lock=self._lock,
        )
        return result["value"]

    async def list(self) -> dict[str, dict[str, Any]]:
        return dict((await self._load_document())["documents"])

    async def get(self, runbook_id: str) -> dict[str, Any] | None:
        return (await self.list()).get(runbook_id)

    async def pending_deletes(self) -> list[str]:
        return list((await self._load_document())["pending_deletes"])

    async def create(self, runbook_id: str, content: str, *, actor: str) -> dict[str, Any]:
        now = iso_now()

        def _create(
            documents: dict[str, dict[str, Any]], pending: list[str]
        ) -> dict[str, Any]:
            if runbook_id in documents:
                raise RunbookStoreConflict(runbook_id)
            if len(documents) >= MAX_OPERATOR_RUNBOOKS:
                raise ValueError(
                    f"operator runbook limit reached ({MAX_OPERATOR_RUNBOOKS})"
                )
            aggregate = sum(len(str(row.get("content") or "").encode("utf-8")) for row in documents.values())
            if aggregate + len(content.encode("utf-8")) > MAX_OPERATOR_RUNBOOK_BYTES:
                raise ValueError("operator runbook catalog exceeds the 8 MiB limit")
            row = {
                "content": content,
                "revision": 1,
                "created_at": now,
                "updated_at": now,
                "created_by": actor,
                "updated_by": actor,
                "index_status": "pending",
                "indexed_revision": 0,
                "last_indexed_at": "",
                "index_error": "",
            }
            documents[runbook_id] = row
            if runbook_id in pending:
                pending.remove(runbook_id)
            return dict(row)

        return await self._mutate(_create)

    async def update(
        self,
        runbook_id: str,
        content: str,
        *,
        actor: str,
        expected_revision: int,
    ) -> dict[str, Any]:
        now = iso_now()

        def _update(
            documents: dict[str, dict[str, Any]], _pending: list[str]
        ) -> dict[str, Any]:
            current = documents.get(runbook_id)
            if current is None:
                raise RunbookStoreNotFound(runbook_id)
            current_revision = int(current.get("revision", 1) or 1)
            if int(expected_revision) != current_revision:
                raise RunbookStoreRevisionConflict(runbook_id)
            aggregate = sum(
                len(str(row.get("content") or "").encode("utf-8"))
                for key, row in documents.items()
                if key != runbook_id
            )
            if aggregate + len(content.encode("utf-8")) > MAX_OPERATOR_RUNBOOK_BYTES:
                raise ValueError("operator runbook catalog exceeds the 8 MiB limit")
            row = {
                "content": content,
                "revision": current_revision + 1,
                "created_at": current.get("created_at") or now,
                "updated_at": now,
                "created_by": current.get("created_by") or actor,
                "updated_by": actor,
                "index_status": "stale",
                "indexed_revision": int(current.get("indexed_revision", 0) or 0),
                "last_indexed_at": str(current.get("last_indexed_at") or ""),
                "index_error": "",
            }
            documents[runbook_id] = row
            return dict(row)

        return await self._mutate(_update)

    async def delete(self, runbook_id: str, *, expected_revision: int) -> bool:
        def _delete(
            documents: dict[str, dict[str, Any]], pending: list[str]
        ) -> bool:
            current = documents.get(runbook_id)
            if current is None:
                raise RunbookStoreNotFound(runbook_id)
            if int(expected_revision) != int(current.get("revision", 1) or 1):
                raise RunbookStoreRevisionConflict(runbook_id)
            documents.pop(runbook_id, None)
            if runbook_id not in pending:
                pending.append(runbook_id)
            return True

        return await self._mutate(_delete)

    async def mark_indexed(
        self,
        runbook_id: str,
        revision: int,
        *,
        error: str = "",
    ) -> None:
        now = iso_now()

        def _mark(
            documents: dict[str, dict[str, Any]], _pending: list[str]
        ) -> None:
            current = documents.get(runbook_id)
            if current is None or int(current.get("revision", 1) or 1) != int(revision):
                return
            current["index_status"] = "failed" if error else "ready"
            current["index_error"] = error[:500]
            if not error:
                current["indexed_revision"] = int(revision)
                current["last_indexed_at"] = now

        await self._mutate(_mark)

    async def mark_delete_projected(self, runbook_id: str) -> None:
        def _mark(
            _documents: dict[str, dict[str, Any]], pending: list[str]
        ) -> None:
            while runbook_id in pending:
                pending.remove(runbook_id)

        await self._mutate(_mark)
