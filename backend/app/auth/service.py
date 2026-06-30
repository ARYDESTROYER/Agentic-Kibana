"""The authentication service: users + password verification + JWT sessions.

:class:`AuthService` is the single object the orchestrator wires into the app. It
holds the toggle (auth on/off), the signing secret, the token lifetime, and the
configured user table. It issues short-lived HS256 JWTs on a successful login and
decodes/validates them on subsequent requests.

Wave 1 (F1/F2) adds real multi-user accounts + roles:

* The user view is a SYNCED in-memory snapshot (lowercase-username ->
  :class:`_Record`) loaded from the persistent ``UserStore`` at startup and refreshed
  via :meth:`set_users` after every mutation. :meth:`authenticate` stays SYNCHRONOUS
  (it reads the snapshot, never the async store) so the login route is unchanged.
* :class:`AuthUser` carries ``role`` + ``must_change_password``; the JWT embeds
  ``role`` and ``mc`` claims, read back (authoritatively from the synced record) in
  :meth:`verify`.
* The env single-admin fallback (``auth_admin_*``) is folded into the base layer as
  a ``super_admin`` so an env-only deployment keeps working with full privileges;
  the persistent store overlays it.
* :meth:`verify` rejects a token whose subject is no longer an ACTIVE user (so
  disabling an account invalidates its sessions on the next request).

Back-compat: :meth:`authenticate` returns the signed TOKEN (as the original did),
so the existing ``/api/auth/login`` route is unchanged.

Stdlib only — see :mod:`app.auth.tokens` and :mod:`app.auth.passwords`.
"""

from __future__ import annotations

import logging
import math
import secrets
import time
from dataclasses import dataclass, field

from app.auth.passwords import hash_password, verify_password
from app.auth.tokens import TokenError, decode, encode
from app.constants import UserRole

log = logging.getLogger(__name__)

# A real (full-iteration) dummy hash so the unknown-user verify costs the SAME as a
# real verify — removes the username-enumeration timing oracle. Computed once.
_DUMMY_HASH = hash_password("tlsoc-timing-equaliser")

_DEFAULT_ROLE = UserRole.ANALYST_TIER1.value

# Wave 2 / F3: the pending half-session (after password OK, before TOTP). It is a
# DISTINCT token kind — a normal session-verify (require_auth) MUST reject it. The
# pending token is short-lived and carries ``mfa: "pending"``.
_MFA_PENDING_SECONDS = 5 * 60  # ~5 minutes to enter the second factor.
_MFA_PENDING_CLAIM = "pending"


@dataclass
class AuthUser:
    """The authenticated principal carried as the token subject (``sub``).

    ``role`` + ``must_change_password`` reflect the CURRENT synced record (so a role
    change / forced reset takes effect immediately). Defaults keep back-compat.

    ``sid`` (Wave 3) is the session-registry id carried as the JWT ``sid`` claim. It
    is ``None`` for a token minted before sessions existed / a token without the
    claim (those are LAZILY registered by the deps layer — never rejected for it),
    so the field is defaulted to keep every prior call site compiling."""

    username: str
    role: str = _DEFAULT_ROLE
    must_change_password: bool = False
    mfa_enabled: bool = False
    sid: str | None = None


@dataclass
class _Record:
    """The synced in-memory view of one account (no secret beyond the hash).

    ``mfa_enabled`` is mirrored so :meth:`login` can decide synchronously whether to
    return a pending half-session; the TOTP SECRET itself is NEVER mirrored here (it
    stays on the persistent User record and is read by the route layer for phase 2)."""

    password_hash: str
    role: str = _DEFAULT_ROLE
    active: bool = True
    must_change_password: bool = False
    groups: list[str] = field(default_factory=list)
    mfa_enabled: bool = False


@dataclass
class _LockoutPolicy:
    """The in-memory mirror of ``Preferences.lockout`` consulted by the synchronous
    :meth:`AuthService.authenticate`. Refreshed via :meth:`set_lockout_policy`."""

    enabled: bool = True
    max_attempts: int = 5
    window_seconds: int = 900
    lockout_seconds: int = 900


@dataclass
class _LockState:
    """Per-account failed-login bookkeeping (in-memory, per process).

    ``fails`` counts CONSECUTIVE failures within the staleness window; ``last_fail``
    is the monotonic timestamp of the most recent failure (used to expire a stale
    counter); ``locked_until`` is the monotonic deadline the lock auto-clears at
    (``0.0`` when not currently locked)."""

    fails: int = 0
    last_fail: float = 0.0
    locked_until: float = 0.0


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
        Env-supplied ``username -> password_hash`` map (``auth_users`` + the single
        admin). Forms the BASE layer of the synced view; the persistent store
        overlays it via :meth:`set_users`. The single admin (matching
        ``admin_username``) is granted ``super_admin``; any other env user gets the
        default role.
    admin_username:
        The env single-admin's username (granted ``super_admin`` in the base layer).
    """

    def __init__(
        self,
        *,
        enabled: bool,
        jwt_secret: str,
        token_hours: int,
        users: dict[str, str] | None = None,
        admin_username: str = "admin",
        mfa_enforce_roles: list[str] | None = None,
    ) -> None:
        self._enabled = bool(enabled)
        self._token_seconds = max(1, int(token_hours) * 3600)
        self._admin_username = admin_username
        # Roles for which an MFA challenge is required even before the user enrolled
        # (they'll be routed to set up MFA). Refreshed via set_mfa_enforce_roles().
        self._mfa_enforce_roles: set[str] = {str(r) for r in (mfa_enforce_roles or [])}
        # Wave 3: a SYNCED snapshot of each user's current session ``token_version``
        # (from the persistent SessionStore), so the synchronous mint sites
        # (authenticate / mint_session) can stamp the correct ``tv`` claim WITHOUT an
        # async store read. Refreshed via :meth:`set_session_versions`; absent users
        # default to 0 (back-compat: a never-bumped user). The full SessionStore (the
        # async revocation/expiry check) lives in AppState, consulted by the deps
        # layer — verify() stays sync + I/O-free.
        self._session_versions: dict[str, int] = {}

        # Account lockout / brute-force throttle (per-account, in-memory). The policy
        # mirrors Preferences.lockout (refreshed via set_lockout_policy); _lockouts is
        # the live per-account failed-login bookkeeping, keyed by lowercased username.
        # In-memory ONLY (like the per-IP rate limiter) — lost on restart (fail-open),
        # not shared across workers; keeps authenticate() synchronous + I/O-free.
        self._lockout_policy = _LockoutPolicy()
        self._lockouts: dict[str, _LockState] = {}

        # The env-supplied accounts form the BASE layer; store users overlay it via
        # set_users(). The env admin is super_admin; other env users get the default.
        self._base: dict[str, _Record] = {}
        for uname, h in (users or {}).items():
            role = UserRole.SUPER_ADMIN.value if uname == admin_username else _DEFAULT_ROLE
            self._base[uname.strip().lower()] = _Record(password_hash=h, role=role, active=True)
        # The live, lookup-keyed-by-lowercase view (base, store overlay on top).
        self._records: dict[str, _Record] = dict(self._base)

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

    def set_users(self, store_users: list) -> None:
        """Refresh the synced view from the persistent ``UserStore`` (call after the
        startup load + after every user mutation). ``store_users`` is a list of
        :class:`app.models.User`. The store overlays the env base layer (an
        operator-edited account overrides an env-seeded one). Keeps
        :meth:`authenticate` synchronous."""
        view: dict[str, _Record] = dict(self._base)
        for u in store_users or []:
            view[str(u.username).strip().lower()] = _Record(
                password_hash=u.password_hash,
                role=str(getattr(u.role, "value", u.role) or _DEFAULT_ROLE),
                active=bool(u.active),
                must_change_password=bool(u.must_change_password),
                groups=list(getattr(u, "groups", []) or []),
                mfa_enabled=bool(getattr(u, "mfa_enabled", False)),
            )
        self._records = view

    def set_mfa_enforce_roles(self, roles: list[str] | None) -> None:
        """Refresh the set of roles for which MFA is enforced (from
        ``Preferences.mfa.enforce_for_roles``). Called on prefs reload so a settings
        change takes effect without a restart; does not touch the user view."""
        self._mfa_enforce_roles = {str(r) for r in (roles or [])}

    def set_lockout_policy(self, policy: object | None) -> None:
        """Refresh the account-lockout policy from ``Preferences.lockout`` (called on
        wire + on prefs reload so a settings change takes effect without a restart).
        Accepts the Pydantic ``LockoutPolicyConfig`` (or any object exposing the same
        attributes); ``None`` keeps the current policy. Does NOT clear existing
        counters — disabling the policy simply stops it being consulted."""
        if policy is None:
            return
        self._lockout_policy = _LockoutPolicy(
            enabled=bool(getattr(policy, "enabled", True)),
            max_attempts=max(1, int(getattr(policy, "max_attempts", 5) or 5)),
            window_seconds=max(1, int(getattr(policy, "window_seconds", 900) or 900)),
            lockout_seconds=max(1, int(getattr(policy, "lockout_seconds", 900) or 900)),
        )

    # ----- Account lockout (brute-force throttle) ----------------------------- #
    def _lockout_key(self, username: str) -> str:
        return (username or "").strip().lower()

    def _locked_remaining(self, key: str) -> float:
        """Seconds until ``key``'s lock auto-clears, or 0.0 if not locked. Expires a
        stale lock in passing so the dict self-heals."""
        st = self._lockouts.get(key)
        if st is None or st.locked_until <= 0.0:
            return 0.0
        remaining = st.locked_until - time.monotonic()
        if remaining <= 0.0:
            # Cooldown elapsed — clear the lock (and the counter) so the next attempt
            # starts fresh.
            self._lockouts.pop(key, None)
            return 0.0
        return remaining

    def _record_failure(self, key: str) -> None:
        """Count a failed password attempt for a KNOWN active account and trip the
        lock at ``max_attempts``. A failure older than the staleness window resets the
        counter first (so non-consecutive fails don't accumulate forever)."""
        pol = self._lockout_policy
        now = time.monotonic()
        st = self._lockouts.get(key)
        if st is None or (st.fails and now - st.last_fail > pol.window_seconds):
            st = _LockState()
            self._lockouts[key] = st
        st.fails += 1
        st.last_fail = now
        if st.fails >= pol.max_attempts:
            st.locked_until = now + pol.lockout_seconds

    def is_locked(self, username: str) -> bool:
        """Whether ``username`` is currently locked out (policy enabled + within an
        active cooldown). Cheap + side-effect-free beyond expiring a stale lock."""
        if not self._lockout_policy.enabled:
            return False
        return self._locked_remaining(self._lockout_key(username)) > 0.0

    def lockout_state(self, username: str) -> dict | None:
        """A small status dict for ``username`` when LOCKED, else ``None``. Used by the
        login route to return a 429 + ``Retry-After`` and by the admin user view.
        ``retry_after`` is whole seconds (rounded up, min 1)."""
        if not self._lockout_policy.enabled:
            return None
        key = self._lockout_key(username)
        remaining = self._locked_remaining(key)
        if remaining <= 0.0:
            return None
        st = self._lockouts.get(key)
        return {
            "locked": True,
            "retry_after": max(1, int(math.ceil(remaining))),
            "failed_attempts": int(st.fails) if st else self._lockout_policy.max_attempts,
        }

    def unlock(self, username: str) -> bool:
        """Clear ``username``'s lockout + failed-attempt counter (admin action / a
        successful login). Returns ``True`` if state was actually cleared."""
        return self._lockouts.pop(self._lockout_key(username), None) is not None

    def base_usernames(self) -> list[str]:
        """The env-supplied BASE-layer usernames (the env single-admin +
        ``auth_users``), lowercased. These accounts are NOT persisted in the
        UserStore, so any caller building the per-user session ``token_version``
        snapshot from ``users.list()`` alone would OMIT them — leaving their synced
        ``tv`` at the default 0 even after a revoke-all bumped the persistent tv to
        ≥1, which permanently locks the env-admin out (every fresh login stamps
        tv=0 < current_tv → reauth_required). Union these into the snapshot so the
        env-admin's ``tv`` tracks the SessionStore like a stored user."""
        return list(self._base.keys())

    def set_session_versions(self, versions: dict[str, int] | None) -> None:
        """Refresh the synced per-user session ``token_version`` snapshot (Wave 3)
        from the persistent SessionStore. Called on startup + after a revoke-all so
        the next mint stamps the BUMPED ``tv`` (and the synchronous mint sites never
        do an async read). Keys are lowercased usernames; missing users default 0."""
        self._session_versions = {
            str(k).strip().lower(): int(v or 0) for k, v in (versions or {}).items()
        }

    def _token_version_for(self, username: str) -> int:
        """The current session ``token_version`` for ``username`` from the synced
        snapshot (0 when never bumped). Synchronous — used by the mint sites."""
        return int(self._session_versions.get((username or "").strip().lower(), 0) or 0)

    @staticmethod
    async def purge_user_side_state(
        username: str,
        *,
        inbox: object | None = None,
        notif_prefs: object | None = None,
        user_prefs: object | None = None,
        custom_roles: object | None = None,
    ) -> None:
        """Best-effort cleanup of a deleted user's per-user side-state.

        Deleting a user removes the account RECORD, but their per-user buckets in the
        collaboration / notification KV stores are keyed by username and would
        otherwise OUTLIVE the record — so a re-created same-name user would INHERIT
        the deleted user's inbox + notification prefs. This hook clears that
        side-state so the delete is complete and a name re-use starts clean.

        Wire it from the user-delete route immediately AFTER ``users.delete`` (e.g.
        ``await state.auth.purge_user_side_state(username, inbox=state.inbox,
        notif_prefs=state.notif_prefs)``). Each store is OPTIONAL + getattr-guarded
        so the no-auth / offline profiles (where a store is absent) are unaffected.

        NEVER raises: a cleanup failure logs and is swallowed so it can never block
        the delete itself (the account record is already gone). The cleared stores
        are the per-user KV buckets ONLY — the authoritative audit / case feed is
        untouched (it intentionally retains the actor's historical rows, #2).
        """
        uname = (username or "").strip()
        if not uname:
            return
        # (label, store, method, args) — each cleared independently so one failure
        # doesn't skip the rest.
        targets = [
            ("inbox", inbox, "clear", (uname,)),
            ("notif_prefs", notif_prefs, "delete", (uname,)),
            ("user_prefs", user_prefs, "delete", (uname,)),
            # Custom roles are org-scoped definitions (not a per-user assignment),
            # so there is nothing username-keyed to drop; the parameter is accepted
            # for forward-compat / symmetry and only used if a delete(user) exists.
            ("custom_roles", custom_roles, "delete_assignment", (uname,)),
        ]
        for label, store, method, args in targets:
            if store is None:
                continue
            fn = getattr(store, method, None)
            if not callable(fn):
                continue
            try:
                result = fn(*args)
                if hasattr(result, "__await__"):
                    await result
            except Exception as exc:  # noqa: BLE001 — cleanup is best-effort
                log.warning("purge_user_side_state(%s): clearing %s failed: %s",
                            uname, label, exc)

    @staticmethod
    def _new_sid() -> str:
        """A fresh opaque 128-bit session id (hex) for the JWT ``sid`` claim."""
        from .. stores.sessions import new_sid

        return new_sid()

    def _lookup(self, username: str) -> _Record | None:
        return self._records.get((username or "").strip().lower())

    def authenticate(self, username: str, password: str) -> str | None:
        """Verify credentials; return a signed JWT on success, else ``None``.

        SYNCHRONOUS (reads the synced view, never the async store). A disabled
        account never authenticates. The JWT embeds the role + must-change flag plus
        a fresh ``sid`` (Wave 3 session id) + the user's current ``tv``
        (token_version). The route layer registers the ``sid`` in the SessionStore at
        the cookie-set site; an unregistered sid on a validly-signed token is lazily
        registered by the deps layer (never rejected)."""
        key = self._lockout_key(username)
        # Account lockout (brute-force throttle): a locked account never reaches the
        # real hash compare, but STILL runs the dummy verify so the timing/enumeration
        # profile is identical to a normal failure (no oracle). A locked attempt does
        # NOT extend the cooldown — the lock is a fixed window from the tripping fail.
        if self._lockout_policy.enabled and self._locked_remaining(key) > 0.0:
            verify_password(password or "", _DUMMY_HASH)
            return None
        rec = self._lookup(username)
        if rec is None or not rec.active or not rec.password_hash:
            # Verify against a real full-iteration dummy hash so an unknown/disabled
            # user costs the same as a known active one (no timing enumeration).
            # NOTE: unknown/inactive accounts are NOT counted — an attacker cannot lock
            # out an account they merely name, nor bloat memory by enumerating names.
            verify_password(password or "", _DUMMY_HASH)
            return None
        if not verify_password(password or "", rec.password_hash):
            if self._lockout_policy.enabled:
                self._record_failure(key)
            return None
        # Success — clear any accumulated failed-attempt / lock state for this account.
        if key in self._lockouts:
            self._lockouts.pop(key, None)
        return encode(
            {
                "sub": username, "role": rec.role, "mc": rec.must_change_password,
                "sid": self._new_sid(), "tv": self._token_version_for(username),
            },
            self._jwt_secret,
            expires_in_s=self._token_seconds,
        )

    def claims_of(self, token: str) -> dict | None:
        """Decode a token and return its raw claims (incl. ``sid``/``tv``), or None on
        any error. Used by the route layer to register the freshly-minted sid + by
        the deps layer to read sid/tv for the async session check. NEVER mutates
        state; the JWT signature is the root of trust here."""
        if not token:
            return None
        try:
            return decode(token, self._jwt_secret)
        except TokenError:
            return None

    def principal(self, username: str) -> AuthUser | None:
        """The :class:`AuthUser` for ``username`` from the synced view (role +
        must-change), or ``None`` if unknown/inactive. Used by the login route to
        build the ``user`` object alongside the token."""
        rec = self._lookup(username)
        if rec is None or not rec.active:
            return None
        return AuthUser(
            username=username,
            role=rec.role,
            must_change_password=rec.must_change_password,
            mfa_enabled=rec.mfa_enabled,
        )

    def login(self, username: str, password: str) -> tuple[str, AuthUser] | None:
        """Authenticate and, on success, return ``(token, AuthUser)``; else ``None``.

        Convenience for the login route: pairs the minted token with the principal
        (role + must-change) so the response can surface the ``user`` object."""
        token = self.authenticate(username, password)
        if token is None:
            return None
        user = self.principal(username)
        if user is None:  # pragma: no cover — authenticate succeeded, so principal exists
            return None
        return token, user

    # ----- MFA (Wave 2 / F3) -------------------------------------------------- #
    def requires_mfa(self, username: str) -> bool:
        """Whether ``username`` must clear a second factor before getting a session:
        the user has MFA enabled, OR its role is in the enforce-for-roles set."""
        rec = self._lookup(username)
        if rec is None or not rec.active:
            return False
        return bool(rec.mfa_enabled) or (rec.role in self._mfa_enforce_roles)

    def mfa_enabled(self, username: str) -> bool:
        """Whether ``username`` currently has MFA ENROLLED (from the synced view).
        Lets /auth/me surface ``mfa_enabled`` without an async store read."""
        rec = self._lookup(username)
        return bool(rec and rec.mfa_enabled)

    def begin_mfa(self, username: str) -> str:
        """Mint a SHORT-LIVED pending half-session token (``mfa:"pending"``) for
        ``username``. It is NOT a full session — :meth:`verify` rejects it — so it
        can only be exchanged via :meth:`mint_session` after the second factor."""
        return encode(
            {"sub": username, "mfa": _MFA_PENDING_CLAIM},
            self._jwt_secret,
            expires_in_s=_MFA_PENDING_SECONDS,
        )

    def pending_subject(self, pending_token: str) -> str | None:
        """Validate a pending token and return its subject username, or ``None``.

        Accepts ONLY a token carrying the ``mfa:"pending"`` claim whose subject is
        still an active user. A full session token is rejected here (wrong kind)."""
        if not pending_token:
            return None
        try:
            claims = decode(pending_token, self._jwt_secret)
        except TokenError:
            return None
        if claims.get("mfa") != _MFA_PENDING_CLAIM:
            return None
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            return None
        rec = self._lookup(sub)
        if rec is None or not rec.active:
            return None
        return sub

    def mint_session(self, username: str) -> tuple[str, AuthUser] | None:
        """Mint a FULL session token for ``username`` WITHOUT a password check —
        used after a second factor (TOTP/recovery) or a verified SSO login has
        already established the identity. Returns ``(token, AuthUser)`` or ``None``
        if the user is unknown/inactive."""
        rec = self._lookup(username)
        if rec is None or not rec.active:
            return None
        sid = self._new_sid()
        token = encode(
            {
                "sub": username, "role": rec.role, "mc": rec.must_change_password,
                "sid": sid, "tv": self._token_version_for(username),
            },
            self._jwt_secret,
            expires_in_s=self._token_seconds,
        )
        user = self.principal(username)
        if user is None:  # pragma: no cover — rec exists, so principal exists
            return None
        user.sid = sid
        return token, user

    def verify(self, token: str) -> AuthUser | None:
        """Decode + validate ``token``; return the :class:`AuthUser` or ``None``.

        A token whose subject is no longer an ACTIVE user is rejected (so disabling
        an account invalidates its live sessions). The role/must-change reflect the
        CURRENT synced record (not the stale token claim) so a role change takes
        effect immediately."""
        if not token:
            return None
        try:
            claims = decode(token, self._jwt_secret)
        except TokenError:
            return None
        # A pending MFA half-session is NOT a full session — reject it here so it can
        # never be presented to a protected route (it is only valid at /auth/mfa/verify).
        if claims.get("mfa") == _MFA_PENDING_CLAIM:
            return None
        sub = claims.get("sub")
        if not isinstance(sub, str) or not sub:
            return None
        rec = self._lookup(sub)
        if rec is None or not rec.active:
            return None
        sid = claims.get("sid")
        return AuthUser(
            username=sub,
            role=rec.role,
            must_change_password=rec.must_change_password,
            mfa_enabled=rec.mfa_enabled,
            sid=sid if isinstance(sid, str) and sid else None,
        )
