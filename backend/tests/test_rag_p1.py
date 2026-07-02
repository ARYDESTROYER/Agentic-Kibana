"""P1 RAG upgrade tests — all offline (mock embeddings + fake ES).

Covers: resolved-case memory, the embedding-space guard (dim mismatch -> reseed,
NOT truncation), the min-cosine threshold, the richer rag_query, the ESVectorStore
over the fake ES, and chat grounding with/without RAG.
"""

from __future__ import annotations

from app.agents.common import rag_query
from app.config import Preferences, Secrets
from app.constants import CaseStatus, EntityType, Verdict
from app.es.fake import InMemoryESClient
from app.llm.gateway import LLMGateway
from app.llm.providers import EmbeddingResult, MockProvider
from app.models import Case, Cluster, Entity, EvidenceItem, RawEvent
from app.stores.cases import CaseStore
from app.stores.usage import UsageStore
from app.tools.rag import RagService
from app.tools.vectorstore import (
    EmbeddingSpaceMismatch,
    ESVectorStore,
    InMemoryVectorStore,
    StoredChunk,
)
from app.utils import iso_now


def _gateway() -> LLMGateway:
    secrets = Secrets(_env_file=None)  # type: ignore[call-arg]
    usage = UsageStore(InMemoryESClient())
    mock = MockProvider()
    return LLMGateway(secrets, usage, provider_overrides={"openai": mock, "mock": mock})


class _DimProvider(MockProvider):
    """A mock embedding provider whose vector dimensionality is configurable, so a
    test can change the embedding space mid-flight."""

    def __init__(self, dim: int) -> None:
        super().__init__()
        self.dim = dim

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        vectors = []
        for t in texts:
            v = [0.0] * self.dim
            for i, token in enumerate(t.lower().split()):
                v[(hash(token) + i) % self.dim] += 1.0
            vectors.append(v)
        return EmbeddingResult(vectors=vectors, tokens=sum(len(t) for t in texts))


def _gateway_with(provider: MockProvider) -> LLMGateway:
    secrets = Secrets(_env_file=None)  # type: ignore[call-arg]
    usage = UsageStore(InMemoryESClient())
    return LLMGateway(
        secrets, usage,
        provider_overrides={"openai": provider, "mock": provider, "anthropic": provider},
    )


def _closed_case(case_id: str, ip: str, verdict: Verdict) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"sig-{case_id}",
        source_surface="investigate",
        rule_ids=["sshd", "linux_auth"],
        entity=Entity(type=EntityType.IP, value=ip),
        verdict=verdict,
        confidence=0.9,
        evidence=[EvidenceItem(summary="Sustained SSH brute force burst across many users")],
        recommended_action="Block the source IP at the perimeter.",
        status=CaseStatus.CLOSED,
        created_at=iso_now(),
        updated_at=iso_now(),
    )


# --------------------------------------------------------------------------- #
# Task 1: resolved-case memory
# --------------------------------------------------------------------------- #
async def test_resolved_case_memory_retrievable_after_seed() -> None:
    es = InMemoryESClient()
    cases = CaseStore(es)
    await cases.save(_closed_case("case-1", "198.51.100.7", Verdict.TRUE_POSITIVE))
    # An OPEN case must NOT be indexed (only closed memory).
    open_case = _closed_case("case-open", "203.0.113.9", Verdict.TRUE_POSITIVE)
    open_case.status = CaseStatus.OPEN
    await cases.save(open_case)

    rag = RagService(_gateway(), Preferences(), cases=cases)
    await rag.ensure_seeded()

    chunks = await rag.retrieve("brute force ip 198.51.100.7 block", top_k=5)
    blob = " ".join(c.text + " " + str(c.metadata) for c in chunks)
    assert "case-1" in blob, "closed-case memory should be retrievable"
    assert "198.51.100.7" in blob
    assert "case-open" not in blob, "open cases must not be indexed"
    # The resolved-case chunk carries citation metadata.
    rc = [c for c in chunks if c.source == "resolved_case"]
    assert rc and rc[0].metadata.get("case_id") == "case-1"


async def test_resolved_cases_disabled_when_pref_off() -> None:
    es = InMemoryESClient()
    cases = CaseStore(es)
    await cases.save(_closed_case("case-x", "198.51.100.7", Verdict.TRUE_POSITIVE))
    prefs = Preferences()
    prefs.rag.use_resolved_cases = False
    rag = RagService(_gateway(), prefs, cases=cases)
    await rag.ensure_seeded()
    chunks = await rag.retrieve("brute force ip 198.51.100.7", top_k=8)
    assert all(c.source != "resolved_case" for c in chunks)


# --------------------------------------------------------------------------- #
# Task 3: embedding-space guard — dim mismatch reseeds, never truncates
# --------------------------------------------------------------------------- #
async def test_dim_mismatch_triggers_reseed_not_truncation() -> None:
    provider = _DimProvider(dim=128)
    prefs = Preferences()
    prefs.rag.min_score = 0.0
    rag = RagService(_gateway_with(provider), prefs)
    await rag.ensure_seeded()
    space = await rag._store.embedding_space()
    assert space is not None and space[1] == 128

    # Embedding model output dimensionality changes (e.g. model swap).
    provider.dim = 64
    chunks = await rag.retrieve("ssh brute force failed login", top_k=3)
    assert chunks, "retrieval should succeed after an automatic reseed"
    new_space = await rag._store.embedding_space()
    assert new_space is not None and new_space[1] == 64, "store reseeded into the new space"
    # No truncated/zero-padded vectors: every stored vector matches the new dim.
    for _chunk, score in await rag._store.search([0.0] * 64, 3):
        assert isinstance(score, float)


def test_inmemory_store_raises_on_dim_mismatch() -> None:
    import asyncio

    store = InMemoryVectorStore()

    async def run() -> None:
        await store.add([StoredChunk(text="t", source="s", embedding=[1.0, 2.0, 3.0], dim=3)])
        try:
            await store.search([1.0, 2.0], 1)  # wrong dim
            raise AssertionError("expected EmbeddingSpaceMismatch")
        except EmbeddingSpaceMismatch:
            pass

    asyncio.run(run())


# --------------------------------------------------------------------------- #
# Task 4: min-cosine threshold drops weak chunks
# --------------------------------------------------------------------------- #
async def test_below_min_score_chunks_dropped() -> None:
    prefs = Preferences()
    prefs.rag.min_score = 0.999  # almost nothing can clear this
    rag = RagService(_gateway(), prefs)
    await rag.ensure_seeded()
    chunks = await rag.retrieve("completely unrelated zzz qqq xyzzy", top_k=5)
    assert chunks == [], "weakly-related chunks must be dropped below min_score"

    prefs.rag.min_score = 0.0
    rag2 = RagService(_gateway(), prefs)
    await rag2.ensure_seeded()
    assert await rag2.retrieve("ssh brute force failed login", top_k=5), "min_score=0 returns hits"


# --------------------------------------------------------------------------- #
# Task 5: richer rag_query includes the entity
# --------------------------------------------------------------------------- #
def test_rag_query_includes_entity() -> None:
    ev = RawEvent(
        id="e1", ip="203.0.113.10", user="root", host="web01", rule="sshd",
        source={"message": "Failed password for root from 203.0.113.10"},
    )
    cluster = Cluster(
        signature="sig",
        entity=Entity(type=EntityType.IP, value="203.0.113.10"),
        group_by=EntityType.IP,
        rule_values=["sshd"],
        member_events=[ev],
        count=12,
    )
    q = rag_query(cluster)
    assert "203.0.113.10" in q, "query must mention the concrete entity value"
    assert "ip" in q.lower()
    assert "sshd" in q
    # still a usable retrieval query (template tail retained)
    assert "runbook" in q


# --------------------------------------------------------------------------- #
# Task 2: ESVectorStore over the fake ES (kNN not required for this smoke test)
# --------------------------------------------------------------------------- #
async def test_es_vector_store_persists_and_counts() -> None:
    es = InMemoryESClient()
    store = ESVectorStore(es)
    await store.add([
        StoredChunk(text="alpha", source="runbook", embedding=[1.0, 0.0], dim=2, embedding_model="m"),
        StoredChunk(text="beta", source="mitre", embedding=[0.0, 1.0], dim=2, embedding_model="m"),
    ])
    assert await store.count() == 2
    assert await store.embedding_space() == ("m", 2)
    await store.clear()
    assert await store.count() == 0


# --------------------------------------------------------------------------- #
# Task 6: chat works with AND without RAG grounding
# --------------------------------------------------------------------------- #
async def test_chat_grounds_in_rag_when_available() -> None:
    import json

    from app.agents.chat import ChatEngine
    from app.audit.audit_log import AuditLogger

    es = InMemoryESClient()
    provider = MockProvider()
    provider.push("chat", json.dumps({"answer": "Looks like SSH brute force.", "needs_query": False}))
    gateway = _gateway_with(provider)
    cases = CaseStore(es)
    rag = RagService(gateway, Preferences(), cases=cases)
    engine = ChatEngine(es, gateway, AuditLogger(es), cases, rag=rag)

    resp = await engine.chat("How do I handle an ssh brute force from one IP?", Preferences())
    assert resp.answer
    # The chat call should have received a TRUSTED knowledge block (not fenced).
    chat_calls = [c for c in provider.calls if c["role"] == "chat"]
    assert chat_calls, "chat provider was called"
    msgs = chat_calls[-1]["messages"]
    kb = [m["content"] for m in msgs if "SOC knowledge base context" in m["content"]]
    assert kb, "a knowledge-base context message was added"
    assert "TRUSTED" in kb[0]
    # Our own corpus is NOT wrapped in the UNTRUSTED fence markers.
    assert "<<<UNTRUSTED_LOG_DATA>>>" not in kb[0]


async def test_chat_works_without_rag() -> None:
    import json

    from app.agents.chat import ChatEngine
    from app.audit.audit_log import AuditLogger

    es = InMemoryESClient()
    provider = MockProvider()
    provider.push("chat", json.dumps({"answer": "Plain answer.", "needs_query": False}))
    gateway = _gateway_with(provider)
    cases = CaseStore(es)
    engine = ChatEngine(es, gateway, AuditLogger(es), cases, rag=None)

    resp = await engine.chat("hello", Preferences())
    assert resp.answer == "Plain answer."
    chat_calls = [c for c in provider.calls if c["role"] == "chat"]
    blob = json.dumps(chat_calls[-1]["messages"])
    assert "SOC knowledge base context" not in blob, "no RAG -> conversation unchanged"
