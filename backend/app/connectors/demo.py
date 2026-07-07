"""Demo pull connector (Wave 5) — a synthetic, $0, isolated log source.

``DemoPullConnector`` plugs into the connector SPI like any other PULL source, but
owns NO ES client and reaches NO external system: for a cursor window it returns
DETERMINISTICALLY GENERATED OCSF/RawEvents from :mod:`app.engine.demo_generator`.
It is registered in the connector registry ONLY when ``prefs.demo.mode != 'off'``
(see ``connectors/registry.py``), so a production deployment never sees it.

Demo overhaul: the connector is parametrised by an optional ``segment``
(``siem`` | ``xdr`` | ``edr``) so the DemoStack can build THREE isolated demo
sources (one per segment) that draw disjoint rule/host pools. ``segment=None`` keeps
the pre-overhaul, undifferentiated single-source behaviour BYTE-IDENTICAL (so the
routes.py browse-logs special case and every existing construction keep working).

The events it produces are synthetic DATA (#9) and are tagged with a ``demo`` source
id, so the write-guard + the throwaway demo store keep them fully isolated from real
cases.
"""

from __future__ import annotations

import random
from typing import Any, Literal

from ..config import Preferences
from ..constants import SourceType
from ..models import Cursor, RawEvent
from ..utils import now_utc, to_millis
from .base import (
    ConnectionTest,
    ConnectorManifest,
    PullConnector,
    QueryRendering,
    SearchResult,
    StructuredQuery,
)
from ..engine import demo_generator as gen


class DemoPullConnector(PullConnector):
    """A seeded, synthetic PULL source for Demo Mode.

    No credentials, no network. ``poll`` returns the benign baseline for the window
    since the cursor; ``search``/``fetch_by_ids`` return a bounded recent slice so
    the browse surface works. Storyline ignition is driven by the DemoSimulator
    (it calls :meth:`storyline_raw`), not by ``poll``. When ``segment`` is set the
    generator only draws that segment's rule/host pool."""

    source_type = SourceType.GENERIC

    def __init__(
        self,
        config: dict[str, Any] | None = None,
        connector_id: str | None = None,
        *,
        seed: int = 1337,
        benign_per_hour: int = 6,
        segment: Literal["siem", "xdr", "edr"] | None = None,
    ) -> None:
        super().__init__(config, connector_id or gen.DEMO_SOURCE_ID)
        self._seed = seed
        self._benign_per_hour = benign_per_hour
        self._segment = segment
        self._org = gen.build_org(seed)
        # The RawEvent source label for this segment (defaults to the legacy single
        # source name so ``segment=None`` is byte-identical).
        self._source_name = (
            gen.SEGMENT_SOURCE_NAMES.get(segment, gen.DEMO_SOURCE_NAME)
            if segment else gen.DEMO_SOURCE_NAME
        )

    @classmethod
    def manifest(cls) -> ConnectorManifest:
        return cls.segment_manifest(None)

    @classmethod
    def segment_manifest(cls, segment: str | None) -> ConnectorManifest:
        """The manifest for a given segment (or the generic demo manifest when None).

        Used by the connector registry (generic) and by the read-time demo sources
        overlay to describe each of the three demo sources on the Sources page."""
        from ..constants import IngestMode

        display = (
            gen.SEGMENT_SOURCE_NAMES.get(segment, gen.DEMO_SOURCE_NAME)
            if segment else gen.DEMO_SOURCE_NAME
        )
        category = gen.SEGMENT_CATEGORIES.get(segment or "", "siem")
        return ConnectorManifest(
            source_type=cls.source_type,
            display_name=display,
            category=category,
            description=(
                "Synthetic, deterministic demo telemetry (no external system). Showcases "
                "the product with a believable benign baseline + MITRE ATT&CK storylines; "
                "fully isolated and $0."
            ),
            ingest_modes=[IngestMode.PULL],
            query_language="kuery",
            capabilities=["poll", "search", "fetch_by_ids", "browse"],
        )

    # ------------------------------------------------------------------ #
    # PullConnector SPI
    # ------------------------------------------------------------------ #
    async def ping(self) -> bool:
        return True

    def _to_raw(self, hits: list[dict[str, Any]], prefs: Preferences) -> list[RawEvent]:
        return gen.hits_to_raw(
            hits, prefs, source_id=self.connector_id, source_name=self._source_name,
        )

    async def poll(self, prefs: Preferences, cursor: Cursor, from_millis: int) -> list[RawEvent]:
        """Benign baseline since the cursor (entity-agnostic; never raises)."""
        now = to_millis(now_utc())
        start = cursor.timestamp_millis or from_millis
        start = max(start, now - 2 * 3_600_000)  # bound the window so the demo stays cheap
        rng = random.Random(self._seed ^ (start // gen._MS_PER_HOUR))
        hits = gen.generate_window_hits(
            rng, self._org, from_millis=start, to_millis=now,
            benign_per_hour=self._benign_per_hour, segment=self._segment,
        )
        return self._to_raw(hits, prefs)

    async def search(self, prefs: Preferences, query: StructuredQuery) -> SearchResult:
        """A bounded recent slice (backs browse + es_query). Synthetic + read-only."""
        now = to_millis(now_utc())
        rng = random.Random(self._seed ^ 0xB0B)
        hits = gen.generate_window_hits(
            rng, self._org, from_millis=now - 3_600_000, to_millis=now,
            benign_per_hour=self._benign_per_hour, segment=self._segment,
        )
        size = min(int(query.size or 50), 200)
        events = self._to_raw(hits[-size:], prefs)
        rendering = QueryRendering(query="*", language="kuery", data_view=gen.DEMO_INDEX)
        return SearchResult(events=events, total=len(events), rendering=rendering)

    async def fetch_by_ids(self, prefs: Preferences, ids: list[str], size: int) -> SearchResult:
        return SearchResult(events=[], total=0)

    async def test_connection(self, prefs: Preferences) -> ConnectionTest:
        return ConnectionTest(ok=True, message="Demo source — synthetic, $0.", mode="read_only")

    # ------------------------------------------------------------------ #
    # Demo-specific helpers (used by the DemoSimulator)
    # ------------------------------------------------------------------ #
    def benign_batch_raw(self, rng: random.Random, ts_millis: int, count: int,
                         prefs: Preferences) -> list[RawEvent]:
        hits = gen.generate_benign_batch(rng, self._org, ts_millis, count, self._segment)
        return self._to_raw(hits, prefs)

    def storyline_raw(self, story: gen.Storyline, rng: random.Random, start_millis: int,
                      prefs: Preferences) -> list[RawEvent]:
        hits = story.generate(rng, self._org, start_millis)
        events = self._to_raw(hits, prefs)
        # Mark storyline events as ALERTS so each clustered occurrence auto-forwards to
        # investigation (the showcase wants every storyline triaged end-to-end).
        for ev in events:
            ev.index_role = "alerts"
        return events
