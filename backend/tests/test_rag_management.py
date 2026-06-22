"""RAG knowledge-base management tests — offline (mock/hash embeddings, fake ES,
SQLite). Covers: chunking, import → list → get → search → delete, seed-source
delete guard, stats, and ABC smoke on ESVectorStore + SqlVectorStore."""

from __future__ import annotations

import pytest
import pytest_asyncio

from app.config import Preferences, Secrets
from app.engine.chunking import chunk_text
from app.es.fake import InMemoryESClient
from app.llm.gateway import LLMGateway
from app.llm.providers import MockProvider
from app.stores.sql import SqlVectorStore, build_async_engine, create_all
from app.stores.usage import UsageStore
from app.tools.rag import RagService
from app.tools.vectorstore import ESVectorStore, InMemoryVectorStore, StoredChunk


def _gateway() -> LLMGateway:
    secrets = Secrets(_env_file=None)  # type: ignore[call-arg]
    usage = UsageStore(InMemoryESClient())
    mock = MockProvider()
    return LLMGateway(secrets, usage, provider_overrides={"openai": mock, "mock": mock})


# --------------------------------------------------------------------------- #
# Chunker
# --------------------------------------------------------------------------- #
def test_chunk_text_basic() -> None:
    assert chunk_text("") == []
    assert chunk_text("   \n  \n ") == []
    one = chunk_text("a short note")
    assert one == ["a short note"]


def test_chunk_text_packs_and_splits() -> None:
    # Three paragraphs that exceed a small target should yield multiple chunks.
    paras = "\n\n".join("word " * 80 for _ in range(4))
    chunks = chunk_text(paras, target_chars=300, overlap=20)
    assert len(chunks) > 1
    assert all(c.strip() for c in chunks)
    # A single monster paragraph is hard-split, not dropped.
    monster = "x" * 5000
    mc = chunk_text(monster, target_chars=400)
    assert len(mc) >= 10
    assert "".join(mc).count("x") >= 4000  # nothing lost (overlap aside)


# --------------------------------------------------------------------------- #
# Full lifecycle on the default InMemory store
# --------------------------------------------------------------------------- #
DOC_TEXT = (
    "Cobalt Strike beacon detection runbook.\n\n"
    "A Cobalt Strike beacon performs periodic HTTP/HTTPS check-ins to its team "
    "server, often with jittered intervals and a named-pipe payload. Look for "
    "regular outbound connections to a rare destination, unusual user-agents, and "
    "default malleable C2 profile artefacts.\n\n"
    "Containment: isolate the host, capture memory, and block the C2 IP at the "
    "perimeter. Hunt for lateral movement via SMB named pipes."
)


async def test_import_list_get_search_delete_lifecycle() -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()

    base_stats = await rag.rag_stats()
    base_total = base_stats["total_chunks"]
    base_docs = base_stats["document_count"]
    assert base_total > 0  # seeds present

    # IMPORT
    result = await rag.import_document(
        "Cobalt Strike Beacon", DOC_TEXT, source="imported", tags=["c2", "malware"]
    )
    assert result["chunk_count"] >= 1
    document_id = result["document_id"]
    assert document_id.startswith("imported:cobalt-strike-beacon:")

    # LIST shows it
    docs = await rag.list_documents()
    ours = [d for d in docs if d["document_id"] == document_id]
    assert ours, "imported document must appear in list_documents"
    assert ours[0]["title"] == "Cobalt Strike Beacon"
    assert ours[0]["chunk_count"] == result["chunk_count"]
    # Seeds remain visible (grouped under seed:<source>).
    assert any(d["document_id"].startswith("seed:") for d in docs)

    # GET returns chunks
    doc = await rag.get_document(document_id)
    assert doc is not None
    assert doc["chunk_count"] == result["chunk_count"]
    assert len(doc["chunks"]) == result["chunk_count"]
    assert doc["tags"] == ["c2", "malware"]
    assert all("cobalt" in c["text"].lower() or len(c["text"]) > 0 for c in doc["chunks"])

    # SEARCH — the import immediately affects retrieve()
    chunks = await rag.retrieve("cobalt strike beacon c2 named pipe", top_k=5)
    blob = " ".join(c.text.lower() for c in chunks)
    assert "cobalt" in blob or "beacon" in blob, "imported doc should be retrievable"

    # STATS reflect the added chunks
    after = await rag.rag_stats()
    assert after["total_chunks"] == base_total + result["chunk_count"]
    assert after["document_count"] == base_docs + 1
    assert after["by_source"].get("imported") == result["chunk_count"]

    # DELETE removes it
    deleted = await rag.delete_document(document_id)
    assert deleted["found"] is True
    assert deleted["guarded"] is False
    assert deleted["deleted"] == result["chunk_count"]

    # gone from list + stats
    docs2 = await rag.list_documents()
    assert not any(d["document_id"] == document_id for d in docs2)
    final = await rag.rag_stats()
    assert final["total_chunks"] == base_total


async def test_delete_missing_document() -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()
    res = await rag.delete_document("imported:does-not-exist:00000000")
    assert res["found"] is False
    assert res["deleted"] == 0


async def test_seed_source_delete_is_guarded() -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()
    # Seeds are grouped as seed:<source>; pick a present one.
    docs = await rag.list_documents()
    seed = next(d for d in docs if d["document_id"].startswith("seed:"))
    res = await rag.delete_document(seed["document_id"])
    assert res["guarded"] is True
    assert res["found"] is True
    assert res["deleted"] == 0
    # Still present after the guarded refusal.
    docs_after = await rag.list_documents()
    assert any(d["document_id"] == seed["document_id"] for d in docs_after)
    # force=True overrides the guard.
    forced = await rag.delete_document(seed["document_id"], force=True)
    assert forced["deleted"] >= 1


async def test_import_empty_text_returns_zero() -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()
    res = await rag.import_document("Empty", "   \n  ")
    assert res["chunk_count"] == 0
    assert res["document_id"] == ""


# --------------------------------------------------------------------------- #
# ABC method smoke: ESVectorStore + SqlVectorStore expose the management methods
# --------------------------------------------------------------------------- #
def test_management_methods_exist_on_all_stores() -> None:
    for cls in (InMemoryVectorStore, ESVectorStore, SqlVectorStore):
        for m in ("list_documents", "list_chunks", "delete_document", "stats"):
            assert callable(getattr(cls, m, None)), f"{cls.__name__} missing {m}"


async def test_es_vector_store_document_management() -> None:
    es = InMemoryESClient()
    store = ESVectorStore(es)
    md = {"document_id": "imported:x:abcd1234", "title": "X", "chunk_index": 0, "n_chunks": 2}
    await store.add(
        [
            StoredChunk(
                text="alpha one", source="imported", embedding=[1.0, 0.0], dim=2,
                embedding_model="m", doc_id="imported:x:abcd1234:0",
                metadata={**md, "chunk_index": 0},
            ),
            StoredChunk(
                text="alpha two", source="imported", embedding=[0.0, 1.0], dim=2,
                embedding_model="m", doc_id="imported:x:abcd1234:1",
                metadata={**md, "chunk_index": 1},
            ),
        ]
    )
    docs = await store.list_documents()
    assert any(d["document_id"] == "imported:x:abcd1234" and d["chunk_count"] == 2 for d in docs)
    chunks = await store.list_chunks("imported:x:abcd1234")
    assert len(chunks) == 2
    s = await store.stats()
    assert s["total_chunks"] == 2 and s["by_source"].get("imported") == 2
    removed = await store.delete_document("imported:x:abcd1234")
    assert removed == 2
    assert await store.count() == 0


@pytest_asyncio.fixture
async def sql_engine():
    eng = build_async_engine("sqlite+aiosqlite:///:memory:")
    await create_all(eng)
    yield eng
    await eng.dispose()


async def test_sql_vector_store_document_management(sql_engine) -> None:
    store = SqlVectorStore(sql_engine)
    md = {"document_id": "imported:y:deadbeef", "title": "Y"}
    await store.add(
        [
            StoredChunk(
                text="gamma", source="imported", embedding=[1.0, 0.0], dim=2,
                embedding_model="m", doc_id="imported:y:deadbeef:0",
                metadata={**md, "chunk_index": 0},
            ),
            StoredChunk(
                text="delta", source="imported", embedding=[0.0, 1.0], dim=2,
                embedding_model="m", doc_id="imported:y:deadbeef:1",
                metadata={**md, "chunk_index": 1},
            ),
        ]
    )
    docs = await store.list_documents()
    assert any(d["document_id"] == "imported:y:deadbeef" and d["chunk_count"] == 2 for d in docs)
    assert len(await store.list_chunks("imported:y:deadbeef")) == 2
    s = await store.stats()
    assert s["total_chunks"] == 2
    assert await store.delete_document("imported:y:deadbeef") == 2
    assert await store.count() == 0


# --------------------------------------------------------------------------- #
# HTTP routes (TestClient with fake ES + mock LLM)
# --------------------------------------------------------------------------- #
def test_rag_routes(client) -> None:
    # stats
    r = client.get("/api/rag/stats")
    assert r.status_code == 200
    assert r.json()["total_chunks"] > 0

    # import
    r = client.post("/api/rag/import", json={"title": "Route Doc", "text": DOC_TEXT, "tags": ["t"]})
    assert r.status_code == 200, r.text
    document_id = r.json()["document_id"]
    assert r.json()["chunk_count"] >= 1

    # list + get
    r = client.get("/api/rag/documents")
    assert r.status_code == 200
    assert any(d["document_id"] == document_id for d in r.json()["documents"])
    r = client.get(f"/api/rag/documents/{document_id}")
    assert r.status_code == 200
    assert r.json()["chunk_count"] >= 1

    # search shows it
    r = client.get("/api/rag/search", params={"q": "cobalt strike beacon", "top_k": 5})
    assert r.status_code == 200
    assert isinstance(r.json()["chunks"], list)

    # whitespace-only text → 400 (route strip guard)
    assert client.post("/api/rag/import", json={"title": "x", "text": "  "}).status_code == 400

    # missing document → 404
    assert client.get("/api/rag/documents/imported:nope:00000000").status_code == 404

    # delete imported doc
    r = client.delete(f"/api/rag/documents/{document_id}")
    assert r.status_code == 200
    assert r.json()["deleted"] >= 1
    assert client.get(f"/api/rag/documents/{document_id}").status_code == 404


def test_rag_route_seed_delete_guarded(client) -> None:
    r = client.get("/api/rag/documents")
    seed = next(d for d in r.json()["documents"] if d["document_id"].startswith("seed:"))
    r = client.delete(f"/api/rag/documents/{seed['document_id']}")
    assert r.status_code == 400  # guarded seed source
    # force overrides
    r = client.delete(f"/api/rag/documents/{seed['document_id']}", params={"force": "true"})
    assert r.status_code == 200
