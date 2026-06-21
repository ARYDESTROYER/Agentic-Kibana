"""Async SQLAlchemy engine factory + schema bootstrap for the SQL state backend.

Postgres-only dependencies (``asyncpg`` driver, ``pgvector``) are NEVER imported
here: SQLAlchemy resolves the ``+asyncpg`` driver lazily from the URL only when a
``postgresql+asyncpg://`` engine is actually created. So importing this module
(and running the whole suite on SQLite/ES) requires only ``sqlalchemy`` +
``aiosqlite`` — the test/dev path.
"""

from __future__ import annotations

import logging

from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

from .models import Base

logger = logging.getLogger("tlsoc.stores.sql.engine")

# Sane defaults when state_db_url is not provided.
_DEFAULT_SQLITE_URL = "sqlite+aiosqlite:///./tlsoc.db"


def resolve_db_url(state_backend: str, state_db_url: str | None) -> str:
    """Pick the SQLAlchemy async URL for the configured SQL backend.

    ``sqlite`` defaults to a local file when no URL is given; ``postgres`` MUST be
    given an explicit ``state_db_url`` (we never guess production credentials).
    """
    if state_db_url:
        return state_db_url
    if state_backend == "sqlite":
        return _DEFAULT_SQLITE_URL
    raise ValueError(
        "state_backend='postgres' requires state_db_url "
        "(e.g. postgresql+asyncpg://user:pass@host:5432/tlsoc)"
    )


def build_async_engine(url: str) -> AsyncEngine:
    """Create an async engine. The driver (aiosqlite/asyncpg) is loaded lazily by
    SQLAlchemy from the URL scheme, so asyncpg is imported ONLY for a pg URL."""
    # check_same_thread is a SQLite-only nicety; SQLAlchemy ignores it elsewhere.
    connect_args = {"check_same_thread": False} if url.startswith("sqlite") else {}
    engine = create_async_engine(url, future=True, connect_args=connect_args)
    logger.info("Built async SQL engine (%s)", _safe_url(url))
    return engine


async def create_all(engine: AsyncEngine) -> None:
    """Create all state tables if absent (idempotent). On Postgres, also ensure the
    pgvector extension is available before any native vector column is used."""
    if engine.url.get_backend_name() == "postgresql":
        await _ensure_pgvector(engine)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("SQL state schema ensured")


async def _ensure_pgvector(engine: AsyncEngine) -> None:
    """Best-effort ``CREATE EXTENSION IF NOT EXISTS vector`` on Postgres.

    Lazily imports nothing pg-specific (raw SQL); failures (e.g. extension not
    installed / insufficient privilege) are logged and tolerated — the SQL vector
    store falls back to JSON+Python cosine when no native vector column exists."""
    from sqlalchemy import text

    try:
        async with engine.begin() as conn:
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        logger.info("pgvector extension ensured")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not ensure pgvector extension (%s); RAG uses JSON cosine", exc)


def _safe_url(url: str) -> str:
    """Redact credentials for logging."""
    if "@" in url and "://" in url:
        scheme, rest = url.split("://", 1)
        host = rest.split("@", 1)[1]
        return f"{scheme}://***@{host}"
    return url
