"""RBAC permission policy (Wave 1 / F2).

Permissions are MODELLED as data (a ``role -> resource -> [actions]`` matrix) and
ENFORCED in code (:func:`can`). The default matrix lives here; an operator can
override it via ``Preferences.rbac.roles`` (a deep, additive override — an absent
role/resource falls back to this default).

Semantics (the three back-compat modes are decided by the caller in ``deps.py``,
not here):

* auth DISABLED        → everything allowed (the no-auth "old version" default).
* auth ON, rbac OFF    → every authenticated user is treated as ``super_admin``.
* auth ON, rbac ON     → :func:`can` is consulted for every gated action.

A wildcard ``"*"`` action grants ALL actions on a resource (used for super_admin).
``super_admin`` is additionally hard-allowed in :func:`can` so a malformed
override can never lock the platform's owner out.
"""

from __future__ import annotations

from typing import Any

from ..constants import UserRole

# Canonical resource -> actions vocabulary. The webui and the route deps reference
# these names; keep them in sync with the frontend ``Can`` usage.
RESOURCES: dict[str, list[str]] = {
    "cases": ["read", "write", "close", "assign", "comment", "reinvestigate"],
    "sources": ["read", "manage"],
    "settings": ["read", "manage"],
    "users": ["manage"],
    "proposals": ["read", "approve"],
    "playbooks": ["read", "run"],
    "rag": ["read", "manage"],
    "memory": ["read", "manage"],
    "cost": ["view"],
    "audit": ["view"],
    "metrics": ["view"],
}

ALL = "*"  # wildcard action grant

_SUPER_ADMIN: dict[str, list[str]] = {res: [ALL] for res in RESOURCES}

_SOC_MANAGER: dict[str, list[str]] = {
    "cases": [ALL],
    "sources": [ALL],
    "settings": [ALL],
    "users": ["manage"],
    "proposals": [ALL],
    "playbooks": [ALL],
    "rag": [ALL],
    "memory": [ALL],
    "cost": ["view"],
    "audit": ["view"],
    "metrics": ["view"],
}

_ANALYST_TIER2: dict[str, list[str]] = {
    "cases": ["read", "write", "close", "assign", "comment", "reinvestigate"],
    "sources": ["read"],
    "settings": ["read"],
    "proposals": ["read"],
    "playbooks": ["read", "run"],
    "rag": ["read"],
    "memory": ["read"],
    "cost": ["view"],
    "metrics": ["view"],
}

_ANALYST_TIER1: dict[str, list[str]] = {
    "cases": ["read", "write", "comment", "assign"],
    "sources": ["read"],
    "settings": ["read"],
    "proposals": ["read"],
    "playbooks": ["read"],
    "rag": ["read"],
    "memory": ["read"],
    "cost": ["view"],
    "metrics": ["view"],
}

_RESPONDER: dict[str, list[str]] = {
    # analyst_tier1 + playbooks:run + proposals:approve
    "cases": ["read", "write", "comment", "assign"],
    "sources": ["read"],
    "settings": ["read"],
    "proposals": ["read", "approve"],
    "playbooks": ["read", "run"],
    "rag": ["read"],
    "memory": ["read"],
    "cost": ["view"],
    "metrics": ["view"],
}

# Auditor: read/view only across the board — never any write/manage/close/approve.
_AUDITOR: dict[str, list[str]] = {
    "cases": ["read"],
    "sources": ["read"],
    "settings": ["read"],
    "proposals": ["read"],
    "playbooks": ["read"],
    "rag": ["read"],
    "memory": ["read"],
    "cost": ["view"],
    "audit": ["view"],
    "metrics": ["view"],
}

DEFAULT_MATRIX: dict[str, dict[str, list[str]]] = {
    UserRole.SUPER_ADMIN.value: _SUPER_ADMIN,
    UserRole.SOC_MANAGER.value: _SOC_MANAGER,
    UserRole.ANALYST_TIER2.value: _ANALYST_TIER2,
    UserRole.ANALYST_TIER1.value: _ANALYST_TIER1,
    UserRole.RESPONDER.value: _RESPONDER,
    UserRole.AUDITOR.value: _AUDITOR,
}

DEFAULT_ROLE = UserRole.ANALYST_TIER1.value


def _role_str(role: Any) -> str:
    """Normalise a role (``UserRole`` or its string value) to its string form."""
    return str(getattr(role, "value", role))


def _overrides_from_config(rbac_config: Any) -> dict[str, Any]:
    """Pull the per-role override mapping out of an ``RBACConfig`` / dict / None.

    Lenient: returns ``{}`` when there is no usable override (→ pure defaults)."""
    if rbac_config is None:
        return {}
    roles = getattr(rbac_config, "roles", None)
    if roles is None and isinstance(rbac_config, dict):
        roles = rbac_config.get("roles")
    return roles if isinstance(roles, dict) else {}


def effective_matrix(overrides: dict[str, Any] | None = None) -> dict[str, dict[str, list[str]]]:
    """Merge operator ``overrides`` (from ``Preferences.rbac.roles``) onto the
    default matrix. An override REPLACES the action list for a given
    ``role/resource``; roles/resources not mentioned keep their defaults. Unknown
    resources/actions are ignored leniently. Returns a fresh dict (never mutates
    the module-level constant)."""
    merged: dict[str, dict[str, list[str]]] = {
        role: {res: list(acts) for res, acts in res_map.items()}
        for role, res_map in DEFAULT_MATRIX.items()
    }
    for role, res_map in (overrides or {}).items():
        if not isinstance(res_map, dict):
            continue
        bucket = merged.setdefault(str(role), {})
        for res, acts in res_map.items():
            if res not in RESOURCES:
                continue  # ignore unknown resource leniently
            if isinstance(acts, list):
                valid = set(RESOURCES[res]) | {ALL}
                bucket[res] = [str(a) for a in acts if str(a) in valid]
    return merged


def resolve_matrix(rbac_config: Any = None) -> dict[str, dict[str, list[str]]]:
    """The full effective matrix as ``role -> resource -> [actions]`` for the
    ``GET /api/roles`` response, honoring any operator override in ``rbac_config``.
    Pure + JSON-friendly. Every known role is present."""
    return effective_matrix(_overrides_from_config(rbac_config))


def can(
    role: Any,
    resource: str,
    action: str,
    rbac_config: Any = None,
    *,
    matrix: dict[str, dict[str, list[str]]] | None = None,
) -> bool:
    """Return whether ``role`` may perform ``action`` on ``resource``.

    ``super_admin`` is ALWAYS allowed (it cannot be locked out by a bad override).
    A wildcard ``"*"`` action in a role's resource grant allows every action. An
    unknown role / resource denies (deny-by-default).

    The matrix consulted is the DEFAULT merged with any per-role override in
    ``rbac_config`` (an ``RBACConfig`` or dict). Callers with a pre-resolved matrix
    may pass ``matrix=`` directly (it takes precedence over ``rbac_config``)."""
    role_str = _role_str(role)
    if role_str == UserRole.SUPER_ADMIN.value:
        return True
    table = matrix if matrix is not None else resolve_matrix(rbac_config)
    grants = table.get(role_str)
    if not grants:
        return False
    actions = grants.get(resource)
    if not actions:
        return False
    return ALL in actions or action in actions
