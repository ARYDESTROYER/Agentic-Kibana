"""Case store (Section 7.1).

Cases are keyed by ``case_id`` (the ES document id) so writes are idempotent
overwrites. Idempotency at the *investigation* level is enforced one layer up by
``find_open_by_signature`` (Section 6.2 / Non-negotiable #4): the same cluster
signature maps to the same open case, so re-polling never creates duplicates.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import (
    CASES_READ_PATTERN,
    CASES_WRITE_ALIAS,
    OPEN_CASE_STATUSES,
    SourceSurface,
)
from ..es.base import BaseESClient
from ..models import Case
from .base import CaseRepository

logger = logging.getLogger("tlsoc.cases")

# Any NON-terminal lifecycle status counts as "open" for the signature idempotency
# lookup (#4) — including the F8 statuses (NEW/INVESTIGATING/ESCALATED/ON_HOLD), so
# an escalated/held case still attaches its new events instead of duplicating.
_OPEN_STATUSES = list(OPEN_CASE_STATUSES)


class CaseStore(CaseRepository):
    def __init__(self, es: BaseESClient) -> None:
        self._es = es

    async def save(self, case: Case) -> None:
        await self._es.index_doc(
            CASES_WRITE_ALIAS, case.model_dump(mode="json"), doc_id=case.case_id, refresh=True
        )

    async def get(self, case_id: str) -> Case | None:
        body = {"size": 1, "query": {"term": {"case_id": case_id}}}
        resp = await self._es.search(CASES_READ_PATTERN, body)
        return _first_case(resp)

    async def find_open_by_signature(self, signature: str) -> Case | None:
        """Return an OPEN/NEEDS_HUMAN case for this cluster signature, if any.

        This is the idempotency lookup: events for an already-open cluster attach
        to it rather than spawning a duplicate case."""
        body = {
            "size": 1,
            "query": {
                "bool": {
                    "filter": [
                        {"term": {"cluster_signature": signature}},
                        {"terms": {"status": _OPEN_STATUSES}},
                    ]
                }
            },
            "sort": [{"updated_at": {"order": "desc"}}],
        }
        resp = await self._es.search(CASES_READ_PATTERN, body)
        return _first_case(resp)

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
        filters: list[dict[str, Any]] = []
        if status:
            filters.append({"term": {"status": status}})
        if source_surface:
            filters.append({"term": {"source_surface": source_surface}})
        if entity_value:
            filters.append({"term": {"entity.value": entity_value}})
        body = {
            "size": limit,
            "from": offset,
            "query": {"bool": {"filter": filters}} if filters else {"match_all": {}},
            "sort": [{sort_field: {"order": sort_order}}],
        }
        resp = await self._es.search(CASES_READ_PATTERN, body)
        cases = [Case.model_validate(h["_source"]) for h in resp.get("hits", {}).get("hits", [])]
        total = int(resp.get("hits", {}).get("total", {}).get("value", len(cases)))
        return cases, total

    async def list_scans(self, limit: int = 50) -> tuple[list[Case], int]:
        """Surface 3: the automated-scans queue."""
        return await self.list(
            source_surface=SourceSurface.AUTOMATED_SCAN.value, limit=limit
        )

    async def count_new_scans(self, since_iso: str) -> int:
        body = {
            "query": {
                "bool": {
                    "filter": [
                        {"term": {"source_surface": SourceSurface.AUTOMATED_SCAN.value}},
                        {"range": {"created_at": {"gt": since_iso}}},
                    ]
                }
            }
        }
        return await self._es.count(CASES_READ_PATTERN, body)


def _first_case(resp: dict[str, Any]) -> Case | None:
    hits = resp.get("hits", {}).get("hits", [])
    if not hits:
        return None
    return Case.model_validate(hits[0]["_source"])
