"""Repository interfaces for the suite's OWN management state (Epoch A).

The suite's bookkeeping — cases, audit, usage, config, cursor and RAG vectors —
is persisted behind these abstract repositories so the SAME callers (pipeline,
chat, standup, poller, routes, state) work unchanged whether the backend is
Elasticsearch (the default) or a SQL database (SQLite for dev/test, PostgreSQL
+pgvector for production).

The method signatures here mirror the existing ES-backed stores EXACTLY, so the
ES classes (``CaseStore``/``AuditLogger``/``UsageStore``/``ConfigStore``/
``CursorStore``) already satisfy them — they simply declare the contract their
SQL counterparts (``SqlCaseRepository``/...) must reproduce.

Non-negotiable #2 (audit is append-only) is encoded in the interface: an audit
repository exposes ONLY ``write``/``record``/``records_for_case`` — there is no
update or delete on a recorded action, in any backend.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from ..config import Preferences
from ..constants import ActionType
from ..models import AuditDoc, Case, Cursor, UsageDoc


class CaseRepository(ABC):
    """Persists :class:`Case` documents (Section 7.1).

    Writes are idempotent overwrites keyed by ``case_id``; investigation-level
    idempotency is enforced one layer up via ``find_open_by_signature``.
    """

    @abstractmethod
    async def save(self, case: Case) -> None: ...

    @abstractmethod
    async def get(self, case_id: str) -> Case | None: ...

    @abstractmethod
    async def find_open_by_signature(self, signature: str) -> Case | None:
        """Return an OPEN/NEEDS_HUMAN case for this cluster signature, if any."""

    @abstractmethod
    async def list(
        self,
        *,
        status: str | None = None,
        source_surface: str | None = None,
        entity_value: str | None = None,
        limit: int = 50,
        offset: int = 0,
        sort_field: str = "created_at",
        sort_order: str = "desc",
    ) -> tuple[list[Case], int]:
        """Filtered, sorted, paged listing → (cases, total_matching)."""

    @abstractmethod
    async def list_scans(self, limit: int = 50) -> tuple[list[Case], int]:
        """Surface 3: the automated-scans queue."""

    @abstractmethod
    async def count_new_scans(self, since_iso: str) -> int:
        """Count automated-scan cases created strictly after ``since_iso``."""


class AuditRepository(ABC):
    """Append-only audit log (Section 7.2 / Non-negotiable #2).

    There is intentionally NO update/delete here: a recorded action is immutable
    in every backend.
    """

    @abstractmethod
    async def write(self, doc: AuditDoc) -> None: ...

    @abstractmethod
    async def record(
        self,
        *,
        action_type: ActionType,
        surface: str = "",
        actor: str = "",
        case_id: str | None = None,
        model: str | None = None,
        prompt_excerpt: str | None = None,
        query_text: str | None = None,
        tool_name: str | None = None,
        tool_input: Any = None,
        tool_output_summary: str | None = None,
        result_summary: str | None = None,
    ) -> None: ...

    @abstractmethod
    async def records_for_case(self, case_id: str, limit: int = 500) -> list[dict[str, Any]]:
        """All audit rows for a case, OLDEST first. Never raises."""


class UsageRepository(ABC):
    """Token & cost ledger (Section 7.3). Written ONLY by the LLM gateway (#6)."""

    @abstractmethod
    async def write(self, doc: UsageDoc) -> None: ...

    @abstractmethod
    async def summary(self, window_hours: int = 24, case_id: str | None = None) -> dict[str, Any]:
        """Windowed cost/token summary for the in-plugin cost panel."""


class KVStore(ABC):
    """Single-document key/value persistence for config + cursor.

    Config (``Preferences``) and cursor (``Cursor``) are each a single document;
    a KV row is namespaced (``config``/``cursor``) and holds the JSON body. The
    ES-backed ``ConfigStore``/``CursorStore`` keep their richer load/save APIs;
    the SQL backend exposes generic get/put used by SQL config/cursor stores.
    """

    @abstractmethod
    async def get(self, namespace: str, key: str) -> dict[str, Any] | None: ...

    @abstractmethod
    async def put(self, namespace: str, key: str, value: dict[str, Any]) -> None: ...


class ConfigRepository(ABC):
    """Preference store contract (Section 8.5)."""

    @abstractmethod
    async def load(self) -> Preferences: ...

    @abstractmethod
    async def save(self, prefs: Preferences) -> None: ...

    @abstractmethod
    async def seed_rule_catalog(self, prefs: Preferences) -> Preferences: ...


class CursorRepository(ABC):
    """Durable polling cursor contract (Section 6.1)."""

    @abstractmethod
    async def load(self) -> Cursor: ...

    @abstractmethod
    async def save(self, cursor: Cursor) -> None: ...
