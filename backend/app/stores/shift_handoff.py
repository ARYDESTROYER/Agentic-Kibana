"""SHIFT-HANDOFF store — standup attention queue + acknowledgements (Round 3).

The shift handoff carries two things across a SOC shift change / standup:

* a LIVING list of :class:`app.models.ActionItem` follow-ups (open→in_progress→done)
  — the cross-shift attention queue; and
* an APPEND-ONLY list of :class:`app.models.ShiftAck` — one analyst's confirmation
  that they have read the handoff for a given ``window`` (e.g. ``"2026-06-30/day"``).

Both are operator collaboration data — advisory only, they NEVER feed
``case_manager.decide()`` (#3); every ``title``/``note`` is plain, render-escaped
data (#9).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory`): BOTH lists live in ONE KV document
(``ns=SHIFT_HANDOFF_NS``, ``key=SHIFT_HANDOFF_KEY``) whose value is
``{"action_items": [<ActionItem json>, ...], "acks": [<ShiftAck json>, ...]}`` — so it
needs NO new ES index / SQL table / migration. The SQL backend uses ``SqlKVStore``;
the ES backend uses the thin :class:`app.stores.memory.EsKVStore` adapter.

Reads + writes are read-modify-write over the single doc. The store NEVER raises: a
failure degrades to empty lists / best-effort write and is logged.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, TypeVar

from ..constants import SHIFT_HANDOFF_KEY, SHIFT_HANDOFF_NS
from ..models import ActionItem, ShiftAck
from .base import KVStore, kv_mutate

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.shift_handoff")

# Bound the append-only ack list so a long-running tenant can't grow it without
# bound; the OLDEST acks are trimmed (recent handoff confirmations are what matters).
_MAX_ACKS = 1000


def _norm(value: str | None) -> str:
    return (value or "").strip()


class ShiftHandoffStore:
    """ActionItem CRUD (living list) + append-only ShiftAck list, in one KV document.

    The KV value is ``{"action_items": [...], "acks": [...]}``. Methods are
    read-modify-write; none raises (a failure logs + returns a safe default)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode(doc: dict | None) -> tuple[list[ActionItem], list[ShiftAck]]:
        if not doc or not isinstance(doc, dict):
            return [], []
        items: list[ActionItem] = []
        for raw in doc.get("action_items", []) or []:
            try:
                items.append(ActionItem.model_validate(raw))
            except Exception:  # noqa: BLE001 — skip a corrupt item, keep the rest
                continue
        acks: list[ShiftAck] = []
        for raw in doc.get("acks", []) or []:
            try:
                acks.append(ShiftAck.model_validate(raw))
            except Exception:  # noqa: BLE001
                continue
        return items, acks

    @staticmethod
    def _encode(items: list[ActionItem], acks: list[ShiftAck]) -> dict:
        if len(acks) > _MAX_ACKS:
            acks = acks[-_MAX_ACKS:]
        return {
            "action_items": [i.model_dump(mode="json") for i in items],
            "acks": [a.model_dump(mode="json") for a in acks],
        }

    async def _load(self) -> tuple[list[ActionItem], list[ShiftAck]]:
        try:
            doc = await self._kv.get(SHIFT_HANDOFF_NS, SHIFT_HANDOFF_KEY)
        except Exception as exc:  # noqa: BLE001 — handoff is best-effort
            logger.warning("Loading shift handoff failed (%s); using empty set", exc)
            return [], []
        return self._decode(doc)

    async def _mutate(
        self, change: Callable[[list[ActionItem], list[ShiftAck]], tuple[_T, list[ActionItem], list[ShiftAck]]]
    ) -> _T:
        """Atomic read-modify-write over the shared handoff doc (lost-update safe).

        ``change(items, acks)`` runs on a FRESH decode (it may run more than once on
        a CAS retry) and returns ``(result, new_items, new_acks)``."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            items, acks = self._decode(current)
            result, new_items, new_acks = change(items, acks)
            box["r"] = result
            return self._encode(new_items, new_acks)

        await kv_mutate(self._kv, SHIFT_HANDOFF_NS, SHIFT_HANDOFF_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    # ---- Action items (the living attention queue) ----------------------- #
    async def list_action_items(self, *, open_only: bool = False) -> list[ActionItem]:
        """Every action item, creation order. ``open_only`` filters to not-done."""
        items, _ = await self._load()
        if open_only:
            items = [i for i in items if i.status != "done"]
        return items

    async def get_action_item(self, item_id: str) -> ActionItem | None:
        items, _ = await self._load()
        for i in items:
            if i.id == item_id:
                return i
        return None

    async def add_action_item(self, title: str, *, owner: str | None = None,
                              note: str = "", status: str = "open") -> ActionItem:
        """Add a follow-up action item to the living queue. ``title``/``note`` are
        plain data (#9). Returns the stored item."""
        item = ActionItem(
            title=_norm(title), owner=owner, note=_norm(note),
            status=status if status in ("open", "in_progress", "done") else "open",
        )

        def _change(items: list[ActionItem], acks: list[ShiftAck]):
            items.append(item)
            return item, items, acks

        return await self._mutate(_change)

    async def update_action_item(self, item_id: str, **fields: Any) -> ActionItem | None:
        """Patch the provided (non-None) fields on an action item. Allowed: ``title``,
        ``owner``, ``status``, ``note``. Returns the updated item, or None."""
        allowed = {"title", "owner", "status", "note"}

        def _change(items: list[ActionItem], acks: list[ShiftAck]):
            updated: ActionItem | None = None
            for idx, i in enumerate(items):
                if i.id != item_id:
                    continue
                patch = {k: v for k, v in fields.items() if k in allowed and v is not None}
                if "status" in patch and patch["status"] not in ("open", "in_progress", "done"):
                    patch.pop("status")
                updated = i.model_copy(update=patch)
                items[idx] = updated
                break
            return updated, items, acks

        return await self._mutate(_change)

    async def delete_action_item(self, item_id: str) -> bool:
        """Delete an action item. Returns True if it existed."""

        def _change(items: list[ActionItem], acks: list[ShiftAck]):
            remaining = [i for i in items if i.id != item_id]
            existed = len(remaining) != len(items)
            return existed, remaining, acks

        return await self._mutate(_change)

    # ---- Shift acknowledgements (append-only) ---------------------------- #
    async def acknowledge(self, user: str, window: str, *, note: str = "") -> ShiftAck:
        """Append one analyst's acknowledgement of a handoff ``window`` (append-only —
        a fresh ack each time, so a re-read is recorded). ``note`` is plain data (#9).
        Returns the stored ack."""
        ack = ShiftAck(user=_norm(user), window=_norm(window), note=_norm(note))

        def _change(items: list[ActionItem], acks: list[ShiftAck]):
            acks.append(ack)
            return ack, items, acks

        return await self._mutate(_change)

    async def list_acks(self, *, window: str | None = None,
                        user: str | None = None) -> list[ShiftAck]:
        """The acknowledgement log NEWEST first, optionally filtered by ``window`` /
        ``user``."""
        _, acks = await self._load()
        out = list(reversed(acks))  # newest first
        if window:
            w = _norm(window)
            out = [a for a in out if a.window == w]
        if user:
            u = _norm(user).lower()
            out = [a for a in out if a.user.strip().lower() == u]
        return out

    async def has_acked(self, user: str, window: str) -> bool:
        """True if ``user`` has acknowledged ``window`` at least once."""
        u = _norm(user).lower()
        w = _norm(window)
        _, acks = await self._load()
        return any(a.user.strip().lower() == u and a.window == w for a in acks)
