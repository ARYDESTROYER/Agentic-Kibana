"""RAG knowledge-base + operator-memory routes — Round 5 (Coupling-E extraction).

A cohesive slice carved OUT of the ``routes.py`` monolith with **byte-identical
paths, methods, auth dependencies, request/response bodies**. Handlers moved verbatim
(imports re-homed); the router is mounted in ``main.py`` under the SAME ``require_auth``
gate the monolith uses, so ``test_route_auth_coverage`` stays green.

It owns two closely-related surfaces:

* ``/api/rag/*`` — see + manage the RAG corpus the investigator/chat retrieve from
  (stats, list/get/import/delete documents, live retrieval preview).
* ``/api/memory/*`` — durable operator FACTS auto-injected as TRUSTED context into
  both automated investigations and chat.

NON-NEGOTIABLES held: #9 — imported/retrieved corpus text is UNTRUSTED and is fenced
by the RAG layer + rendered plain by the UI; memory NEVER overrides the deterministic
case_manager (it only informs the LLM). Every write is ``rag:manage``/``memory:manage``
gated.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..state import AppState
from .deps import get_state, require_permission

logger = logging.getLogger("tlsoc.api.rag")

router = APIRouter(prefix="/api")


class RagDocumentsResponse(BaseModel):
    """The RAG corpus document-list envelope. Each document is a loose typed dict
    (title/source/chunk_count/…) rendered PLAIN by the UI (#9)."""

    documents: list[dict[str, Any]] = Field(default_factory=list)
    count: int = 0


class MemoryListResponse(BaseModel):
    """The operator-memory list envelope. Each entry is a loose typed dict
    (text/category/tags/source/active/…) rendered PLAIN by the UI (#9)."""

    entries: list[dict[str, Any]] = Field(default_factory=list)
    count: int = 0


# --------------------------------------------------------------------------- #
# RAG knowledge base — see + manage the corpus the investigator/chat retrieve
# from. Imports take effect immediately (same in-process corpus as retrieve()).
#
# These routes use ``state.rag_service`` (NOT the always-real ``state.rag``): while
# demo is engaged it returns the DEMO's isolated shared vector store, so the Knowledge
# page reflects the demo corpus and an import lands in the throwaway store (purged on
# demo disable) rather than surviving into the real corpus. Off demo the property is the
# real RagService — production behaviour is byte-identical.
# --------------------------------------------------------------------------- #
class RagImportRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=512)
    text: str = Field(..., min_length=1)
    source: str = "imported"
    tags: list[str] = Field(default_factory=list)


_RAG_MAX_TEXT = 1_000_000  # ~1MB cap on a single imported document body


@router.get("/rag/stats")
async def rag_stats(state: AppState = Depends(get_state)) -> dict[str, Any]:
    """Corpus stats: total chunks, count by source, embedding model/dim, doc count."""
    return await state.rag_service.rag_stats()


@router.get("/rag/documents", response_model=RagDocumentsResponse)
async def rag_documents(state: AppState = Depends(get_state)) -> dict[str, Any]:
    """List all documents in the RAG corpus (seeds grouped as seed:<source>)."""
    docs = await state.rag_service.list_documents()
    return {"documents": docs, "count": len(docs)}


@router.get("/rag/documents/{document_id}")
async def rag_document(document_id: str, state: AppState = Depends(get_state)) -> dict[str, Any]:
    """A single document + its chunks. 404 if no such document."""
    doc = await state.rag_service.get_document(document_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="document not found")
    return doc


@router.post("/rag/import")
async def rag_import(
    body: RagImportRequest,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
) -> dict[str, Any]:
    """Import a free-text document into the RAG corpus. Chunked + embedded; takes
    effect immediately for retrieval. 400 on empty/oversized text."""
    title = (body.title or "").strip()
    text = body.text or ""
    if not title or not text.strip():
        raise HTTPException(status_code=400, detail="title and text are required")
    if len(text) > _RAG_MAX_TEXT:
        raise HTTPException(status_code=400, detail="text too large (max ~1MB)")
    result = await state.rag_service.import_document(
        title, text, source=(body.source or "imported").strip() or "imported", tags=body.tags
    )
    if not result.get("chunk_count"):
        raise HTTPException(status_code=400, detail="document produced no indexable chunks")
    return result


@router.delete("/rag/documents/{document_id}")
async def rag_delete_document(
    document_id: str,
    force: bool = False,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("rag", "manage")),
) -> dict[str, Any]:
    """Delete an imported document. 404 if missing; 400 if a guarded seed source
    (runbook/mitre/suppression/resolved_case) unless ``?force=true``."""
    result = await state.rag_service.delete_document(document_id, force=force)
    if not result.get("found"):
        raise HTTPException(status_code=404, detail="document not found")
    if result.get("guarded"):
        raise HTTPException(
            status_code=400,
            detail="built-in seed corpus is protected; pass force=true to delete",
        )
    return {"document_id": document_id, "deleted": result.get("deleted", 0)}


@router.get("/rag/search")
async def rag_search(
    q: str,
    top_k: int = 5,
    state: AppState = Depends(get_state),
) -> dict[str, Any]:
    """Run a retrieval against the live corpus and return the chunks RAG would feed
    an investigation — so an operator can SEE what the knowledge base returns."""
    query = (q or "").strip()
    if not query:
        return {"query": "", "chunks": [], "count": 0}
    await state.rag_service.ensure_seeded()
    chunks = await state.rag_service.retrieve(query, top_k=max(1, min(int(top_k or 5), 50)))
    return {
        "query": query,
        "count": len(chunks),
        "chunks": [c.model_dump() for c in chunks],
    }


# --------------------------------------------------------------------------- #
# Operator MEMORY — durable facts the agents remember (auto-injected as TRUSTED
# operator context into BOTH automated investigations and chat). Editing is
# EXPLICIT (here, source="human") or via chat ("remember:"/"forget", source="agent").
# Memory NEVER overrides the deterministic case_manager — it only informs the LLM.
# --------------------------------------------------------------------------- #
class MemoryCreate(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    category: str = ""
    tags: list[str] = Field(default_factory=list)


class MemoryUpdate(BaseModel):
    text: str | None = None
    category: str | None = None
    tags: list[str] | None = None
    active: bool | None = None


@router.get("/memory", response_model=MemoryListResponse)
async def list_memory(
    active_only: bool = False, state: AppState = Depends(get_state)
) -> dict[str, Any]:
    """List operator memory entries (newest first). ``?active_only=true`` hides
    de-activated facts."""
    entries = await state.memory.list(active_only=active_only)
    return {
        "entries": [e.model_dump(mode="json") for e in entries],
        "count": len(entries),
    }


@router.post("/memory")
async def add_memory(
    body: MemoryCreate,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("memory", "manage")),
) -> dict[str, Any]:
    """Add an operator fact (source='human'). Auto-injected into future
    investigations + chat as TRUSTED context."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    entry = await state.memory.add(
        text, category=body.category, tags=body.tags, source="human",
    )
    return entry.model_dump(mode="json")


@router.put("/memory/{entry_id}")
async def update_memory(
    entry_id: str,
    body: MemoryUpdate,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("memory", "manage")),
) -> dict[str, Any]:
    """Edit a memory entry (text/category/tags) or toggle ``active``."""
    updated = await state.memory.update(entry_id, **body.model_dump(exclude_none=True))
    if updated is None:
        raise HTTPException(status_code=404, detail="memory entry not found")
    return updated.model_dump(mode="json")


@router.delete("/memory/{entry_id}")
async def delete_memory(
    entry_id: str,
    state: AppState = Depends(get_state),
    _=Depends(require_permission("memory", "manage")),
) -> dict[str, Any]:
    """Permanently delete a memory entry. 404 if missing."""
    ok = await state.memory.delete(entry_id)
    if not ok:
        raise HTTPException(status_code=404, detail="memory entry not found")
    return {"ok": True, "id": entry_id}
