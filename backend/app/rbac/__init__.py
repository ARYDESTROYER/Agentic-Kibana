"""Role-based access control (Wave 1 / F2).

The permission MATRIX is data (:data:`app.rbac.policy.DEFAULT_MATRIX`, operator-
overridable via ``Preferences.rbac.roles``); the ENFORCEMENT is code
(``app.api.deps.require_permission`` / ``require_role``). This package owns only
the pure, fully-unit-testable policy decision (:func:`app.rbac.policy.can`).
"""

from __future__ import annotations

from .policy import DEFAULT_MATRIX, DEFAULT_ROLE, RESOURCES, can, effective_matrix, resolve_matrix

__all__ = [
    "DEFAULT_MATRIX",
    "DEFAULT_ROLE",
    "RESOURCES",
    "can",
    "effective_matrix",
    "resolve_matrix",
]
