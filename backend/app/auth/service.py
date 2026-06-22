"""The authentication service: users + password verification + JWT sessions.

:class:`AuthService` is the single object the orchestrator wires into the app. It
holds the toggle (auth on/off), the signing secret, the token lifetime, and the
configured user table (username -> PBKDF2 hash from
:func:`app.auth.passwords.hash_password`). It issues short-lived HS256 JWTs on a
successful login and decodes/validates them on subsequent requests.

Stdlib only — see :mod:`app.auth.tokens` and :mod:`app.auth.passwords`.
"""

from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass

from app.auth.passwords import hash_password, verify_password
from app.auth.tokens import TokenError, decode, encode

log = logging.getLogger(__name__)

# A real (full-iteration) dummy hash so the unknown-user verify costs the SAME as a
# real verify — removes the username-enumeration timing oracle. Computed once.
_DUMMY_HASH = hash_password("tlsoc-timing-equaliser")


@dataclass
class AuthUser:
    """The authenticated principal carried as the token subject (``sub``)."""

    username: str


class AuthService:
    """Verify credentials and mint/validate session tokens.

    Parameters
    ----------
    enabled:
        When ``False`` the service is a no-op gate (callers should treat every
        request as allowed); :meth:`authenticate` / :meth:`verify` still work if
        invoked but the middleware/route layer skips enforcement.
    jwt_secret:
        HMAC signing secret. If auth is enabled but this is falsy, a random
        ephemeral secret is generated and a clear WARNING is logged (sessions
        will not survive a process restart — set a stable secret in production).
    token_hours:
        Session token lifetime in hours.
    users:
        Mapping of ``username -> password_hash`` where each hash comes from
        :func:`app.auth.passwords.hash_password`.
    """

    def __init__(
        self,
        *,
        enabled: bool,
        jwt_secret: str,
        token_hours: int,
        users: dict[str, str],
    ) -> None:
        self._enabled = bool(enabled)
        self._users = dict(users or {})
        self._token_seconds = max(1, int(token_hours) * 3600)

        secret = jwt_secret or ""
        if self._enabled and not secret:
            secret = secrets.token_urlsafe(48)
            log.warning(
                "AuthService: auth is ENABLED but no jwt_secret was provided — "
                "generated a random EPHEMERAL signing secret. Sessions will NOT "
                "survive a restart; set a stable secret (e.g. TLSOC_JWT_SECRET) "
                "for production."
            )
        self._jwt_secret = secret

    @property
    def is_enabled(self) -> bool:
        """Whether authentication enforcement is turned on."""
        return self._enabled

    def authenticate(self, username: str, password: str) -> str | None:
        """Verify credentials; return a signed JWT on success, else ``None``."""
        stored = self._users.get(username)
        if not stored:
            # Verify against a real full-iteration dummy hash so an unknown user
            # costs the same as a known one (no timing-based enumeration).
            verify_password(password or "", _DUMMY_HASH)
            return None
        if not verify_password(password or "", stored):
            return None
        return encode({"sub": username}, self._jwt_secret, expires_in_s=self._token_seconds)

    def verify(self, token: str) -> AuthUser | None:
        """Decode + validate ``token``; return the :class:`AuthUser` or ``None``."""
        if not token:
            return None
        try:
            claims = decode(token, self._jwt_secret)
        except TokenError:
            return None
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            return None
        return AuthUser(username=sub)
