"""Agent-DRAFTED PROPOSAL store — pending recommendations awaiting human approval.

A PROPOSAL is a change the agent has DRAFTED but never applied: a suppression rule
derived from a closed false-positive, or a memory fact. It sits ``pending`` until a
human explicitly approves (the single live-write path) or rejects it. Drafting one
NEVER mutates a live rule / Preferences / memory — that is the whole point of HITL.

Backend-agnostic by construction (cloned verbatim from :mod:`app.stores.memory`):
the whole proposal set is ONE JSON list persisted through the existing
:class:`KVStore` abstraction (``ns="proposals"``, ``key="entries"``) — so it needs
NO new ES index / SQL table / migration. The SQL backend uses ``SqlKVStore`` (the
shared KV table); the ES backend uses the thin :class:`app.stores.memory.EsKVStore`
adapter (a doc in the existing config index).

Reads + writes are read-modify-write over the single list — fine at our scale
(operator/agent-authored proposals, not log volume). The store NEVER raises: a
load/save failure degrades to an empty list / best-effort write and is logged, so a
proposal glitch can never drop an alert or break the analyst's close action.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from ..constants import PROPOSALS_KEY, PROPOSALS_NS
from ..models import Proposal
from ..utils import iso_now
from .base import KVStore, kv_mutate

logger = logging.getLogger("tlsoc.stores.proposals")


class ProposalStore:
    """CRUD over the proposal list, persisted as one KV document.

    The KV value is ``{"entries": [<Proposal json>, ...]}``. Methods are
    read-modify-write; none raises (a failure logs + returns a safe default)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        # Per-store lock so kv_mutate serialises concurrent read-modify-write over the
        # single proposal doc + a _rev CAS covers the multi-process race — so a concurrent
        # add and set_status can't drop an in-flight proposal or revert an approved one to
        # pending (audit #26).
        self._lock = asyncio.Lock()

    async def _mutate(self, apply: Callable[[list[Proposal]], Any]) -> Any:
        """Run ``apply(entries)`` under kv_mutate (per-store lock + _rev CAS). ``apply``
        mutates the fresh list in place and returns an auxiliary result; the persisted
        attempt's result is returned. Never raises."""
        box: dict[str, Any] = {}

        def mutator(current: dict[str, Any] | None) -> dict[str, Any]:
            raw = current.get("entries", []) if isinstance(current, dict) else []
            entries: list[Proposal] = []
            for item in (raw or []):
                try:
                    entries.append(Proposal.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt entry, keep the rest
                    continue
            box["result"] = apply(entries)
            return {"entries": [p.model_dump(mode="json") for p in entries]}

        await kv_mutate(self._kv, PROPOSALS_NS, PROPOSALS_KEY, mutator, lock=self._lock)
        return box.get("result")

    async def _load(self) -> list[Proposal]:
        try:
            doc = await self._kv.get(PROPOSALS_NS, PROPOSALS_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading proposals failed (%s); using empty set", exc)
            return []
        if not doc:
            return []
        raw = doc.get("entries", []) if isinstance(doc, dict) else []
        out: list[Proposal] = []
        for item in raw or []:
            try:
                out.append(Proposal.model_validate(item))
            except Exception:  # noqa: BLE001 — skip a single corrupt entry, keep the rest
                continue
        return out

    # No plain _save — every mutation goes through _mutate (kv_mutate: lock + _rev CAS)
    # so a write can't clobber a concurrent one (audit #26).

    async def list(self, status: str | None = None) -> list[Proposal]:
        entries = await self._load()
        if status:
            entries = [p for p in entries if p.status == status]
        # Newest first so the review queue surfaces fresh proposals at the top.
        return sorted(entries, key=lambda p: p.created_at, reverse=True)

    async def get(self, proposal_id: str) -> Proposal | None:
        for p in await self._load():
            if p.id == proposal_id:
                return p
        return None

    async def add(self, proposal: Proposal) -> Proposal:
        def apply(entries: list[Proposal]) -> Proposal:
            entries.append(proposal)
            return proposal

        await self._mutate(apply)
        return proposal

    async def set_status(self, proposal_id: str, status: str, by: str) -> Proposal | None:
        """Transition a proposal's status (approve/reject) + record who decided it.

        Returns the updated proposal, or ``None`` if the id is unknown."""
        def apply(entries: list[Proposal]) -> Proposal | None:
            for idx, p in enumerate(entries):
                if p.id != proposal_id:
                    continue
                updated = p.model_copy(update={
                    "status": status,
                    "decided_by": (by or "").strip() or None,
                    "decided_at": iso_now(),
                })
                entries[idx] = updated
                return updated
            return None

        return await self._mutate(apply)
