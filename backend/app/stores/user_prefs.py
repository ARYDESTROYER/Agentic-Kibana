"""Per-USER personal-preferences store — pervasive customization (Wave 7).

A user's PERSONAL preferences (saved views, per-table column state, theme mode,
last-used list state, pinned default-view ids, a small misc bag) live here, keyed
by ``user_id``. When auth is OFF there is no principal, so everything lands in the
``default`` bucket — the no-auth profile still gets real, persisted customization.

Backend-agnostic by construction (the same JSON-in-KV pattern as
:mod:`app.stores.memory`): the WHOLE set of buckets is ONE KV document
(``ns="user_prefs"``, ``key="buckets"``) persisted through the existing
:class:`KVStore` abstraction — so it needs NO new ES index / SQL table / migration.
The SQL backend uses ``SqlKVStore`` (the shared KV table); the ES backend uses the
thin :class:`app.stores.memory.EsKVStore` adapter (a doc in the existing config
index).

The two-store customization model: ORG defaults live on
``Preferences.customization`` (admin-only PUT) and PERSONAL prefs live HERE. A
cascade resolver (:func:`resolve_effective_prefs`) merges ``ORG ← USER`` so a user
override always wins, while org-shared saved views remain visible to everyone.

Reads + writes are read-modify-write over the single buckets dict — fine at our
scale (per-user UI config, not log volume). The store NEVER raises: a load/save
failure degrades to an empty bucket / best-effort write and is logged, so a prefs
glitch can never break a page.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import USER_PREFS_DEFAULT_BUCKET, USER_PREFS_KEY, USER_PREFS_NS
from ..models import ColumnState, SavedView, UserPrefs
from ..utils import iso_now
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.user_prefs")


def normalize_user_id(user_id: str | None) -> str:
    """Resolve a principal to a bucket key. Empty / None → the shared ``default``
    bucket (the no-auth profile). Lowercased + trimmed so the same identity maps to
    one bucket regardless of case (mirrors the user store's username normalisation)."""
    uid = (user_id or "").strip().lower()
    return uid or USER_PREFS_DEFAULT_BUCKET


class UserPrefsStore:
    """CRUD over the per-user personal-preferences buckets, persisted as one KV doc.

    The KV value is ``{"buckets": {"<user_id>": <UserPrefs json>, ...}}``. Methods
    are read-modify-write; none raises (a failure logs + returns a safe default).
    Every method keys on a NORMALISED user_id so ``'default'`` (auth off) and a real
    username are treated identically."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def _load_all(self) -> dict[str, UserPrefs]:
        try:
            doc = await self._kv.get(USER_PREFS_NS, USER_PREFS_KEY)
        except Exception as exc:  # noqa: BLE001 — prefs are best-effort
            logger.warning("Loading user prefs failed (%s); using empty set", exc)
            return {}
        if not doc:
            return {}
        raw = doc.get("buckets", {}) if isinstance(doc, dict) else {}
        out: dict[str, UserPrefs] = {}
        for uid, item in (raw or {}).items():
            try:
                out[str(uid)] = UserPrefs.model_validate(item)
            except Exception:  # noqa: BLE001 — skip a single corrupt bucket, keep the rest
                continue
        return out

    async def _save_all(self, buckets: dict[str, UserPrefs]) -> None:
        try:
            await self._kv.put(
                USER_PREFS_NS, USER_PREFS_KEY,
                {"buckets": {uid: p.model_dump(mode="json") for uid, p in buckets.items()}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting user prefs failed (%s); continuing", exc)

    async def get(self, user_id: str | None) -> UserPrefs:
        """The user's personal prefs bucket (an empty default bucket when none stored)."""
        buckets = await self._load_all()
        return buckets.get(normalize_user_id(user_id)) or UserPrefs()

    async def list(self) -> dict[str, UserPrefs]:
        """Every bucket (admin/debug view), keyed by normalised user_id."""
        return await self._load_all()

    async def put(self, user_id: str | None, prefs: UserPrefs) -> UserPrefs:
        """Replace the user's whole bucket (the route validates the body first)."""
        bid = normalize_user_id(user_id)
        buckets = await self._load_all()
        prefs = prefs.model_copy(update={"updated_at": iso_now()})
        buckets[bid] = prefs
        await self._save_all(buckets)
        return prefs

    async def patch(self, user_id: str | None, **fields: Any) -> UserPrefs:
        """Patch only the provided (non-None) top-level fields on the user's bucket.

        Re-validates through the model after the merge so the stored/returned object
        always holds real ``SavedView``/``ColumnState`` instances (the route passes
        the patch as dicts via ``model_dump``; ``model_copy(update=...)`` does NOT
        re-validate, so a bare merge would leave raw dicts in the typed lists)."""
        bid = normalize_user_id(user_id)
        buckets = await self._load_all()
        current = buckets.get(bid) or UserPrefs()
        merged = current.model_dump(mode="json")
        for key, value in fields.items():
            if value is None or key == "updated_at":
                continue
            merged[key] = value
        merged["updated_at"] = iso_now()
        updated = UserPrefs.model_validate(merged)
        buckets[bid] = updated
        await self._save_all(buckets)
        return updated

    async def delete(self, user_id: str | None) -> bool:
        """Drop a user's entire personal-prefs bucket (e.g. on user delete)."""
        bid = normalize_user_id(user_id)
        buckets = await self._load_all()
        if bid not in buckets:
            return False
        del buckets[bid]
        await self._save_all(buckets)
        return True

    # ---- Saved views ----------------------------------------------------- #
    async def list_views(self, user_id: str | None) -> list[SavedView]:
        prefs = await self.get(user_id)
        return list(prefs.saved_views)

    async def get_view(self, user_id: str | None, view_id: str) -> SavedView | None:
        for v in await self.list_views(user_id):
            if v.id == view_id:
                return v
        return None

    async def add_view(self, user_id: str | None, view: SavedView) -> SavedView:
        bid = normalize_user_id(user_id)
        buckets = await self._load_all()
        current = buckets.get(bid) or UserPrefs()
        views = [v for v in current.saved_views if v.id != view.id]
        views.append(view)
        buckets[bid] = current.model_copy(update={"saved_views": views, "updated_at": iso_now()})
        await self._save_all(buckets)
        return view

    async def update_view(
        self, user_id: str | None, view_id: str, **fields: Any
    ) -> SavedView | None:
        bid = normalize_user_id(user_id)
        buckets = await self._load_all()
        current = buckets.get(bid) or UserPrefs()
        allowed = {"name", "scope", "shared", "filters", "sort", "columns"}
        updated: SavedView | None = None
        views = list(current.saved_views)
        for idx, v in enumerate(views):
            if v.id != view_id:
                continue
            patch = {k: val for k, val in fields.items() if k in allowed and val is not None}
            patch["updated_at"] = iso_now()
            updated = v.model_copy(update=patch)
            views[idx] = updated
            break
        if updated is not None:
            buckets[bid] = current.model_copy(
                update={"saved_views": views, "updated_at": iso_now()}
            )
            await self._save_all(buckets)
        return updated

    async def delete_view(self, user_id: str | None, view_id: str) -> bool:
        bid = normalize_user_id(user_id)
        buckets = await self._load_all()
        current = buckets.get(bid) or UserPrefs()
        remaining = [v for v in current.saved_views if v.id != view_id]
        if len(remaining) == len(current.saved_views):
            return False
        # Also drop a now-dangling pin.
        pins = [p for p in current.pinned_view_ids if p != view_id]
        buckets[bid] = current.model_copy(
            update={"saved_views": remaining, "pinned_view_ids": pins, "updated_at": iso_now()}
        )
        await self._save_all(buckets)
        return True

    # ---- Per-table column state ------------------------------------------ #
    async def set_table_state(
        self, user_id: str | None, table_id: str, state: dict[str, Any] | ColumnState | None
    ) -> ColumnState:
        """Set (or clear, when ``state`` is empty/None) ONE table's column state.

        Returns the stored :class:`ColumnState` (an empty one when cleared). A
        focused helper so the UI can persist just one table's layout without
        read-modify-writing the whole prefs object."""
        bid = normalize_user_id(user_id)
        tid = str(table_id or "").strip()
        if not tid:
            raise ValueError("table_id is required")
        buckets = await self._load_all()
        current = buckets.get(bid) or UserPrefs()
        tables = dict(current.tables)
        if state:
            cs = state if isinstance(state, ColumnState) else ColumnState.model_validate(state)
            tables[tid] = cs
        else:
            cs = ColumnState()
            tables.pop(tid, None)
        buckets[bid] = current.model_copy(update={"tables": tables, "updated_at": iso_now()})
        await self._save_all(buckets)
        return cs


# --------------------------------------------------------------------------- #
# Cascade resolver — ORG defaults (Preferences.customization) ← USER overrides.
# --------------------------------------------------------------------------- #
def resolve_effective_prefs(customization: Any, user_prefs: UserPrefs | None) -> dict[str, Any]:
    """Merge the ORG customization defaults with the USER's personal prefs.

    Precedence (a USER override ALWAYS wins over an ORG default, which always wins
    over the shipped built-in defaults):

    * ``terminology`` — ORG label overrides merged UNDER the user's own personal
      labels (a user's label wins; absent → org; absent → built-in default at the UI
      ``t()`` helper).
    * ``theme_mode`` — the user's ``theme_mode`` when it is a non-``system`` value,
      else the org ``default_theme`` (an org can ship a dark-by-default console and a
      user can still pin light/dark for themselves).
    * ``saved_views`` — org-shared views (forced ``shared=True``) UNION the user's
      personal views (a user view with the same id wins).
    * ``pinned_view_ids`` — the user's pins when set, else the org default pins.
    * ``tables`` / ``last_list_state`` / ``misc`` — purely personal (passed through).

    Returns a plain JSON-able dict the ``GET /api/prefs/effective`` route serves; it
    is all PLAIN DATA (#9). Never raises — a missing piece degrades to a safe default.
    """
    up = user_prefs or UserPrefs()

    org_terms: dict[str, str] = dict(getattr(customization, "terminology", {}) or {})
    raw_user_terms = up.misc.get("terminology")
    user_terms = dict(raw_user_terms) if isinstance(raw_user_terms, dict) else {}
    # USER label overrides win over ORG; ORG wins over the built-in (resolved at the UI).
    terminology = {**org_terms, **user_terms}

    org_theme = str(getattr(customization, "default_theme", "system") or "system")
    # A user's explicit non-"system" choice wins; "system" defers to the org default.
    theme_mode = up.theme_mode if up.theme_mode != "system" else org_theme

    # Org-shared saved views (validated/normalised) + the user's personal set.
    org_views: list[SavedView] = []
    for raw in (getattr(customization, "default_saved_views", []) or []):
        try:
            org_views.append(SavedView.model_validate(raw).model_copy(update={"shared": True}))
        except Exception:  # noqa: BLE001 — skip a malformed org view
            continue
    by_id: dict[str, SavedView] = {v.id: v for v in org_views}
    for raw in up.saved_views:  # a personal view with the same id overrides the org one
        # Defensive: a personal view is normally a validated SavedView, but coerce a
        # stray dict (e.g. from a not-yet-revalidated patch) so this never raises.
        try:
            v = raw if isinstance(raw, SavedView) else SavedView.model_validate(raw)
        except Exception:  # noqa: BLE001
            continue
        by_id[v.id] = v
    saved_views = list(by_id.values())

    pinned = up.pinned_view_ids or list(getattr(customization, "default_pinned_view_ids", []) or [])

    return {
        "terminology": terminology,
        "theme_mode": theme_mode,
        "saved_views": [v.model_dump(mode="json") for v in saved_views],
        "pinned_view_ids": list(pinned),
        "tables": {tid: cs.model_dump(mode="json") for tid, cs in up.tables.items()},
        "last_list_state": dict(up.last_list_state),
        "misc": {k: val for k, val in up.misc.items() if k != "terminology"},
        # Echo the org defaults so the UI can show "reset to org default" affordances.
        "org": {
            "terminology": org_terms,
            "default_theme": org_theme,
            "default_saved_views": [v.model_dump(mode="json") for v in org_views],
            "default_pinned_view_ids": list(
                getattr(customization, "default_pinned_view_ids", []) or []
            ),
        },
    }
