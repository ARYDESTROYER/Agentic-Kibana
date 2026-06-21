"""Authentication + security primitives (stdlib-only, zero new dependencies).

This package provides the building blocks the orchestrator wires into the app:

- :mod:`app.auth.passwords` — PBKDF2-SHA256 password hashing/verification.
- :mod:`app.auth.tokens`    — a tiny stdlib HS256 JWT (encode/decode + ``TokenError``).
- :mod:`app.auth.service`   — :class:`AuthService` tying users + tokens together,
  plus the :class:`AuthUser` claims subject.

Everything here uses only the Python standard library (``hashlib``, ``hmac``,
``secrets``, ``base64``, ``json``, ``time``) so the suite keeps its zero-new-deps
convention. Companion request-path middleware lives in :mod:`app.middleware`.
"""

from __future__ import annotations

from app.auth.passwords import hash_password, verify_password
from app.auth.service import AuthService, AuthUser
from app.auth.tokens import TokenError, decode, encode

__all__ = [
    "AuthService",
    "AuthUser",
    "TokenError",
    "decode",
    "encode",
    "hash_password",
    "verify_password",
]
