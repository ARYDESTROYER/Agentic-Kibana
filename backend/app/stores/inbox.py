"""Per-user INBOX store — in-app notification fan-out (Round 3).

An inbox item (:class:`app.models.InAppNotification`) is one notification fanned out
to ONE recipient (a case event / mention / assignment / approval / system / digest).
It is advisory only — it NEVER feeds ``case_manager.decide()`` (#3) — and every
``title``/``body`` is plain, render-escaped data (#9).

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory` / :mod:`app.stores.user_prefs`): the WHOLE inbox set is ONE
KV document (``ns=INBOX_NS``, ``key=INBOX_KEY``) whose value is
``{"items": {"<user_id>": [<InAppNotification json>, ...], ...}}`` — so it needs NO
new ES index / SQL table / migration. The SQL backend uses ``SqlKVStore``; the ES
backend uses the thin :class:`app.stores.memory.EsKVStore` adapter.

Per-user fan-out: a notification is appended to the recipient's bucket (keyed by a
NORMALISED user id, ``'default'`` when auth is off). The bucket is a BOUNDED ring
(~200 items/user) — the OLDEST are trimmed so a busy operator's inbox can't grow
without bound. Reads + writes are read-modify-write. The store NEVER raises: a
failure degrades to an empty inbox / best-effort write and is logged.
"""

from __future__ import annotations

import logging

from ..constants import INBOX_KEY, INBOX_NS, USER_PREFS_DEFAULT_BUCKET
from ..models import InAppNotification
from ..utils import iso_now
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.inbox")

# Bounded ring: keep at most this many items per user (trim the OLDEST). A read /
# unread inbox is a UI affordance, not an audit trail — the authoritative record is
# the audit log / case feed.
_MAX_PER_USER = 200

# Lifecycle states (mirrors InAppNotification.state); a dismissed item is dropped.
_READ_STATES = {"read", "archived"}


def normalize_user_id(user_id: str | None) -> str:
    """Resolve a recipient to a bucket key (mirrors user_prefs.normalize_user_id).
    Empty / None → the shared ``default`` bucket (the no-auth profile)."""
    uid = (user_id or "").strip().lower()
    return uid or USER_PREFS_DEFAULT_BUCKET


class InboxStore:
    """Per-user in-app notification inbox, persisted as one KV document.

    The KV value is ``{"items": {"<user_id>": [<InAppNotification json>, ...]}}``.
    Methods are read-modify-write; none raises. Each user's list is a bounded ring
    (newest appended; oldest trimmed) and is surfaced NEWEST first."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def _load_all(self) -> dict[str, list[InAppNotification]]:
        try:
            doc = await self._kv.get(INBOX_NS, INBOX_KEY)
        except Exception as exc:  # noqa: BLE001 — inbox is best-effort
            logger.warning("Loading inbox failed (%s); using empty set", exc)
            return {}
        if not doc:
            return {}
        raw = doc.get("items", {}) if isinstance(doc, dict) else {}
        out: dict[str, list[InAppNotification]] = {}
        for uid, items in (raw or {}).items():
            notes: list[InAppNotification] = []
            for item in items or []:
                try:
                    notes.append(InAppNotification.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt item, keep the rest
                    continue
            out[str(uid)] = notes
        return out

    async def _save_all(self, inboxes: dict[str, list[InAppNotification]]) -> None:
        try:
            await self._kv.put(
                INBOX_NS, INBOX_KEY,
                {"items": {uid: [n.model_dump(mode="json") for n in notes]
                           for uid, notes in inboxes.items()}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting inbox failed (%s); continuing", exc)

    async def append(self, notification: InAppNotification) -> InAppNotification:
        """Fan ONE notification out to ``notification.recipient`` (keyed by a
        normalised user id). Trims the recipient's ring to the cap (oldest dropped).
        Returns the stored notification."""
        uid = normalize_user_id(notification.recipient)
        inboxes = await self._load_all()
        notes = list(inboxes.get(uid, []))
        notes.append(notification)
        if len(notes) > _MAX_PER_USER:
            notes = notes[-_MAX_PER_USER:]
        inboxes[uid] = notes
        await self._save_all(inboxes)
        return notification

    async def fanout(self, recipients: list[str], build) -> list[InAppNotification]:
        """Convenience multi-recipient fan-out: for each recipient call
        ``build(recipient) -> InAppNotification`` and append it. One read-modify-write
        for the whole batch. Returns the appended notifications."""
        inboxes = await self._load_all()
        created: list[InAppNotification] = []
        for r in recipients:
            try:
                note = build(r)
            except Exception:  # noqa: BLE001 — one bad recipient must not drop the batch
                continue
            uid = normalize_user_id(note.recipient or r)
            notes = list(inboxes.get(uid, []))
            notes.append(note)
            if len(notes) > _MAX_PER_USER:
                notes = notes[-_MAX_PER_USER:]
            inboxes[uid] = notes
            created.append(note)
        if created:
            await self._save_all(inboxes)
        return created

    async def list_for_user(self, user_id: str | None, *, unread_only: bool = False,
                            limit: int = 50, offset: int = 0) -> tuple[list[InAppNotification], int]:
        """A user's inbox NEWEST first, paginated → ``(items, total_matching)``.

        ``unread_only`` filters to ``state in {unseen, seen}`` (i.e. not yet read /
        archived). ``archived`` items are excluded from the default view."""
        uid = normalize_user_id(user_id)
        notes = list((await self._load_all()).get(uid, []))
        notes = list(reversed(notes))  # newest first
        if unread_only:
            notes = [n for n in notes if n.state in ("unseen", "seen")]
        else:
            notes = [n for n in notes if n.state != "archived"]
        total = len(notes)
        if offset:
            notes = notes[offset:]
        if limit and limit > 0:
            notes = notes[:limit]
        return notes, total

    async def unread_count(self, user_id: str | None) -> int:
        """Count of not-yet-read items (``state in {unseen, seen}``) — the badge."""
        uid = normalize_user_id(user_id)
        notes = (await self._load_all()).get(uid, [])
        return sum(1 for n in notes if n.state in ("unseen", "seen"))

    async def mark_read(self, user_id: str | None, notification_id: str) -> InAppNotification | None:
        """Mark one item read (stamps ``read_at``). Returns the updated item, or None."""
        uid = normalize_user_id(user_id)
        inboxes = await self._load_all()
        notes = list(inboxes.get(uid, []))
        updated: InAppNotification | None = None
        for idx, n in enumerate(notes):
            if n.id != notification_id:
                continue
            updated = n.model_copy(update={"state": "read", "read_at": iso_now()})
            notes[idx] = updated
            break
        if updated is not None:
            inboxes[uid] = notes
            await self._save_all(inboxes)
        return updated

    async def mark_all_read(self, user_id: str | None) -> int:
        """Mark every not-yet-read item read. Returns the count marked."""
        uid = normalize_user_id(user_id)
        inboxes = await self._load_all()
        notes = list(inboxes.get(uid, []))
        now = iso_now()
        count = 0
        for idx, n in enumerate(notes):
            if n.state in ("unseen", "seen"):
                notes[idx] = n.model_copy(update={"state": "read", "read_at": now})
                count += 1
        if count:
            inboxes[uid] = notes
            await self._save_all(inboxes)
        return count

    async def archive(self, user_id: str | None, notification_id: str) -> InAppNotification | None:
        """Archive one item (hidden from the default inbox view; kept in the ring).
        Returns the updated item, or None."""
        uid = normalize_user_id(user_id)
        inboxes = await self._load_all()
        notes = list(inboxes.get(uid, []))
        updated: InAppNotification | None = None
        for idx, n in enumerate(notes):
            if n.id != notification_id:
                continue
            patch = {"state": "archived"}
            if not n.read_at:
                patch["read_at"] = iso_now()
            updated = n.model_copy(update=patch)
            notes[idx] = updated
            break
        if updated is not None:
            inboxes[uid] = notes
            await self._save_all(inboxes)
        return updated

    async def dismiss(self, user_id: str | None, notification_id: str) -> bool:
        """Permanently DROP one item from a user's inbox. Returns True if it existed."""
        uid = normalize_user_id(user_id)
        inboxes = await self._load_all()
        notes = list(inboxes.get(uid, []))
        remaining = [n for n in notes if n.id != notification_id]
        if len(remaining) == len(notes):
            return False
        inboxes[uid] = remaining
        await self._save_all(inboxes)
        return True

    async def clear(self, user_id: str | None) -> int:
        """Drop a user's whole inbox (e.g. on user delete). Returns the count removed."""
        uid = normalize_user_id(user_id)
        inboxes = await self._load_all()
        n = len(inboxes.get(uid, []))
        if uid in inboxes:
            del inboxes[uid]
            await self._save_all(inboxes)
        return n
