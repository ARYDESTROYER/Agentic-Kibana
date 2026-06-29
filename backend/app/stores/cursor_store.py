"""Durable polling cursor persistence (Section 6.1).

The cursor must survive a restart so that no event is skipped and none is
re-processed. This store is the single source of truth for the cursor.
"""

from __future__ import annotations

import logging

import re

from ..constants import CURSOR_DOC_ID, CURSOR_INDEX
from ..es.base import BaseESClient
from ..models import Cursor
from .base import CursorRepository

logger = logging.getLogger("tlsoc.cursor_store")


def _doc_id(key: str) -> str:
    """A safe ES doc id for a per-feed cursor key (``source:feed``). The primary key
    maps to the legacy ``CURSOR_DOC_ID`` so an existing single-source cursor is read
    unchanged (no migration)."""
    if key in ("", "primary"):
        return CURSOR_DOC_ID
    safe = re.sub(r"[^A-Za-z0-9_.:-]+", "_", key)
    return f"feed:{safe}"


class CursorStore(CursorRepository):
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def load(self) -> Cursor:
        return await self.load_keyed("primary")

    async def save(self, cursor: Cursor) -> None:
        await self.save_keyed("primary", cursor)

    async def load_keyed(self, key: str) -> Cursor:
        try:
            doc = await self._es.get_doc(CURSOR_INDEX, _doc_id(key))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading cursor failed (%s); starting cold", exc)
            return Cursor()
        if not doc:
            return Cursor()
        try:
            return Cursor.model_validate(doc)
        except Exception:  # noqa: BLE001
            return Cursor()

    async def save_keyed(self, key: str, cursor: Cursor) -> None:
        # Full-document replace + refresh=True so a restart immediately reads the
        # latest cursor and a shrinking boundary list never leaves stale ids.
        await self._es.index_doc(
            CURSOR_INDEX, cursor.model_dump(mode="json"), doc_id=_doc_id(key), refresh=True
        )
