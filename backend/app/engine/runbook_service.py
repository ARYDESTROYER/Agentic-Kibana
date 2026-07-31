"""Merged bundled + operator-managed Runbook catalog.

The packaged Markdown directory is immutable reference content. Operator additions
are strict-CAS state in :class:`app.stores.runbooks.RunbookStore`. The vector index
is only a derived projection managed by :class:`app.tools.rag.RagService`; none of
this module can alter the deterministic case decision.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..stores.runbooks import (
    RunbookStore,
    RunbookStoreConflict,
    RunbookStoreNotFound,
    RunbookStoreRevisionConflict,
)
from .runbooks import (
    MAX_RUNBOOK_BYTES,
    RUNBOOKS_DIR,
    Runbook,
    RunbookConflictError,
    RunbookManagementError,
    RunbookNotFoundError,
    RunbookProtectedError,
    RunbookRevisionConflictError,
    load_runbooks,
    parse_runbook_document,
    validate_runbook_id,
)

logger = logging.getLogger("tlsoc.engine.runbook_service")


@dataclass(frozen=True)
class ManagedRunbook:
    runbook: Runbook
    content: str
    source_type: str
    protected: bool
    editable: bool
    file_name: str
    revision: int = 1
    created_at: str = ""
    updated_at: str = ""
    created_by: str = ""
    updated_by: str = ""
    index_status: str = "pending"
    indexed_revision: int = 0
    last_indexed_at: str = ""
    index_error: str = ""

    def payload(self, *, include_content: bool = False) -> dict[str, Any]:
        rb = self.runbook
        out: dict[str, Any] = {
            "id": rb.id,
            "title": rb.title,
            "summary": rb.summary,
            "persona": rb.persona,
            "applies_to_rules": list(rb.applies_to_rules),
            "applies_to_techniques": list(rb.applies_to_techniques),
            "applies_to_entities": list(rb.applies_to_entities),
            "keywords": list(rb.keywords),
            "body_characters": len(rb.body),
            "source_type": self.source_type,
            "protected": self.protected,
            "editable": self.editable,
            "file_name": self.file_name,
            "revision": self.revision,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "created_by": self.created_by,
            "updated_by": self.updated_by,
            "index_status": self.index_status,
            "indexed_revision": self.indexed_revision,
            "last_indexed_at": self.last_indexed_at,
            "index_error": self.index_error,
        }
        if include_content:
            out["content"] = self.content
            out["body"] = rb.body
        return out


class RunbookService:
    """Authoritative merged catalog and durable operator CRUD."""

    def __init__(
        self,
        store: RunbookStore,
        *,
        bundled_directory: Path = RUNBOOKS_DIR,
    ) -> None:
        self.store = store
        self._bundled_directory = Path(bundled_directory)

    def _bundled(self) -> list[ManagedRunbook]:
        out: list[ManagedRunbook] = []
        for rb in load_runbooks(self._bundled_directory):
            path = Path(rb.source_path)
            try:
                content = path.read_text(encoding="utf-8")
            except OSError as exc:
                logger.warning("Could not read bundled runbook %s: %s", path.name, exc)
                continue
            if len(content.encode("utf-8")) > MAX_RUNBOOK_BYTES:
                logger.warning("Skipping oversized bundled runbook %s", path.name)
                continue
            out.append(
                ManagedRunbook(
                    runbook=rb,
                    content=content,
                    source_type="bundled",
                    protected=True,
                    editable=False,
                    file_name=path.name,
                    revision=1,
                )
            )
        return out

    async def list(self) -> list[ManagedRunbook]:
        bundled = self._bundled()
        bundled_ids = {record.runbook.id for record in bundled}
        operator = await self.store.list()
        out = list(bundled)
        for runbook_id, row in operator.items():
            if runbook_id in bundled_ids:
                logger.warning(
                    "Ignoring operator runbook %s because a bundled id owns that name",
                    runbook_id,
                )
                continue
            try:
                rb = parse_runbook_document(
                    str(row.get("content") or ""),
                    expected_id=runbook_id,
                    enforce_authoring_standard=False,
                )
            except RunbookManagementError as exc:
                logger.warning("Skipping invalid stored runbook %s: %s", runbook_id, exc)
                continue
            out.append(
                ManagedRunbook(
                    runbook=rb,
                    content=str(row.get("content") or ""),
                    source_type="operator",
                    protected=False,
                    editable=True,
                    file_name=f"{runbook_id}.md",
                    revision=int(row.get("revision", 1) or 1),
                    created_at=str(row.get("created_at") or ""),
                    updated_at=str(row.get("updated_at") or ""),
                    created_by=str(row.get("created_by") or ""),
                    updated_by=str(row.get("updated_by") or ""),
                    index_status=str(row.get("index_status") or "pending"),
                    indexed_revision=int(row.get("indexed_revision", 0) or 0),
                    last_indexed_at=str(row.get("last_indexed_at") or ""),
                    index_error=str(row.get("index_error") or ""),
                )
            )
        out.sort(key=lambda item: (item.runbook.title.lower(), item.runbook.id))
        return out

    async def get(self, runbook_id: str) -> ManagedRunbook:
        validate_runbook_id(runbook_id)
        for record in await self.list():
            if record.runbook.id == runbook_id:
                return record
        raise RunbookNotFoundError(runbook_id)

    async def create(self, runbook_id: str, content: str, *, actor: str) -> ManagedRunbook:
        parse_runbook_document(
            content,
            expected_id=runbook_id,
            enforce_authoring_standard=True,
        )
        runbook_id = validate_runbook_id(runbook_id)
        if any(record.runbook.id == runbook_id for record in self._bundled()):
            raise RunbookConflictError(f"runbook {runbook_id!r} already exists")
        try:
            await self.store.create(runbook_id, content, actor=actor)
        except RunbookStoreConflict as exc:
            raise RunbookConflictError(f"runbook {runbook_id!r} already exists") from exc
        except ValueError as exc:
            raise RunbookManagementError(str(exc)) from exc
        return await self.get(runbook_id)

    async def update(
        self,
        runbook_id: str,
        content: str,
        *,
        actor: str,
        expected_revision: int,
    ) -> ManagedRunbook:
        runbook_id = validate_runbook_id(runbook_id)
        current = await self.get(runbook_id)
        if current.protected:
            raise RunbookProtectedError(f"runbook {runbook_id!r} is bundled and read-only")
        if int(expected_revision) != current.revision:
            raise RunbookRevisionConflictError(
                "runbook changed since it was opened; reload before saving"
            )
        parse_runbook_document(
            content,
            expected_id=runbook_id,
            enforce_authoring_standard=True,
        )
        try:
            await self.store.update(
                runbook_id,
                content,
                actor=actor,
                expected_revision=expected_revision,
            )
        except RunbookStoreNotFound as exc:
            raise RunbookNotFoundError(runbook_id) from exc
        except RunbookStoreRevisionConflict as exc:
            raise RunbookRevisionConflictError(
                "runbook changed since it was opened; reload before saving"
            ) from exc
        except ValueError as exc:
            raise RunbookManagementError(str(exc)) from exc
        return await self.get(runbook_id)

    async def delete(self, runbook_id: str, *, expected_revision: int) -> None:
        runbook_id = validate_runbook_id(runbook_id)
        current = await self.get(runbook_id)
        if current.protected:
            raise RunbookProtectedError(f"runbook {runbook_id!r} is bundled and read-only")
        try:
            await self.store.delete(runbook_id, expected_revision=expected_revision)
        except RunbookStoreNotFound as exc:
            raise RunbookNotFoundError(runbook_id) from exc
        except RunbookStoreRevisionConflict as exc:
            raise RunbookRevisionConflictError(
                "runbook changed since it was opened; reload before deleting"
            ) from exc

    async def corpus_items(self, ids: set[str] | None = None) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        for record in await self.list():
            if ids is not None and record.runbook.id not in ids:
                continue
            items.extend(
                record.runbook.as_corpus_items(
                    revision=record.revision, source_type=record.source_type
                )
            )
        return items

    async def mark_indexed(self, runbook_id: str, revision: int, *, error: str = "") -> None:
        record = await self.store.get(runbook_id)
        if record is not None:
            await self.store.mark_indexed(runbook_id, revision, error=error)

    async def pending_deletes(self) -> list[str]:
        return await self.store.pending_deletes()

    async def mark_delete_projected(self, runbook_id: str) -> None:
        await self.store.mark_delete_projected(runbook_id)
