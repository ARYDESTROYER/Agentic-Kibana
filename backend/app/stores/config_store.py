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
from .base import ConfigRepository

logger = logging.getLogger("tlsoc.config_store")


class ConfigStore(ConfigRepository):
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
        # Full-document replace (not a partial update) so a removed nested
        # preference key never leaves a stale value behind in Elasticsearch.
        await self._es.index_doc(
            CONFIG_INDEX, prefs.model_dump(mode="json"), doc_id=CONFIG_DOC_ID, refresh=True
        )

    async def seed_rule_catalog(self, prefs: Preferences) -> Preferences:
        """First-run seeding of the built-in rule catalog (C3-1).

        Idempotent and guarded by ``rule_catalog_seed_version``: it seeds ONLY when
        the catalog is empty or the stored seed version is older than
        ``RULE_CATALOG_SEED_VERSION``, and NEVER overwrites a non-empty operator-
        edited catalog. Persists (and returns) prefs only when something changed."""
        changed = prefs.maybe_seed_rule_catalog()
        if changed:
            logger.info("Seeded built-in rule catalog (%d rules)", len(prefs.rule_catalog))
            try:
                await self.save(prefs)
            except Exception as exc:  # noqa: BLE001 — seeding is best-effort
                logger.warning("Persisting seeded rule catalog failed (%s); continuing", exc)
        return prefs
