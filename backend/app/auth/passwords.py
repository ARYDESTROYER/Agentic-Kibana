"""PBKDF2-SHA256 password hashing (stdlib only).

Stored format (single line, ``$``-delimited)::

    pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>

This mirrors the well-known Django/passlib layout so the value is self-describing
(the iteration count + salt travel with the hash) while depending on nothing
beyond :mod:`hashlib`, :mod:`hmac`, and :mod:`secrets`. There is intentionally no
bcrypt/argon2 here — those are extra dependencies; PBKDF2-SHA256 with a high
iteration count is a sound, FIPS-friendly stdlib choice.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets

_ALGORITHM = "pbkdf2_sha256"
_SALT_BYTES = 16
# Iteration count bumped to 310k (OWASP 2023 PBKDF2-SHA256 guidance). The count is
# embedded in every stored hash, so lower-iteration hashes written by older
# versions still verify transparently — no migration needed.
_DEFAULT_ITERATIONS = 310_000


def hash_password(password: str, *, iterations: int = _DEFAULT_ITERATIONS) -> str:
    """Hash ``password`` and return the self-describing stored string.

    A fresh random 16-byte salt is drawn per call, so hashing the same password
    twice yields different outputs. ``iterations`` is embedded so future cost
    increases verify old hashes transparently.
    """
    if iterations < 1:
        raise ValueError("iterations must be >= 1")
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"{_ALGORITHM}${iterations}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time verify ``password`` against a ``stored`` hash string.

    Returns ``False`` on any malformed/unsupported input and never raises, so
    callers can treat it as a pure predicate even on corrupted records.
    """
    if not isinstance(stored, str):
        return False
    parts = stored.split("$")
    if len(parts) != 4:
        return False
    algorithm, iter_str, salt_hex, hash_hex = parts
    if algorithm != _ALGORITHM:
        return False
    try:
        iterations = int(iter_str)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, TypeError):
        return False
    if iterations < 1 or not salt or not expected:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, expected)
