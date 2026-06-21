"""SQLAlchemy ORM tables for the SQL state backend (Epoch A).

Rich domain documents (Case/AuditDoc/UsageDoc/Preferences/Cursor) are stored as
JSON columns so the Pydantic contracts remain the single source of truth — the
ORM never re-models them field-by-field. Alongside each JSON blob we materialise
ONLY the columns the existing queries filter or sort on (signature, status,
source_surface, entity_value, ts, case_id), and index those, so the SQL backend
reproduces the ES query semantics efficiently.

The ``embedding`` column on ``rag_chunks`` is a JSON-encoded list of floats by
default (portable: works on SQLite and any SQL engine, cosine computed in
Python). On PostgreSQL the production path may additionally use a native
``pgvector`` column; that is selected lazily in :mod:`.vectorstore` and never
imported here, so this module imports cleanly without ``pgvector`` installed.
"""

from __future__ import annotations

from sqlalchemy import JSON, Float, Index, Integer, String, Text
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Declarative base for all SQL state tables."""


class CaseRow(Base):
    """One :class:`~app.models.Case`, keyed by ``case_id``."""

    __tablename__ = "cases"

    case_id: Mapped[str] = mapped_column(String(255), primary_key=True)
    cluster_signature: Mapped[str] = mapped_column(String(255), index=True)
    status: Mapped[str] = mapped_column(String(64), index=True)
    source_surface: Mapped[str] = mapped_column(String(64), index=True)
    entity_value: Mapped[str] = mapped_column(String(512), index=True, default="")
    created_at: Mapped[str] = mapped_column(String(64), index=True, default="")
    updated_at: Mapped[str] = mapped_column(String(64), index=True, default="")
    doc: Mapped[dict] = mapped_column(JSON)


class AuditRow(Base):
    """One immutable audit action (append-only — never updated/deleted)."""

    __tablename__ = "audit"

    # A surrogate autoincrement id preserves insertion order as a stable tiebreaker
    # when many actions share a millisecond-identical ``ts``.
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[str] = mapped_column(String(64), index=True, default="")
    case_id: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    action_type: Mapped[str] = mapped_column(String(64), default="")
    doc: Mapped[dict] = mapped_column(JSON)


class UsageRow(Base):
    """One LLM-call cost/token ledger entry (Section 7.3)."""

    __tablename__ = "usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ts: Mapped[str] = mapped_column(String(64), index=True, default="")
    case_id: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    surface: Mapped[str] = mapped_column(String(64), default="")
    role: Mapped[str] = mapped_column(String(64), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    cost: Mapped[float] = mapped_column(Float, default=0.0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    doc: Mapped[dict] = mapped_column(JSON)


class KVRow(Base):
    """Single-document key/value rows for config + cursor.

    The composite primary key (namespace, key) gives natural upsert semantics:
    a save replaces the row for that (namespace, key).
    """

    __tablename__ = "kv"

    namespace: Mapped[str] = mapped_column(String(64), primary_key=True)
    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


class RagChunkRow(Base):
    """One RAG vector chunk. ``embedding`` is a JSON list of floats (portable).

    ``doc_id`` is an optional stable id for upsert (resolved-case memory): adding
    a chunk with an existing ``doc_id`` REPLACES it instead of duplicating.
    """

    __tablename__ = "rag_chunks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doc_id: Mapped[str | None] = mapped_column(String(255), index=True, nullable=True)
    text: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(128), index=True, default="unknown")
    metadata_json: Mapped[dict] = mapped_column("metadata", JSON, default=dict)
    embedding_model: Mapped[str] = mapped_column(String(128), default="")
    dim: Mapped[int] = mapped_column(Integer, default=0)
    embedding: Mapped[list] = mapped_column(JSON, default=list)


Index("ix_cases_status_created", CaseRow.status, CaseRow.created_at)
Index("ix_audit_case_ts", AuditRow.case_id, AuditRow.ts)
Index("ix_usage_ts_case", UsageRow.ts, UsageRow.case_id)
