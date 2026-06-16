"""Preference store: non-secret, UI-editable configuration (Section 8.5).

Preferences are persisted as a single document. Load is tolerant of schema
drift (Pydantic ignores unknown keys and fills defaults for missing ones), so
upgrading the suite never breaks an existing config document.
"""

from __future__ import annotations

import logging

from ..config import Preferences
from ..constants import CONFIG_DOC_ID, CONFIG_INDEX
from ..es.base import BaseESClient

logger = logging.getLogger("tlsoc.config_store")


class ConfigStore:
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def load(self) -> Preferences:
        try:
            doc = await self._es.get_doc(CONFIG_INDEX, CONFIG_DOC_ID)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading preferences failed (%s); using defaults", exc)
            return Preferences()
        if not doc:
            return Preferences()
        try:
            return Preferences.model_validate(doc)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Stored preferences invalid (%s); using defaults", exc)
            return Preferences()

    async def save(self, prefs: Preferences) -> None:
        await self._es.update_doc(
            CONFIG_INDEX, CONFIG_DOC_ID, prefs.model_dump(mode="json"), refresh=True
        )
