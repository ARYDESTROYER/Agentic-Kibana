"""Per-USER custom-dashboard store (Round 5 / G7 — custom dashboards).

A user's custom dashboards (:class:`app.models.DashboardLayout`) live here, keyed by
``user_id`` (the shared ``default`` bucket when auth is OFF, exactly like the inbox /
user-prefs stores). Each dashboard is an advisory presentation layout — it NEVER
feeds ``case_manager.decide()`` (#3) — and every ``name``/widget ``options`` value is
plain, render-escaped data (#9).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.inbox` / :mod:`app.stores.tuning`): the WHOLE dashboard set is ONE
KV document (``ns=DASHBOARDS_NS``, ``key=DASHBOARDS_KEY``) whose value is
``{"dashboards": {"<user_id>": {"<dash_id>": <DashboardLayout json>, ...}, ...}}`` —
so it needs NO new ES index / SQL table / migration. The SQL backend uses
``SqlKVStore`` (the shared KV table); the ES backend uses the thin
:class:`app.stores.memory.EsKVStore` adapter (a doc in the existing config index).

Writes go through :func:`app.stores.base.kv_mutate` (per-key lock + ``_rev`` CAS) so
two concurrent writers (a save racing a clone) never lost-update each other. The
store NEVER raises: a load/save failure degrades to an empty set / best-effort write
and is logged, so a dashboard glitch can never break a page.

``schema_version`` rides on each :class:`DashboardLayout` from day one so a future
widget-shape migration can evolve the data without a reset; a lower/absent version
loads unchanged (the reconcile-on-load lives client-side in the widget registry).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Callable, TypeVar

from ..constants import DASHBOARDS_KEY, DASHBOARDS_NS, USER_PREFS_DEFAULT_BUCKET
from ..models import DashboardLayout
from ..utils import iso_now
from .base import KVStore, kv_mutate

_T = TypeVar("_T")

logger = logging.getLogger("tlsoc.stores.dashboards")

# A defensive per-user cap so a single principal can't grow the shared doc without
# bound. MVP is a handful of dashboards; the API layer (CD5) enforces the operator
# policy, this is only the last-line backstop. Oldest-created are trimmed.
_MAX_PER_USER = 50


def normalize_user_id(user_id: str | None) -> str:
    """Resolve a principal to a bucket key (mirrors inbox/user_prefs.normalize_user_id).
    Empty / None → the shared ``default`` bucket (the no-auth profile)."""
    uid = (user_id or "").strip().lower()
    return uid or USER_PREFS_DEFAULT_BUCKET


class DashboardStore:
    """CRUD over per-user custom dashboards, persisted as one KV document.

    The KV value is ``{"dashboards": {"<user_id>": {"<dash_id>": <DashboardLayout>}}}``.
    Reads never raise (a failure logs + returns an empty set); writes go through the
    CAS ``kv_mutate`` helper (per-store lock + ``_rev`` retry) so concurrent writers
    are safe. Every method keys on a NORMALISED user_id so ``'default'`` (auth off)
    and a real username are treated identically."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv
        # Per-store lock serialising the read-modify-write of the shared doc
        # (lost-update safe; see :func:`app.stores.base.kv_mutate`).
        self._lock = asyncio.Lock()

    @staticmethod
    def _decode(doc: dict | None) -> dict[str, dict[str, DashboardLayout]]:
        raw = doc.get("dashboards", {}) if isinstance(doc, dict) else {}
        out: dict[str, dict[str, DashboardLayout]] = {}
        for uid, board_map in (raw or {}).items():
            boards: dict[str, DashboardLayout] = {}
            for did, item in (board_map or {}).items():
                try:
                    layout = DashboardLayout.model_validate(item)
                except Exception:  # noqa: BLE001 — skip a corrupt dashboard, keep the rest
                    continue
                # Keep the map key authoritative (an id mismatch normalises to the key).
                if layout.id != str(did):
                    layout = layout.model_copy(update={"id": str(did)})
                boards[str(did)] = layout
            out[str(uid)] = boards
        return out

    @staticmethod
    def _encode(users: dict[str, dict[str, DashboardLayout]]) -> dict:
        return {
            "dashboards": {
                uid: {did: layout.model_dump(mode="json") for did, layout in boards.items()}
                for uid, boards in users.items()
            }
        }

    async def _load_all(self) -> dict[str, dict[str, DashboardLayout]]:
        try:
            doc = await self._kv.get(DASHBOARDS_NS, DASHBOARDS_KEY)
        except Exception as exc:  # noqa: BLE001 — dashboards are best-effort
            logger.warning("Loading dashboards failed (%s); using empty set", exc)
            return {}
        return self._decode(doc)

    async def _mutate(self, change: Callable[[dict[str, dict[str, DashboardLayout]]], _T]) -> _T:
        """Atomic, lost-update-safe read-modify-write over the shared dashboards doc.

        ``change`` is applied to a FRESH decode of the current value (it may run more
        than once on a CAS retry) and both mutates the users→boards map AND stashes a
        result to return. Mirrors the ``inbox.py`` / ``tuning.py`` CAS pattern. Never
        raises."""
        box: dict[str, _T] = {}

        def _mutator(current: dict | None) -> dict:
            users = self._decode(current)
            box["r"] = change(users)
            return self._encode(users)

        await kv_mutate(self._kv, DASHBOARDS_NS, DASHBOARDS_KEY, _mutator, lock=self._lock)
        return box.get("r")  # type: ignore[return-value]

    # ---- reads ----------------------------------------------------------- #
    async def list_for_user(self, user_id: str | None) -> list[DashboardLayout]:
        """A user's custom dashboards (created-oldest first), or []. Read-only."""
        uid = normalize_user_id(user_id)
        boards = (await self._load_all()).get(uid, {})
        return sorted(boards.values(), key=lambda d: d.created_at)

    async def get(self, user_id: str | None, dashboard_id: str) -> DashboardLayout | None:
        """One dashboard by id for a user, or None. Read-only."""
        uid = normalize_user_id(user_id)
        return (await self._load_all()).get(uid, {}).get(str(dashboard_id))

    # ---- writes (CAS-safe) ----------------------------------------------- #
    async def save(self, user_id: str | None, layout: DashboardLayout) -> DashboardLayout:
        """Create or REPLACE one dashboard (keyed by ``layout.id``). Stamps
        ``updated_at`` (and ``created_at`` on first create). Trims the user's set to
        the backstop cap (oldest-created dropped). Returns the stored dashboard."""
        uid = normalize_user_id(user_id)

        def _change(users: dict[str, dict[str, DashboardLayout]]) -> DashboardLayout:
            boards = dict(users.get(uid, {}))
            existing = boards.get(layout.id)
            update = {"updated_at": iso_now()}
            # Preserve the original create instant on a replace.
            if existing is not None and existing.created_at:
                update["created_at"] = existing.created_at
            stored = layout.model_copy(update=update)
            boards[layout.id] = stored
            # Backstop cap: keep the newest-by-create N (a fresh create just added is
            # newest so it survives; the OLDEST-created is trimmed if over the cap).
            if len(boards) > _MAX_PER_USER:
                keep = sorted(boards.values(), key=lambda d: d.created_at)[-_MAX_PER_USER:]
                boards = {d.id: d for d in keep}
            users[uid] = boards
            return boards[layout.id]

        return await self._mutate(_change)

    async def delete(self, user_id: str | None, dashboard_id: str) -> bool:
        """Drop one dashboard. Returns True if it existed."""
        uid = normalize_user_id(user_id)
        did = str(dashboard_id)

        def _change(users: dict[str, dict[str, DashboardLayout]]) -> bool:
            boards = dict(users.get(uid, {}))
            if did not in boards:
                return False
            del boards[did]
            users[uid] = boards
            return True

        return await self._mutate(_change)

    async def clear(self, user_id: str | None) -> int:
        """Drop a user's whole dashboard set (e.g. on user delete). Returns the count."""
        uid = normalize_user_id(user_id)

        def _change(users: dict[str, dict[str, DashboardLayout]]) -> int:
            n = len(users.get(uid, {}))
            users.pop(uid, None)
            return n

        return await self._mutate(_change)
