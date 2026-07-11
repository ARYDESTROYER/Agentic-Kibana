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

    async def ping_state(self) -> bool:
        """Probe the suite's OWN-state path.

        The default preserves compatibility for test and third-party clients. The
        real two-key client overrides it so readiness requires the management
        credential, not merely a reachable read-only log surface.
        """
        return await self.ping()

    async def write_state_probe(self) -> bool:
        """Prove the suite's management path can persist, not merely connect.

        The fixed document is intentionally tiny and overwritten on each readiness
        probe.  ``refresh=False`` avoids forcing an Elasticsearch refresh cycle.
        Implementations may override this when their state surface differs.
        """
        await self.index_doc(
            "tlsoc-agent-config",
            {"kind": "readiness_probe", "schema": 1},
            doc_id="_readiness",
            refresh=False,
        )
        return True

    # --- READ-ONLY log surface (scoped read-only key ONLY) ---
    @abstractmethod
    async def search_logs(self, index: str, body: dict[str, Any]) -> dict[str, Any]:
        """Search the configured log indices. Read-only. This is the agent's only
        path to log data (Section 6.5, es_query tool)."""

    async def open_log_pit(self, index: str, keep_alive: str = "1m") -> str | None:
        """Open a read-only point-in-time view for stable pull pagination.

        Optional by design: third-party/older compatible clients can return None
        and the connector uses bounded offset pagination instead.
        """
        return None

    async def close_log_pit(self, pit_id: str) -> None:
        """Close a PIT opened by :meth:`open_log_pit` (optional no-op)."""
        return None

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
