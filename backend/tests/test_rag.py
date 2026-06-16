"""Tests for the RAG service / tool. Offline — embeddings use local hashing."""

from __future__ import annotations

from app.config import Preferences, Secrets
from app.es.fake import InMemoryESClient
from app.llm.gateway import LLMGateway
from app.llm.providers import MockProvider
from app.models import RagChunk
from app.stores.usage import UsageStore
from app.tools.rag import RagService, RagTool


def _gateway() -> LLMGateway:
    # Force the embedding provider to the deterministic MockProvider (local hash
    # embeddings) so no key or network is needed. The embedding model defaults to
    # provider "openai"; override that slot too.
    secrets = Secrets(_env_file=None)  # type: ignore[call-arg]  # provider forced via override
    usage = UsageStore(InMemoryESClient())
    mock = MockProvider()
    return LLMGateway(secrets, usage, provider_overrides={"openai": mock, "mock": mock})


async def test_seed_and_retrieve_brute_force() -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()

    chunks = await rag.retrieve("ssh brute force failed login", top_k=3)
    assert chunks, "expected non-empty retrieval"
    assert all(isinstance(c, RagChunk) for c in chunks)
    assert len(chunks) <= 3

    top = chunks[0]
    blob = (top.text + " " + top.source + " " + str(top.metadata)).lower()
    assert any(kw in blob for kw in ("brute", "auth", "login", "ssh"))


async def test_ensure_seeded_is_idempotent() -> None:
    rag = RagService(_gateway(), Preferences())
    await rag.ensure_seeded()
    await rag.ensure_seeded()  # second call must not duplicate or raise
    chunks = await rag.retrieve("port scan reconnaissance", top_k=2)
    assert chunks


async def test_retrieve_disabled_returns_empty() -> None:
    prefs = Preferences()
    prefs.rag.enabled = False
    rag = RagService(_gateway(), prefs)
    await rag.ensure_seeded()
    assert await rag.retrieve("ssh brute force", top_k=3) == []


async def test_rag_tool_run_returns_list_data() -> None:
    rag = RagService(_gateway(), Preferences())
    tool = RagTool(rag)
    result = await tool.run(query="malicious ip reputation block", top_k=2)
    assert result.ok is True
    assert isinstance(result.data, list)
    assert len(result.data) >= 1
    assert isinstance(result.data[0], dict)
    assert "text" in result.data[0]
