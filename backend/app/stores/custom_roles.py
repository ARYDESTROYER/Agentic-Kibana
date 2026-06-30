"""Custom-RBAC-ROLE store — operator-defined roles (Round 3).

A :class:`app.models.CustomRole` is an operator-defined RBAC role layered ON TOP of
the six built-in :class:`app.constants.UserRole` roles: it ``inherits`` base roles,
``grants`` additional ``resource -> [action]`` permissions, and ``denies`` some
(deny wins). This store CARRIES the role definitions out-of-band from the Preferences
doc (custom roles ALSO ride on ``Preferences.rbac.custom_roles``; this KV namespace
is the admin-managed/out-of-band set a later wave's effective-matrix resolver reads).

Org-scoped: there is one shared bucket (``'default'``) — custom roles are an org-wide
construct, not per-user. Role names are normalised + de-duplicated.

Backend-agnostic by construction (the SAME single-KV-document pattern as
:mod:`app.stores.memory`): the WHOLE role set is ONE KV document
(``ns=CUSTOM_ROLES_NS``, ``key=CUSTOM_ROLES_KEY``) whose value is
``{"roles": {"<scope>": [<CustomRole json>, ...]}}`` — so it needs NO new ES index /
SQL table / migration. The SQL backend uses ``SqlKVStore``; the ES backend uses the
thin :class:`app.stores.memory.EsKVStore` adapter.

Reads + writes are read-modify-write. The store NEVER raises: a failure degrades to
an empty role list / best-effort write and is logged. ``put`` validates a loose dict
into a real :class:`CustomRole`, raising ValueError ONLY on an empty/invalid name (a
caller error), never on a backend failure.
"""

from __future__ import annotations

import logging
from typing import Any

from ..constants import CUSTOM_ROLES_KEY, CUSTOM_ROLES_NS
from ..models import CustomRole
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.custom_roles")

# Org-scoped: one shared bucket. (Kept as a parameter so a future multi-tenant build
# could key by org id without a schema change.)
_DEFAULT_SCOPE = "default"


def _norm_name(name: str | None) -> str:
    return (name or "").strip()


class CustomRoleStore:
    """CRUD over operator-defined custom RBAC roles, persisted as one KV document.

    The KV value is ``{"roles": {"default": [<CustomRole json>, ...]}}``. Methods are
    read-modify-write; none raises on a backend failure. ``put`` validates a loose
    dict into :class:`CustomRole` and upserts by (case-insensitive) name."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    async def _load_all(self) -> dict[str, list[CustomRole]]:
        try:
            doc = await self._kv.get(CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY)
        except Exception as exc:  # noqa: BLE001 — roles are best-effort to LOAD
            logger.warning("Loading custom roles failed (%s); using empty set", exc)
            return {}
        if not doc:
            return {}
        raw = doc.get("roles", {}) if isinstance(doc, dict) else {}
        out: dict[str, list[CustomRole]] = {}
        for scope, items in (raw or {}).items():
            roles: list[CustomRole] = []
            for item in items or []:
                try:
                    roles.append(CustomRole.model_validate(item))
                except Exception:  # noqa: BLE001 — skip a corrupt role, keep the rest
                    continue
            out[str(scope)] = roles
        return out

    async def _save_all(self, all_roles: dict[str, list[CustomRole]]) -> None:
        try:
            await self._kv.put(
                CUSTOM_ROLES_NS, CUSTOM_ROLES_KEY,
                {"roles": {scope: [r.model_dump(mode="json") for r in roles]
                           for scope, roles in all_roles.items()}},
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting custom roles failed (%s); continuing", exc)

    async def list(self, scope: str = _DEFAULT_SCOPE) -> list[CustomRole]:
        """Every custom role in the (org) scope, in stored order."""
        return list((await self._load_all()).get(scope, []))

    async def get(self, name: str, scope: str = _DEFAULT_SCOPE) -> CustomRole | None:
        needle = _norm_name(name).lower()
        for r in await self.list(scope):
            if r.name.strip().lower() == needle:
                return r
        return None

    async def put(self, role: CustomRole | dict[str, Any],
                  scope: str = _DEFAULT_SCOPE) -> CustomRole:
        """Upsert a custom role by name (case-insensitive). Accepts a loose dict
        (validated into :class:`CustomRole`) or a model. Raises ValueError on an
        empty name (a caller error). Returns the stored role."""
        validated = role if isinstance(role, CustomRole) else CustomRole.model_validate(role)
        name = _norm_name(validated.name)
        if not name:
            raise ValueError("custom role name is required")
        validated = validated.model_copy(update={"name": name})
        all_roles = await self._load_all()
        roles = [r for r in all_roles.get(scope, []) if r.name.strip().lower() != name.lower()]
        roles.append(validated)
        all_roles[scope] = roles
        await self._save_all(all_roles)
        return validated

    async def delete(self, name: str, scope: str = _DEFAULT_SCOPE) -> bool:
        """Delete a custom role by name (case-insensitive). Returns True if it
        existed."""
        needle = _norm_name(name).lower()
        all_roles = await self._load_all()
        roles = all_roles.get(scope, [])
        remaining = [r for r in roles if r.name.strip().lower() != needle]
        if len(remaining) == len(roles):
            return False
        all_roles[scope] = remaining
        await self._save_all(all_roles)
        return True
