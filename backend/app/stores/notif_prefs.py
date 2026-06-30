"""Per-user NOTIFICATION-PREFERENCES store — inbox routing (Round 3).

A :class:`app.models.NotificationPref` is ONE user's in-app + channel notification
routing (per :class:`app.constants.NotificationCategory`: ``{channels, enabled}``),
plus optional ``quiet_hours`` / ``digest`` batching. It is config data the dispatcher
+ inbox consult before fan-out — advisory, it NEVER feeds ``case_manager.decide()``
(#3); user-supplied label/value strings are plain data (#9).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.user_prefs`): the WHOLE pref set is ONE KV document
(``ns=NOTIF_PREFS_NS``, ``key=NOTIF_PREFS_KEY``) whose value is
``{"prefs": {"<user_id>": <NotificationPref json>, ...}}`` — so it needs NO new ES
index / SQL table / migration. The SQL backend uses ``SqlKVStore``; the ES backend
uses the thin :class:`app.stores.memory.EsKVStore` adapter.

Keyed by a NORMALISED user id (``'default'`` when auth is off). Reads + writes are
read-modify-write. The store NEVER raises: a failure degrades to sane defaults /
best-effort write and is logged.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import NOTIF_PREFS_KEY, NOTIF_PREFS_NS, USER_PREFS_DEFAULT_BUCKET
from ..models import NotificationPref
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.notif_prefs")


def normalize_user_id(user_id: str | None) -> str:
    """Resolve a user to a bucket key (mirrors user_prefs.normalize_user_id). Empty /
    None → the shared ``default`` bucket (the no-auth profile)."""
    uid = (user_id or "").strip().lower()
    return uid or USER_PREFS_DEFAULT_BUCKET


class NotificationPrefsStore:
    """Per-user notification preferences, persisted as one KV document.

    The KV value is ``{"prefs": {"<user_id>": <NotificationPref json>}}``. Methods
    are read-modify-write; none raises. An unseen user resolves to a sane default
    (every category enabled to the in-app inbox, no quiet-hours, digest off)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    @staticmethod
    def default_for(user_id: str | None) -> NotificationPref:
        """Sane shipped default for a user with nothing stored yet: an empty
        ``categories`` map (the dispatcher treats absent → in-app enabled), no
        quiet-hours, digest off. ``user`` carries the normalised id."""
        return NotificationPref(user=normalize_user_id(user_id), categories={}, digest="off")

    async def _load_all(self) -> dict[str, NotificationPref]:
        try:
            doc = await self._kv.get(NOTIF_PREFS_NS, NOTIF_PREFS_KEY)
        except Exception as exc:  # noqa: BLE001 — prefs are best-effort
            logger.warning("Loading notification prefs failed (%s); using defaults", exc)
            return {}
        if not doc:
            return {}
        raw = doc.get("prefs", {}) if isinstance(doc, dict) else {}
        out: dict[str, NotificationPref] = {}
        for uid, item in (raw or {}).items():
            try:
                out[str(uid)] = NotificationPref.model_validate(item)
            except Exception:  # noqa: BLE001 — skip a corrupt bucket, keep the rest
                continue
        return out

    async def _save_all(self, prefs: dict[str, NotificationPref]) -> None:
        try:
            await self._kv.put(
                NOTIF_PREFS_NS, NOTIF_PREFS_KEY,
                {"prefs": {uid: p.model_dump(mode="json") for uid, p in prefs.items()}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting notification prefs failed (%s); continuing", exc)

    async def get(self, user_id: str | None) -> NotificationPref:
        """A user's notification prefs (a sane default when nothing is stored)."""
        uid = normalize_user_id(user_id)
        return (await self._load_all()).get(uid) or self.default_for(user_id)

    async def list(self) -> dict[str, NotificationPref]:
        """Every stored bucket (admin/debug), keyed by normalised user_id."""
        return await self._load_all()

    async def put(self, user_id: str | None, pref: NotificationPref) -> NotificationPref:
        """Replace a user's whole pref bucket (the route validates the body first).
        ``user`` is forced to the normalised id so the bucket key + body agree."""
        uid = normalize_user_id(user_id)
        pref = pref.model_copy(update={"user": uid})
        prefs = await self._load_all()
        prefs[uid] = pref
        await self._save_all(prefs)
        return pref

    async def patch(self, user_id: str | None, **fields: Any) -> NotificationPref:
        """Patch only the provided (non-None) top-level fields (``categories`` /
        ``quiet_hours`` / ``digest``). Re-validates through the model so the stored
        object is always a real :class:`NotificationPref`."""
        uid = normalize_user_id(user_id)
        prefs = await self._load_all()
        current = prefs.get(uid) or self.default_for(user_id)
        merged = current.model_dump(mode="json")
        for key, value in fields.items():
            if value is None or key == "user":
                continue
            merged[key] = value
        merged["user"] = uid
        updated = NotificationPref.model_validate(merged)
        prefs[uid] = updated
        await self._save_all(prefs)
        return updated

    async def delete(self, user_id: str | None) -> bool:
        """Drop a user's pref bucket (e.g. on user delete → falls back to default).
        Returns True if it existed."""
        uid = normalize_user_id(user_id)
        prefs = await self._load_all()
        if uid not in prefs:
            return False
        del prefs[uid]
        await self._save_all(prefs)
        return True
