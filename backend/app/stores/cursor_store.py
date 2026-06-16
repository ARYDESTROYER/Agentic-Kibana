"""Durable polling cursor persistence (Section 6.1).

The cursor must survive a restart so that no event is skipped and none is
re-processed. This store is the single source of truth for the cursor.
"""

from __future__ import annotations

import logging

from ..constants import CURSOR_DOC_ID, CURSOR_INDEX
from ..es.base import BaseESClient
from ..models import Cursor

logger = logging.getLogger("tlsoc.cursor_store")


class CursorStore:
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def load(self) -> Cursor:
        try:
            doc = await self._es.get_doc(CURSOR_INDEX, CURSOR_DOC_ID)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading cursor failed (%s); starting cold", exc)
            return Cursor()
        if not doc:
            return Cursor()
        try:
            return Cursor.model_validate(doc)
        except Exception:  # noqa: BLE001
            return Cursor()

    async def save(self, cursor: Cursor) -> None:
        # refresh=True so a restart immediately reads the latest cursor.
        await self._es.update_doc(
            CURSOR_INDEX, CURSOR_DOC_ID, cursor.model_dump(mode="json"), refresh=True
        )
