"""Cross-case CAMPAIGN store — the running list of related-case groups (Round 4).

A :class:`app.models.Campaign` groups >= 2 RELATED cases (shared entities /
overlapping MITRE) into one incident narrative the UI surfaces above the case list.
This store persists the campaign list; the deterministic clustering pass that
BUILDS the list lives in :mod:`app.engine.campaigns` (a read-time aggregator, like
``engine/shift_report.py``).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.user_prefs` / :mod:`app.stores.case_activity`): the WHOLE campaign
set is ONE KV document (``ns=CAMPAIGNS_NS``, ``key=CAMPAIGNS_KEY``) whose value is
``{"campaigns": {"<campaign_id>": <Campaign json>, ...}}`` — so it needs NO new ES
index / SQL table / migration. The SQL backend uses ``SqlKVStore``; the ES backend
uses the thin :class:`app.stores.memory.EsKVStore` adapter (a doc in the existing
config index).

IDENTITY / IDEMPOTENCY: a campaign is keyed by its ``id`` — a STABLE hash of its
members' sorted ``cluster_signature`` values (computed in :mod:`app.engine.campaigns`).
So the SAME set of member clusters always folds into the SAME stored campaign,
and re-running the pass upserts in place rather than spawning duplicates.

ADVISORY: a campaign is presentation/reporting only. Nothing here mutates a case,
touches ``cluster_signature`` (#4), calls ``case_manager.decide()`` (#3), or makes an
LLM call (#6). Reads + writes are read-modify-write over the single dict via the
lost-update-safe :func:`app.stores.base.kv_mutate` CAS. Ordinary reads remain
fail-soft; evidence exports use the separate strict projection.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, TypeVar

from ..constants import CAMPAIGNS_KEY, CAMPAIGNS_NS
from ..models import Campaign
from ..utils import iso_now
from .base import KVStore, kv_mutate, kv_mutate_strict

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.campaigns")


class CampaignStore:
    """CRUD over the cross-case campaign list, persisted as one KV document.

    The KV value is ``{"campaigns": {"<campaign_id>": <Campaign json>}}``. Methods
    are read-modify-write over the single dict; ordinary reads degrade to a safe
    default while :meth:`list_strict` propagates uncertainty. Keyed by ``Campaign.id`` (the content hash) so an
    idempotent re-run of the clustering pass upserts a campaign in place."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    # ---- (de)serialisation ------------------------------------------------- #
    @staticmethod
    def _decode(doc: dict | None) -> dict[str, Campaign]:
        raw = doc.get("campaigns", {}) if isinstance(doc, dict) else {}
        out: dict[str, Campaign] = {}
        for cid, item in (raw or {}).items():
            try:
                out[str(cid)] = Campaign.model_validate(item)
            except Exception:  # noqa: BLE001 — skip a single corrupt entry, keep the rest
                continue
        return out

    @staticmethod
    def _encode(
        campaigns: dict[str, Campaign], *, last_reconciled_at: str = ""
    ) -> dict:
        value = {"campaigns": {cid: c.model_dump(mode="json") for cid, c in campaigns.items()}}
        if last_reconciled_at:
            value["last_reconciled_at"] = last_reconciled_at
        return value

    async def _load_all(self) -> dict[str, Campaign]:
        try:
            doc = await self._kv.get(CAMPAIGNS_NS, CAMPAIGNS_KEY)
        except Exception as exc:  # noqa: BLE001 — campaigns are best-effort
            logger.warning("Loading campaigns failed (%s); using empty set", exc)
            return {}
        return self._decode(doc)

    async def _load_all_strict(self) -> dict[str, Campaign]:
        """Load the complete campaign registry or raise on uncertainty/corruption."""
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(CAMPAIGNS_NS, CAMPAIGNS_KEY)
        if doc is None:
            return {}
        if not isinstance(doc, dict):
            raise ValueError("campaign registry is not a JSON object")
        raw = doc.get("campaigns", {})
        if not isinstance(raw, dict):
            raise ValueError("campaign registry entries are not an object")
        decoded = self._decode(doc)
        if len(decoded) != len(raw):
            raise ValueError("campaign registry contains an invalid entry")
        return decoded

    async def _mutate(self, change: Callable[[dict[str, Campaign]], _T]) -> _T:
        """Atomic read-modify-write over the shared campaigns doc (lost-update safe)."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            campaigns = self._decode(current)
            box["r"] = change(campaigns)
            return self._encode(
                campaigns,
                last_reconciled_at=str((current or {}).get("last_reconciled_at") or ""),
            )

        await kv_mutate(self._kv, CAMPAIGNS_NS, CAMPAIGNS_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    # ---- reads ------------------------------------------------------------- #
    async def get(self, campaign_id: str | None) -> Campaign | None:
        """One campaign by its (content-hash) id, or None when absent."""
        cid = (campaign_id or "").strip()
        if not cid:
            return None
        return (await self._load_all()).get(cid)

    async def list(
        self,
        *,
        status: str | None = None,
        limit: int = 0,
        offset: int = 0,
    ) -> tuple[list[Campaign], int]:
        """The campaign list, NEWEST first (by ``last_seen`` then ``created_at``).

        Page-friendly: ``status`` filters by :class:`app.constants.CampaignStatus`
        value; ``offset``/``limit`` (limit>0) page the result. Returns
        ``(page, total)`` where ``total`` is the count after the status filter."""
        campaigns = list((await self._load_all()).values())
        if status:
            want = str(status)
            campaigns = [c for c in campaigns if str(getattr(c.status, "value", c.status)) == want]
        # Newest first: last_seen (fall back to created_at) descending, id tie-break
        # for a total, deterministic order.
        campaigns.sort(key=lambda c: (c.last_seen or c.created_at or "", c.id), reverse=True)
        total = len(campaigns)
        start = max(int(offset), 0)
        page = campaigns[start:]
        if limit and limit > 0:
            page = page[:limit]
        return page, total

    async def list_strict(
        self,
        *,
        status: str | None = None,
        limit: int = 0,
        offset: int = 0,
    ) -> tuple[list[Campaign], int]:
        """Page campaigns while propagating unavailable/malformed registry reads."""
        campaigns = list((await self._load_all_strict()).values())
        if status:
            want = str(status)
            campaigns = [
                c for c in campaigns
                if str(getattr(c.status, "value", c.status)) == want
            ]
        campaigns.sort(
            key=lambda c: (c.last_seen or c.created_at or "", c.id), reverse=True
        )
        total = len(campaigns)
        start = max(int(offset), 0)
        page = campaigns[start:]
        if limit and limit > 0:
            page = page[:limit]
        return page, total

    async def get_last_reconciled_at(self) -> str:
        """Timestamp of the last confirmed full-set reconciliation."""
        getter = getattr(self._kv, "get_strict", None) or self._kv.get
        doc = await getter(CAMPAIGNS_NS, CAMPAIGNS_KEY)
        return str((doc or {}).get("last_reconciled_at") or "")

    # ---- writes ------------------------------------------------------------ #
    async def upsert(self, campaign: Campaign) -> Campaign:
        """Insert or replace ONE campaign, keyed by its content-hash ``id``.

        Idempotent: upserting a campaign whose members are unchanged re-writes the
        SAME entry (same id) — never a duplicate. Preserves the original
        ``created_at`` on an update so the campaign keeps its first-seen provenance."""
        cid = (campaign.id or "").strip()
        if not cid:
            raise ValueError("campaign.id is required")

        def _change(campaigns: dict[str, Campaign]) -> Campaign:
            existing = campaigns.get(cid)
            if existing is not None and existing.created_at:
                campaign_final = campaign.model_copy(update={"created_at": existing.created_at})
            else:
                campaign_final = campaign
            campaigns[cid] = campaign_final
            return campaign_final

        return await self._mutate(_change)

    async def upsert_many(self, campaigns: list[Campaign]) -> list[Campaign]:
        """Upsert a batch of campaigns in ONE read-modify-write (the pass emits a set).

        Each is keyed by its content-hash ``id`` (idempotent). ``created_at`` is
        preserved for any campaign that already exists. Returns the stored list."""
        by_id = {(c.id or "").strip(): c for c in campaigns if (c.id or "").strip()}
        if not by_id:
            return []

        def _change(current: dict[str, Campaign]) -> list[Campaign]:
            stored: list[Campaign] = []
            for cid, campaign in by_id.items():
                existing = current.get(cid)
                if existing is not None and existing.created_at:
                    campaign = campaign.model_copy(update={"created_at": existing.created_at})
                current[cid] = campaign
                stored.append(campaign)
            return stored

        return await self._mutate(_change)

    async def replace_all(self, campaigns: list[Campaign]) -> list[Campaign]:
        """Durably reconcile the authoritative pass result, including an empty set.

        Unlike an upsert, this removes campaigns whose member graph no longer
        exists.  A successful return means the exact set was confirmed through the
        strict KV CAS boundary; callers must surface failures rather than claiming
        a successful reconciliation.
        """
        by_id = {(c.id or "").strip(): c for c in campaigns if (c.id or "").strip()}
        stored: list[Campaign] = []

        def _replace(current: dict | None) -> dict:
            previous = self._decode(current)
            reconciled: dict[str, Campaign] = {}
            stored.clear()
            for cid, campaign in sorted(by_id.items()):
                existing = previous.get(cid)
                if existing is not None and existing.created_at:
                    campaign = campaign.model_copy(update={"created_at": existing.created_at})
                reconciled[cid] = campaign
                stored.append(campaign)
            return self._encode(reconciled, last_reconciled_at=iso_now())

        await kv_mutate_strict(
            self._kv,
            CAMPAIGNS_NS,
            CAMPAIGNS_KEY,
            _replace,
            lock=self._lock,
        )
        return list(stored)

    async def delete(self, campaign_id: str | None) -> bool:
        """Drop one campaign (e.g. an operator dismiss). Returns True if it existed."""
        cid = (campaign_id or "").strip()

        def _change(campaigns: dict[str, Campaign]) -> bool:
            if cid not in campaigns:
                return False
            del campaigns[cid]
            return True

        return await self._mutate(_change)
