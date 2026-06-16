"""Abstract Elasticsearch client interface.

The engine and stores depend on this interface, never on a concrete client. That
is what lets the test suite swap in an in-memory fake, and what keeps the
read-only/management credential split explicit and auditable.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseESClient(ABC):
    # --- health ---
    @abstractmethod
    async def ping(self) -> bool: ...

    # --- READ-ONLY log surface (scoped read-only key ONLY) ---
    @abstractmethod
    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        """Search the configured log indices. Read-only. This is the agent's only
        path to log data (Section 6.5, es_query tool)."""

    # --- MANAGEMENT: the suite's OWN indices (scoped management key) ---
    @abstractmethod
    async def index_template_exists(self, name: str) -> bool: ...

    @abstractmethod
    async def put_index_template(self, name: str, body: dict[str, Any]) -> None: ...

    @abstractmethod
    async def index_exists(self, name: str) -> bool: ...

    @abstractmethod
    async def create_index(self, name: str, body: dict[str, Any] | None = None) -> None: ...

    @abstractmethod
    async def index_doc(
        self,
        index: str,
        doc: dict[str, Any],
        doc_id: str | None = None,
        refresh: bool = False,
    ) -> str:
        """Index (create or overwrite) a document. Returns the document id."""

    @abstractmethod
    async def get_doc(self, index: str, doc_id: str) -> dict[str, Any] | None: ...

    @abstractmethod
    async def update_doc(
        self,
        index: str,
        doc_id: str,
        doc: dict[str, Any],
        refresh: bool = False,
    ) -> None:
        """Upsert a document (used for the single-doc config/cursor indices and
        for case updates)."""

    @abstractmethod
    async def search(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        """Search a management index (cases/audit/usage). Never the log surface."""

    @abstractmethod
    async def count(self, index: str, body: dict[str, Any]) -> int: ...

    @abstractmethod
    async def close(self) -> None: ...
