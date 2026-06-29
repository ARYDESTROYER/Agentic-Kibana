"""Session registry store — Wave 3 (sessions & access policy).

A SESSION row records ONE issued access/refresh session (a login from one device):
its short, opaque ``sid`` (carried as a JWT claim), the owning ``username``, the
hashed refresh token (+ the previous rotated hash for reuse detection), the
per-user ``token_version`` snapshot, lifecycle timestamps (created / last-active /
last-authn / absolute+idle expiry), revocation bookkeeping, and PLAIN per-session
metadata (ip + best-effort geo, parsed user-agent, client type, mfa method).

Backend-agnostic by construction — the SAME JSON-list-in-KV pattern as
:mod:`app.stores.users` / :mod:`app.stores.memory` / :mod:`app.stores.proposals`:
the WHOLE session set is ONE KV document (``ns="sessions"``, ``key="entries"``), so
it needs NO new ES index / SQL table / migration, and it survives ``AppState._wire``
rebuilds (it is persisted, not held in memory). The SQL backend uses ``SqlKVStore``;
the ES backend uses the thin :class:`app.stores.memory.EsKVStore` adapter (a doc in
the existing config index).

Reads + writes are read-modify-write over the single list — fine at our scale (a
handful of operator devices, not log volume). Pruning (revoked + expired rows past a
grace) keeps the doc bounded. The store NEVER raises on a load: a load failure
degrades to an empty list and is logged.

NON-NEGOTIABLES upheld:
* #9 — ``ip``/``ip_city``/``ip_country``/``ua_*`` are source-controlled metadata and
  are stored + surfaced as PLAIN text (never interpolated into an LLM prompt).
* #10 — no secret is stored here; the refresh token is stored ONLY as a salted hash
  and is NEVER returned to the UI.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import timedelta
from typing import Any

from ..constants import SESSIONS_KEY, SESSIONS_NS
from ..utils import iso_now, now_utc, parse_es_timestamp
from .base import KVStore

logger = logging.getLogger("tlsoc.stores.sessions")

# How long after revocation/expiry a row is kept before pruning (so a just-revoked
# session still produces a clear "revoked"/"expired" reason on the next request,
# and recent history stays visible) — then it is dropped to bound the KV doc.
_PRUNE_GRACE_SECONDS = 7 * 24 * 3600
# Don't let the registry grow without bound even if pruning lags; keep the most
# recent N rows per RMW save.
_MAX_ROWS = 2000

# is_active() rejection reasons (mapped to HTTP error codes by the deps layer).
REASON_REVOKED = "revoked"
REASON_TV_MISMATCH = "tv_mismatch"
REASON_ABSOLUTE = "absolute_expired"
REASON_IDLE = "idle_expired"


def _norm(username: str) -> str:
    return (username or "").strip().lower()


def new_sid() -> str:
    """A fresh opaque 128-bit session id (hex). Carried as the JWT ``sid`` claim."""
    return secrets.token_hex(16)


def hash_refresh(token: str) -> str:
    """Salted SHA-256 of a refresh token (stored at rest; never the raw token).

    A per-token random salt is prefixed (``salt$digest``) so two identical tokens
    don't collide and the stored value can't be reversed via a precomputed table."""
    if not token:
        return ""
    salt = secrets.token_hex(8)
    digest = hashlib.sha256(f"{salt}:{token}".encode("utf-8")).hexdigest()
    return f"{salt}${digest}"


def verify_refresh(token: str, stored: str) -> bool:
    """Constant-time check that ``token`` matches the salted ``stored`` hash."""
    if not token or not stored or "$" not in stored:
        return False
    salt, _, digest = stored.partition("$")
    expected = hashlib.sha256(f"{salt}:{token}".encode("utf-8")).hexdigest()
    return secrets.compare_digest(expected, digest)


def new_refresh_token() -> str:
    """A fresh opaque refresh token (returned to the client ONCE; only its hash is
    persisted). 256 bits of entropy."""
    return secrets.token_urlsafe(32)


def _to_epoch(value: Any) -> float | None:
    dt = parse_es_timestamp(value)
    return dt.timestamp() if dt is not None else None


class SessionStore:
    """CRUD over the session list, persisted as one KV document.

    The KV value is ``{"entries": [<session-row dict>, ...]}``. Each row is a plain
    JSON-serialisable dict (see :meth:`_blank_row` for the schema). Methods are
    read-modify-write; ``_load`` never raises (a failure logs + returns an empty
    list); mutations best-effort and log on failure (a session glitch must never
    break login or a request)."""

    def __init__(self, kv: KVStore) -> None:
        self._kv = kv

    # ----- persistence ------------------------------------------------------- #
    async def _load(self) -> list[dict[str, Any]]:
        try:
            doc = await self._kv.get(SESSIONS_NS, SESSIONS_KEY)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Loading sessions failed (%s); using empty set", exc)
            return []
        if not doc:
            return []
        raw = doc.get("entries", []) if isinstance(doc, dict) else []
        out: list[dict[str, Any]] = []
        for item in raw or []:
            if isinstance(item, dict) and item.get("sid"):
                out.append(item)
        return out

    async def _save(self, entries: list[dict[str, Any]]) -> None:
        # Bound the doc: prune long-dead rows first, then cap to the newest N.
        pruned = self._prune_rows(entries)
        if len(pruned) > _MAX_ROWS:
            pruned = sorted(pruned, key=lambda r: r.get("created_at", ""))[-_MAX_ROWS:]
        try:
            await self._kv.put(SESSIONS_NS, SESSIONS_KEY, {"entries": pruned})
        except Exception as exc:  # noqa: BLE001
            logger.warning("Persisting sessions failed (%s); continuing", exc)

    # ----- row schema -------------------------------------------------------- #
    @staticmethod
    def _blank_row(sid: str, username: str) -> dict[str, Any]:
        now = iso_now()
        return {
            "sid": sid,
            "username": username,
            "refresh_hash": "",
            "refresh_prev_hash": "",
            "token_version": 0,
            "created_at": now,
            "last_active_at": now,
            "last_authn_at": now,
            "absolute_expiry_at": "",
            "idle_expiry_at": "",
            "revoked": False,
            "revoked_at": "",
            "revoked_by": "",
            "revoke_reason": "",
            # PLAIN, source-controlled metadata (#9) — rendered as text by the UI.
            "ip": "",
            "ip_city": "",
            "ip_country": "",
            "ua_raw": "",
            "ua_browser": "",
            "ua_os": "",
            "client_type": "",
            "mfa_method": "",
        }

    # ----- token-version (per-user) ----------------------------------------- #
    def _tv_key(self, username: str) -> str:
        return f"__tv__:{_norm(username)}"

    async def token_version_for(self, username: str) -> int:
        """The CURRENT token_version for ``username`` (0 when never bumped). Bumping
        it (via :meth:`revoke_all`) invalidates every previously-issued session for
        the user whose stamped ``tv`` no longer matches."""
        entries = await self._load()
        return self._tv_from(entries, username)

    @staticmethod
    def _tv_from(entries: list[dict[str, Any]], username: str) -> int:
        needle = f"__tv__:{_norm(username)}"
        for row in entries:
            if row.get("sid") == needle:
                try:
                    return int(row.get("token_version", 0) or 0)
                except (TypeError, ValueError):
                    return 0
        return 0

    # ----- create / mutate --------------------------------------------------- #
    async def create(
        self,
        *,
        sid: str,
        username: str,
        token_version: int = 0,
        refresh_hash: str = "",
        idle_timeout: int = 0,
        absolute_lifetime: int = 0,
        ip: str = "",
        ip_city: str = "",
        ip_country: str = "",
        ua_raw: str = "",
        ua_browser: str = "",
        ua_os: str = "",
        client_type: str = "",
        mfa_method: str = "",
    ) -> dict[str, Any]:
        """Register a new session row (idempotent on ``sid`` — re-creating an existing
        sid refreshes its metadata instead of duplicating). Returns the stored row."""
        entries = await self._load()
        row = self._blank_row(sid, username)
        now = now_utc()
        if absolute_lifetime > 0:
            row["absolute_expiry_at"] = (now + timedelta(seconds=int(absolute_lifetime))).isoformat()
        if idle_timeout > 0:
            row["idle_expiry_at"] = (now + timedelta(seconds=int(idle_timeout))).isoformat()
        row.update(
            token_version=int(token_version),
            refresh_hash=refresh_hash or "",
            ip=ip or "", ip_city=ip_city or "", ip_country=ip_country or "",
            ua_raw=ua_raw or "", ua_browser=ua_browser or "", ua_os=ua_os or "",
            client_type=client_type or "", mfa_method=mfa_method or "",
        )
        replaced = False
        for idx, existing in enumerate(entries):
            if existing.get("sid") == sid:
                entries[idx] = row
                replaced = True
                break
        if not replaced:
            entries.append(row)
        await self._save(entries)
        return row

    async def get(self, sid: str) -> dict[str, Any] | None:
        if not sid or sid.startswith("__tv__:"):
            return None
        for row in await self._load():
            if row.get("sid") == sid:
                return row
        return None

    async def list_for(self, username: str) -> list[dict[str, Any]]:
        """All NON-internal session rows for ``username``, newest first."""
        needle = _norm(username)
        rows = [
            r for r in await self._load()
            if not str(r.get("sid", "")).startswith("__tv__:")
            and _norm(r.get("username", "")) == needle
        ]
        return sorted(rows, key=lambda r: r.get("created_at", ""), reverse=True)

    async def list_all(self) -> list[dict[str, Any]]:
        """Every NON-internal session row (admin console), newest first."""
        rows = [
            r for r in await self._load()
            if not str(r.get("sid", "")).startswith("__tv__:")
        ]
        return sorted(rows, key=lambda r: r.get("created_at", ""), reverse=True)

    async def touch(self, sid: str, *, idle_timeout: int = 0) -> bool:
        """Bump ``last_active_at`` (and slide the idle-expiry window) for ``sid`` —
        but ONLY when the stored value is >60s stale, to avoid a write per request.
        Returns True if a write happened. Never raises."""
        entries = await self._load()
        now = now_utc()
        changed = False
        for row in entries:
            if row.get("sid") != sid:
                continue
            last = _to_epoch(row.get("last_active_at"))
            if last is not None and (now.timestamp() - last) < 60:
                return False  # fresh enough; skip the write
            row["last_active_at"] = now.isoformat()
            if idle_timeout > 0:
                row["idle_expiry_at"] = (now + timedelta(seconds=int(idle_timeout))).isoformat()
            changed = True
            break
        if changed:
            await self._save(entries)
        return changed

    async def stamp_authn(self, sid: str) -> bool:
        """Mark a fresh re-authentication on ``sid`` (step-up) — sets ``last_authn_at``
        (and ``last_active_at``) to now. Returns True if the sid was found."""
        entries = await self._load()
        now = iso_now()
        found = False
        for row in entries:
            if row.get("sid") == sid:
                row["last_authn_at"] = now
                row["last_active_at"] = now
                found = True
                break
        if found:
            await self._save(entries)
        return found

    async def rotate_refresh(self, sid: str, new_hash: str) -> dict[str, Any] | None:
        """Rotate the refresh hash for ``sid``: the current hash slides to
        ``refresh_prev_hash`` (so a replay of the OLD token is detectable as theft)
        and ``new_hash`` becomes current. Returns the updated row, or None."""
        entries = await self._load()
        updated: dict[str, Any] | None = None
        for row in entries:
            if row.get("sid") == sid:
                row["refresh_prev_hash"] = row.get("refresh_hash", "") or ""
                row["refresh_hash"] = new_hash or ""
                updated = row
                break
        if updated is not None:
            await self._save(entries)
        return updated

    async def rekey_and_rotate(self, old_sid: str, new_sid: str, new_hash: str,
                               *, idle_timeout: int = 0) -> dict[str, Any] | None:
        """Rotate a session on REFRESH while preserving ONE logical row.

        The existing row's ``sid`` is re-keyed to ``new_sid`` (so the freshly-minted
        access token's ``sid`` claim resolves to it), the current refresh hash slides
        to ``refresh_prev_hash`` (so a replay of the OLD refresh token is detected as
        theft), and ``new_hash`` becomes current. ``last_active_at`` is bumped (and
        the idle window slid). Returns the updated row, or None if ``old_sid`` is
        unknown. The absolute-lifetime anchor (``created_at``) is intentionally
        UNCHANGED so a rotating session still ages out at the absolute bound (#)."""
        entries = await self._load()
        updated: dict[str, Any] | None = None
        now = now_utc()
        for row in entries:
            if row.get("sid") != old_sid:
                continue
            row["refresh_prev_hash"] = row.get("refresh_hash", "") or ""
            row["refresh_hash"] = new_hash or ""
            row["sid"] = new_sid
            row["last_active_at"] = now.isoformat()
            if idle_timeout > 0:
                row["idle_expiry_at"] = (now + timedelta(seconds=int(idle_timeout))).isoformat()
            updated = row
            break
        if updated is not None:
            await self._save(entries)
        return updated

    async def find_by_refresh(self, token: str) -> tuple[dict[str, Any] | None, str]:
        """Locate the session a refresh ``token`` belongs to.

        Returns ``(row, match)`` where ``match`` is:
        * ``"current"`` — the token matches the live ``refresh_hash`` (normal rotate),
        * ``"prev"``    — it matches an ALREADY-ROTATED ``refresh_prev_hash`` (REUSE /
          theft — the caller must revoke + bump tv),
        * ``""``        — no match (row is None).
        """
        if not token:
            return None, ""
        for row in await self._load():
            if str(row.get("sid", "")).startswith("__tv__:"):
                continue
            if row.get("refresh_hash") and verify_refresh(token, row["refresh_hash"]):
                return row, "current"
        for row in await self._load():
            if str(row.get("sid", "")).startswith("__tv__:"):
                continue
            if row.get("refresh_prev_hash") and verify_refresh(token, row["refresh_prev_hash"]):
                return row, "prev"
        return None, ""

    async def revoke(self, sid: str, *, by: str = "", reason: str = "") -> bool:
        """Mark ``sid`` revoked (append-only intent — the row stays for the audit/UI
        and is pruned later). Returns True if it was found + newly revoked."""
        entries = await self._load()
        changed = False
        for row in entries:
            if row.get("sid") != sid or row.get("revoked"):
                continue
            row["revoked"] = True
            row["revoked_at"] = iso_now()
            row["revoked_by"] = by or ""
            row["revoke_reason"] = reason or ""
            changed = True
            break
        if changed:
            await self._save(entries)
        return changed

    async def revoke_all(self, username: str, *, by: str = "", reason: str = "",
                         except_sid: str = "") -> int:
        """Revoke EVERY active session for ``username`` and BUMP the user's
        ``token_version`` (so any still-valid JWT carrying the old tv is rejected on
        its next request — instant global sign-out). Optionally keep ``except_sid``
        live (e.g. revoke-others). Returns the count of sessions revoked."""
        entries = await self._load()
        needle = _norm(username)
        count = 0
        now = iso_now()
        for row in entries:
            if str(row.get("sid", "")).startswith("__tv__:"):
                continue
            if _norm(row.get("username", "")) != needle or row.get("revoked"):
                continue
            if except_sid and row.get("sid") == except_sid:
                continue
            row["revoked"] = True
            row["revoked_at"] = now
            row["revoked_by"] = by or ""
            row["revoke_reason"] = reason or "revoke_all"
            count += 1
        # Bump token_version (a sentinel row keyed __tv__:<user>).
        tv_key = self._tv_key(username)
        bumped = False
        for row in entries:
            if row.get("sid") == tv_key:
                try:
                    row["token_version"] = int(row.get("token_version", 0) or 0) + 1
                except (TypeError, ValueError):
                    row["token_version"] = 1
                bumped = True
                break
        if not bumped:
            entries.append({"sid": tv_key, "username": username, "token_version": 1})
        await self._save(entries)
        return count

    async def revoke_others(self, username: str, keep_sid: str, *, by: str = "",
                            reason: str = "revoke_others") -> int:
        """Revoke every OTHER active session for ``username`` (mark each row
        ``revoked``) WITHOUT bumping the user's token_version — so the KEPT session's
        access token (which carries the current tv) stays valid while the others are
        rejected via their revoked flag. Returns the count revoked.

        (Note: a still-UNREGISTERED other token for the user would be lazily
        re-registered on its next request — the registry only revokes KNOWN sessions
        here; use :meth:`revoke_all` for the hard tv-bump global sign-out.)"""
        entries = await self._load()
        needle = _norm(username)
        count = 0
        now = iso_now()
        for row in entries:
            if str(row.get("sid", "")).startswith("__tv__:"):
                continue
            if _norm(row.get("username", "")) != needle or row.get("revoked"):
                continue
            if row.get("sid") == keep_sid:
                continue
            row["revoked"] = True
            row["revoked_at"] = now
            row["revoked_by"] = by or ""
            row["revoke_reason"] = reason
            count += 1
        if count:
            await self._save(entries)
        return count

    # ----- activity / expiry checks ----------------------------------------- #
    @staticmethod
    def is_active(row: dict[str, Any] | None, *, idle_timeout: int = 0,
                  absolute_lifetime: int = 0) -> str | None:
        """Return a rejection REASON string if the session is NOT usable, else None.

        Pure (no I/O) so the deps layer can call it after a single ``get``. Rejects
        on: explicit revocation, absolute-lifetime exceeded, or idle-timeout
        exceeded. ``idle_timeout`` / ``absolute_lifetime`` (seconds) act as a
        live POLICY OVERRIDE — when >0 they are recomputed from ``created_at`` /
        ``last_active_at`` so a policy change takes effect on stored rows; the
        per-row stamped expiry timestamps are the fallback. A missing row is the
        caller's concern (lazy-register), NOT a rejection here."""
        if row is None:
            return None  # caller decides (lazy-register an unknown sid)
        if row.get("revoked"):
            return REASON_REVOKED
        now = now_utc().timestamp()
        # Absolute lifetime: created_at + policy, else the stamped timestamp.
        created = _to_epoch(row.get("created_at"))
        if absolute_lifetime > 0 and created is not None:
            if now > created + int(absolute_lifetime):
                return REASON_ABSOLUTE
        else:
            abs_exp = _to_epoch(row.get("absolute_expiry_at"))
            if abs_exp is not None and now > abs_exp:
                return REASON_ABSOLUTE
        # Idle timeout: last_active_at + policy, else the stamped timestamp.
        last_active = _to_epoch(row.get("last_active_at"))
        if idle_timeout > 0 and last_active is not None:
            if now > last_active + int(idle_timeout):
                return REASON_IDLE
        else:
            idle_exp = _to_epoch(row.get("idle_expiry_at"))
            if idle_exp is not None and now > idle_exp:
                return REASON_IDLE
        return None

    @staticmethod
    def reauth_age_seconds(row: dict[str, Any] | None) -> float | None:
        """Seconds since the session last (re-)authenticated, or None if unknown."""
        if row is None:
            return None
        last_authn = _to_epoch(row.get("last_authn_at")) or _to_epoch(row.get("created_at"))
        if last_authn is None:
            return None
        return max(0.0, now_utc().timestamp() - last_authn)

    # ----- pruning ----------------------------------------------------------- #
    def _prune_rows(self, entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Drop revoked/expired rows whose terminal timestamp is older than the grace
        window. Keeps the __tv__ sentinels (tiny, must persist) + every live row."""
        now = now_utc().timestamp()
        kept: list[dict[str, Any]] = []
        for row in entries:
            sid = str(row.get("sid", ""))
            if sid.startswith("__tv__:"):
                kept.append(row)
                continue
            dead_at: float | None = None
            if row.get("revoked"):
                dead_at = _to_epoch(row.get("revoked_at")) or now
            else:
                # past absolute expiry → eligible to prune after grace
                abs_exp = _to_epoch(row.get("absolute_expiry_at"))
                if abs_exp is not None and now > abs_exp:
                    dead_at = abs_exp
            if dead_at is not None and (now - dead_at) > _PRUNE_GRACE_SECONDS:
                continue  # prune
            kept.append(row)
        return kept

    async def prune(self) -> int:
        """Explicitly prune long-dead rows. Returns the number removed."""
        entries = await self._load()
        kept = self._prune_rows(entries)
        removed = len(entries) - len(kept)
        if removed:
            await self._save(kept)
        return removed

    # ----- safe public projection ------------------------------------------- #
    @staticmethod
    def public(row: dict[str, Any]) -> dict[str, Any]:
        """A UI-safe projection — NEVER the refresh hashes (#10). Metadata is PLAIN
        text (#9)."""
        return {
            "sid": row.get("sid", ""),
            "username": row.get("username", ""),
            "created_at": row.get("created_at", ""),
            "last_active_at": row.get("last_active_at", ""),
            "last_authn_at": row.get("last_authn_at", ""),
            "absolute_expiry_at": row.get("absolute_expiry_at", ""),
            "idle_expiry_at": row.get("idle_expiry_at", ""),
            "revoked": bool(row.get("revoked", False)),
            "revoked_at": row.get("revoked_at", ""),
            "revoked_by": row.get("revoked_by", ""),
            "revoke_reason": row.get("revoke_reason", ""),
            "ip": row.get("ip", ""),
            "ip_city": row.get("ip_city", ""),
            "ip_country": row.get("ip_country", ""),
            "ua_browser": row.get("ua_browser", ""),
            "ua_os": row.get("ua_os", ""),
            "client_type": row.get("client_type", ""),
            "mfa_method": row.get("mfa_method", ""),
        }
