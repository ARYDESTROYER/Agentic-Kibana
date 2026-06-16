"""Vector store interface + an always-available in-memory cosine store.

The in-memory store keeps RAG working with zero extra services (it degrades
gracefully — Gate 2). A Chroma-backed store can be added behind this same
interface as a single-container add (Section 6.6) without touching agent code.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class StoredChunk:
    text: str
    source: str
    metadata: dict[str, Any] = field(default_factory=dict)
    embedding: list[float] = field(default_factory=list)


class VectorStore(ABC):
    @abstractmethod
    async def add(self, chunks: list[StoredChunk]) -> None: ...

    @abstractmethod
    async def search(self, query_vector: list[float], top_k: int) -> list[tuple[StoredChunk, float]]: ...

    @abstractmethod
    async def count(self) -> int: ...


class InMemoryVectorStore(VectorStore):
    def __init__(self) -> None:
        self._chunks: list[StoredChunk] = []

    async def add(self, chunks: list[StoredChunk]) -> None:
        self._chunks.extend(c for c in chunks if c.embedding)

    async def search(self, query_vector: list[float], top_k: int) -> list[tuple[StoredChunk, float]]:
        scored = [(c, _cosine(query_vector, c.embedding)) for c in self._chunks]
        scored.sort(key=lambda t: t[1], reverse=True)
        return scored[:top_k]

    async def count(self) -> int:
        return len(self._chunks)


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    n = min(len(a), len(b))
    dot = sum(a[i] * b[i] for i in range(n))
    na = math.sqrt(sum(x * x for x in a[:n]))
    nb = math.sqrt(sum(x * x for x in b[:n]))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)
