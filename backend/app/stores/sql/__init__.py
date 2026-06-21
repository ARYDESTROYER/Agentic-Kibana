"""SQL-backed implementations of the suite's OWN-state repositories (Epoch A).

This package lets the suite persist its bookkeeping (cases/audit/usage/config/
cursor/RAG vectors) in a SQL database — SQLite for dev/test (zero services) and
PostgreSQL+pgvector for production — instead of Elasticsearch. Elasticsearch
remains the DEFAULT; this path is selected only when ``Secrets.state_backend`` is
``"sqlite"`` or ``"postgres"``.

The read-only LOG surface is unaffected: it always stays on the connector layer.
"""

from __future__ import annotations

from .engine import build_async_engine, create_all
from .repositories import (
    SqlAuditRepository,
    SqlCaseRepository,
    SqlConfigStore,
    SqlCursorStore,
    SqlKVStore,
    SqlUsageRepository,
)
from .vectorstore import SqlVectorStore

__all__ = [
    "build_async_engine",
    "create_all",
    "SqlAuditRepository",
    "SqlCaseRepository",
    "SqlConfigStore",
    "SqlCursorStore",
    "SqlKVStore",
    "SqlUsageRepository",
    "SqlVectorStore",
]
