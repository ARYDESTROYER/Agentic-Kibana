"""Internal no-query connector used when an install has push sources only.

It is deliberately not registered or shown in the wizard.  Its sole purpose is to
preserve the ``PullConnector`` seam without silently querying the legacy/global
Elasticsearch surface when no configured source is capable of pull/search.
"""

from __future__ import annotations

from ..config import Preferences
from ..constants import IngestMode, SourceType
from ..models import Cursor
from .base import (
    ConnectionTest,
    ConnectorManifest,
    PullConnector,
    SearchResult,
    StructuredQuery,
)


class UnavailablePullConnector(PullConnector):
    source_type = SourceType.ELASTICSEARCH

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return ConnectorManifest(
            source_type=cls.source_type,
            display_name="No pull source configured",
            ingest_modes=[IngestMode.PULL],
            capabilities=[],
        )

    async def ping(self) -> bool:
        return False

    async def poll(self, prefs: Preferences, cursor: Cursor, from_millis: int):
        return []

    async def search(self, prefs: Preferences, query: StructuredQuery) -> SearchResult:
        return SearchResult(events=[], total=0)

    async def fetch_by_ids(
        self, prefs: Preferences, ids: list[str], size: int
    ) -> SearchResult:
        return SearchResult(events=[], total=0)

    async def test_connection(self, prefs: Preferences) -> ConnectionTest:
        return ConnectionTest(
            ok=False,
            message="No configured pull/search source is available.",
            mode="unavailable",
        )
