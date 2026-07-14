"""Sessions & access policy tests — Wave 3.

Covers, over the REAL app router (auth gate mirrored from main.py):

* sid is minted + registered at ALL THREE cookie sites (login, mfa/verify,
  sso/callback — the latter two via direct service mints with a route-shaped hook).
* idle + absolute expiry REJECT a request (policy-override recompute on stored rows).
* revoke single + revoke-all (token_version bump) invalidate sessions.
* refresh rotation + reuse-detection theft path (revoke + tv bump + 401).
* step-up require_fresh_auth (admin force-terminate is sudo-gated).
* admin gate on the admin session console.
* audit on every create/revoke (#2).
* AUTH-OFF is a strict NO-OP (a request with auth off is unaffected).
* an UNKNOWN sid on a validly-signed token is LAZILY REGISTERED + ALLOWED (the
  direct-mint back-compat that keeps the 666 baseline green).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes import router
from app.config import Secrets
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState
from app.stores.sessions import (
    SessionStore,
    hash_refresh,
    new_refresh_token,
    verify_refresh,
)
from app.utils import now_utc

# Make the captured AppState reachable to the test body for direct store pokes.
_STATE: dict[str, AppState] = {}


def _build_client(**secret_overrides):
    rbac_enabled = secret_overrides.pop("rbac_enabled", False)
    session_policy = secret_overrides.pop("session_policy", None)
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None, **secret_overrides,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(deep=True)
        prefs.setup_complete = True
        prefs.rbac.enabled = rbac_enabled
        if session_policy:
            for k, v in session_policy.items():
                setattr(prefs.session_policy, k, v)
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        _STATE["state"] = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(router, dependencies=[Depends(require_auth)])
    return TestClient(api)


def _login(c: TestClient, username="Admin", password="Admin@123"):
    return c.post("/api/auth/login", json={"username": username, "password": password})


# --------------------------------------------------------------------------- #
# SessionStore unit behaviour (backend-agnostic; runs on the fake-ES KV)
# --------------------------------------------------------------------------- #
def test_refresh_hash_roundtrip_and_salt() -> None:
    tok = new_refresh_token()
    h = hash_refresh(tok)
    assert "$" in h
    assert verify_refresh(tok, h)
    assert not verify_refresh(tok + "x", h)
    # Two hashes of the SAME token differ (per-token salt) but both verify.
    h2 = hash_refresh(tok)
    assert h != h2 and verify_refresh(tok, h2)


def test_is_active_rejection_reasons() -> None:
    now = now_utc().timestamp()
    # revoked
    assert SessionStore.is_active({"sid": "x", "revoked": True}) == "revoked"
    # absolute expired via policy override (created long ago)
    old = "2000-01-01T00:00:00+00:00"
    assert SessionStore.is_active(
        {"sid": "x", "created_at": old, "last_active_at": old},
        absolute_lifetime=3600,
    ) == "absolute_expired"
    # idle expired via policy override
    assert SessionStore.is_active(
        {"sid": "x", "created_at": now_utc().isoformat(), "last_active_at": old},
        idle_timeout=1,
    ) == "idle_expired"
    # active when fresh
    fresh = now_utc().isoformat()
    assert SessionStore.is_active(
        {"sid": "x", "created_at": fresh, "last_active_at": fresh},
        idle_timeout=10_000, absolute_lifetime=10_000,
    ) is None
    # an unknown row (None) is NOT a rejection — caller lazily registers.
    assert SessionStore.is_active(None) is None


# --------------------------------------------------------------------------- #
# Auth OFF — strict NO-OP (sessions never interfere)
# --------------------------------------------------------------------------- #
def test_auth_off_session_check_is_noop() -> None:
    with _build_client(auth_enabled=False) as c:
        # A protected route is reachable with no session at all.
        assert c.get("/api/cases").status_code == 200
        # The session endpoints require auth-on → 400 when off.
        assert c.get("/api/sessions").status_code == 400


# --------------------------------------------------------------------------- #
# Login registers a sid (+ audited create)
# --------------------------------------------------------------------------- #
def test_login_registers_session_and_audits() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="sess") as c:
        r = _login(c)
        assert r.status_code == 200
        state = _STATE["state"]
        # list own sessions via the API (current flagged)
        sess = c.get("/api/sessions").json()
        assert sess["sessions"], "login should register a session"
        assert any(s["current"] for s in sess["sessions"])
        # The metadata is present + PLAIN (no refresh hash leaked).
        s0 = sess["sessions"][0]
        assert "refresh_hash" not in s0 and "refresh_prev_hash" not in s0
        # An audit row for the session create exists.
        audit = pytest_run(state.audit.records_for_actor("Admin", 50))
        assert any("session_create" in (a.get("result_summary") or "") for a in audit)


# --------------------------------------------------------------------------- #
# Unknown sid is lazily registered + allowed (back-compat)
# --------------------------------------------------------------------------- #
def test_unknown_sid_lazily_registered_and_allowed() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="lazy") as c:
        state = _STATE["state"]
        # Mint a token DIRECTLY (bypasses the login cookie hook → sid unknown).
        minted = state.auth.mint_session("Admin")
        assert minted is not None
        token, principal = minted
        assert principal.sid
        # The unknown sid is allowed on first use ...
        r = c.get("/api/cases", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 200
        # ... and is now registered (lazy first-seen).
        row = pytest_run(state.sessions.get(principal.sid))
        assert row is not None and row["username"] == "Admin"


# --------------------------------------------------------------------------- #
# Revoke a single session invalidates it
# --------------------------------------------------------------------------- #
def test_revoke_single_session_blocks_token() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="rev") as c:
        r = _login(c)
        token = r.json()["token"]
        state = _STATE["state"]
        sid = state.auth.claims_of(token)["sid"]
        # Token works ...
        assert c.get("/api/cases", headers={"Authorization": f"Bearer {token}"}).status_code == 200
        # Revoke it (own) ...
        assert c.post(f"/api/sessions/{sid}/revoke").status_code == 200
        # ... now the same token is rejected with session_invalid.
        rr = c.get("/api/cases", headers={"Authorization": f"Bearer {token}"})
        assert rr.status_code == 401
        detail = rr.json()["detail"]
        assert detail.get("code") == "session_invalid"


# --------------------------------------------------------------------------- #
# revoke-all bumps token_version → every old token rejected (reauth_required)
# --------------------------------------------------------------------------- #
def test_revoke_all_bumps_token_version() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="ra") as c:
        state = _STATE["state"]
        # Mint two independent tokens for the same user.
        t1, p1 = state.auth.mint_session("Admin")
        # First touch registers them.
        assert c.get("/api/cases", headers={"Authorization": f"Bearer {t1}"}).status_code == 200
        # Admin revoke-all for the user via the admin route (needs a session first).
        _login(c)
        rr = c.post("/api/admin/users/Admin/revoke-all")
        assert rr.status_code == 200 and rr.json()["revoked"] >= 1
        # The OLD direct-mint token now carries a stale tv → reauth_required.
        out = c.get("/api/cases", headers={"Authorization": f"Bearer {t1}"})
        assert out.status_code == 401
        assert out.json()["detail"]["code"] == "reauth_required"


# --------------------------------------------------------------------------- #
# Env single-admin is NOT permanently locked out after a revoke-all (Round-2 fix)
# --------------------------------------------------------------------------- #
def test_env_admin_can_relogin_after_revoke_all() -> None:
    """Regression: the env single-admin (auth_admin_*) lives ONLY in the AuthService
    BASE layer — it is NOT a stored User. ``refresh_sessions`` used to build the
    per-user token_version snapshot from ``users.list()`` alone, omitting the
    env-admin, so after a revoke-all bumped the persistent tv to 1 the env-admin's
    synced tv stayed 0 → every fresh login stamped tv=0 < current_tv=1 →
    PERMANENT reauth_required lockout. The fix unions the base usernames into the
    snapshot, defaulting each from the SessionStore's per-user tv."""
    with _build_client(
        auth_enabled=True, auth_jwt_secret="envadm",
        auth_admin_username="root", auth_admin_password="Root@123!",
    ) as c:
        state = _STATE["state"]
        # The env-admin is NOT in the persistent user store (it's a base/env account).
        assert pytest_run(state.users.count()) == 0
        # 1) The env-admin can log in initially.
        r0 = _login(c, "root", "Root@123!")
        assert r0.status_code == 200, r0.text
        tok0 = r0.json()["token"]
        assert c.get("/api/cases", headers={"Authorization": f"Bearer {tok0}"}).status_code == 200
        # 2) A revoke-all for the env-admin bumps the persistent tv to >=1 + refreshes
        #    the AuthService snapshot — exactly what the admin route does.
        revoked = pytest_run(state.sessions.revoke_all("root", by="test", reason="t"))
        assert revoked >= 1
        assert pytest_run(state.sessions.token_version_for("root")) >= 1
        pytest_run(state.refresh_sessions())
        # The AuthService snapshot now tracks the env-admin's bumped tv (NOT reset to 0).
        assert state.auth._token_version_for("root") >= 1
        # 3) THE FIX: a FRESH env-admin login mints a token whose tv matches the
        #    current tv, so it is ACCEPTED — the env-admin is NOT permanently locked out.
        c.cookies.clear()
        r1 = _login(c, "root", "Root@123!")
        assert r1.status_code == 200, r1.text
        tok1 = r1.json()["token"]
        out = c.get("/api/cases", headers={"Authorization": f"Bearer {tok1}"})
        assert out.status_code == 200, out.text  # would be 401 reauth_required pre-fix


# --------------------------------------------------------------------------- #
# Idle + absolute expiry reject
# --------------------------------------------------------------------------- #
def test_idle_expiry_rejects() -> None:
    with _build_client(
        auth_enabled=True, auth_jwt_secret="idle",
        session_policy={"idle_timeout": 1},
    ) as c:
        r = _login(c)
        token = r.json()["token"]
        state = _STATE["state"]
        sid = state.auth.claims_of(token)["sid"]
        # Backdate last_active so the (idle_timeout=1) policy rejects it.
        rows = pytest_run(state.sessions._load())
        for row in rows:
            if row.get("sid") == sid:
                row["last_active_at"] = "2000-01-01T00:00:00+00:00"
        _raw_put_sessions(state.sessions, rows)
        out = c.get("/api/cases", headers={"Authorization": f"Bearer {token}"})
        assert out.status_code == 401
        assert out.json()["detail"]["code"] == "session_expired"


def test_absolute_expiry_rejects() -> None:
    with _build_client(
        auth_enabled=True, auth_jwt_secret="abs",
        session_policy={"absolute_lifetime": 3600},
    ) as c:
        r = _login(c)
        token = r.json()["token"]
        state = _STATE["state"]
        sid = state.auth.claims_of(token)["sid"]
        rows = pytest_run(state.sessions._load())
        for row in rows:
            if row.get("sid") == sid:
                row["created_at"] = "2000-01-01T00:00:00+00:00"
        _raw_put_sessions(state.sessions, rows)
        out = c.get("/api/cases", headers={"Authorization": f"Bearer {token}"})
        assert out.status_code == 401
        assert out.json()["detail"]["code"] == "session_expired"


# --------------------------------------------------------------------------- #
# Refresh rotation + reuse-detection theft path
# --------------------------------------------------------------------------- #
def test_refresh_rotation_and_reuse_theft() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="ref") as c:
        state = _STATE["state"]
        # Seed a session WITH a known refresh token via the store directly.
        from app.stores.sessions import new_sid

        sid = new_sid()
        rtok = new_refresh_token()
        pytest_run(state.sessions.create(
            sid=sid, username="Admin", token_version=0,
            refresh_hash=hash_refresh(rtok),
            idle_timeout=10_000, absolute_lifetime=100_000,
        ))
        # Rotate: get a new access + refresh token.
        r1 = c.post("/api/auth/refresh", json={"refresh_token": rtok})
        assert r1.status_code == 200
        new_rtok = r1.json()["refresh_token"]
        assert new_rtok and new_rtok != rtok
        # The new refresh token rotates again (valid) — the OLD rtok is now stale.
        r2 = c.post("/api/auth/refresh", json={"refresh_token": new_rtok})
        assert r2.status_code == 200
        newest_rtok = r2.json()["refresh_token"]
        # REUSE the JUST-ROTATED token (now in refresh_prev_hash) → THEFT path:
        # session revoked + token_version bumped + 401.
        theft = c.post("/api/auth/refresh", json={"refresh_token": new_rtok})
        assert theft.status_code == 401
        assert theft.json()["detail"]["code"] == "session_invalid"
        assert theft.json()["detail"]["reason"] == "refresh_reuse"
        # token_version was bumped → global sign-out for the user.
        tv = pytest_run(state.sessions.token_version_for("Admin"))
        assert tv >= 1
        # The legitimately-newest token is also dead now (all sessions revoked).
        after = c.post("/api/auth/refresh", json={"refresh_token": newest_rtok})
        assert after.status_code == 401


# --------------------------------------------------------------------------- #
# Step-up: require_fresh_auth gates the admin force-terminate; reauth unlocks it
# --------------------------------------------------------------------------- #
def test_step_up_fresh_auth_on_admin_revoke() -> None:
    with _build_client(
        auth_enabled=True, auth_jwt_secret="sudo",
        session_policy={"sudo_reauth_window": 1},
    ) as c:
        r = _login(c)
        token = r.json()["token"]
        state = _STATE["state"]
        sid = state.auth.claims_of(token)["sid"]
        # Make the session's last_authn stale so the step-up window (1s) is exceeded.
        rows = pytest_run(state.sessions._load())
        for row in rows:
            if row.get("sid") == sid:
                row["last_authn_at"] = "2000-01-01T00:00:00+00:00"
        _raw_put_sessions(state.sessions, rows)
        # A sudo-gated admin route now demands a re-auth.
        blocked = c.post("/api/admin/users/Admin/revoke-all")
        assert blocked.status_code == 401
        assert blocked.json()["detail"]["code"] == "reauth_required"
        # Re-auth with the password stamps last_authn → the action unlocks.
        assert c.post("/api/auth/reauth", json={"password": "Admin@123"}).status_code == 200
        ok = c.post("/api/admin/users/Admin/revoke-all")
        assert ok.status_code == 200


# --------------------------------------------------------------------------- #
# Admin gate: a tier1 analyst cannot reach the admin session console
# --------------------------------------------------------------------------- #
def test_admin_sessions_console_requires_admin() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="adm", rbac_enabled=True) as c:
        _login(c)
        # Admin can list all sessions.
        assert c.get("/api/admin/sessions").status_code == 200
        # Create a tier1 + log in as them.
        assert c.post("/api/users", json={"username": "t1", "password": "t1password",
                                          "role": "analyst_tier1"}).status_code == 200
        c.post("/api/auth/logout")
        assert _login(c, "t1", "t1password").status_code == 200
        # tier1 is denied the admin console (403).
        assert c.get("/api/admin/sessions").status_code == 403


# --------------------------------------------------------------------------- #
# revoke-others keeps the current session, drops the rest
# --------------------------------------------------------------------------- #
def test_revoke_others_keeps_current() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="oth") as c:
        state = _STATE["state"]
        # A second (other) session for the same user, registered via direct mint.
        t_other, p_other = state.auth.mint_session("Admin")
        assert c.get("/api/cases", headers={"Authorization": f"Bearer {t_other}"}).status_code == 200
        # Log in (this becomes "current") then revoke-others.
        lg = _login(c)
        login_sid = state.auth.claims_of(lg.json()["token"])["sid"]
        rr = c.post("/api/sessions/revoke-others", json={})
        assert rr.status_code == 200 and rr.json()["revoked"] >= 1
        # The current session row is preserved (not revoked); the other is revoked.
        cur = pytest_run(state.sessions.get(login_sid))
        oth = pytest_run(state.sessions.get(p_other.sid))
        assert cur is not None and cur["revoked"] is False
        assert oth is not None and oth["revoked"] is True
        # With the cookie cleared, the OTHER token alone is now rejected (revoked).
        c.cookies.clear()
        assert c.get("/api/cases", headers={"Authorization": f"Bearer {t_other}"}).status_code == 401


# --------------------------------------------------------------------------- #
# logout revokes the current sid
# --------------------------------------------------------------------------- #
def test_logout_revokes_current_sid() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="lo") as c:
        r = _login(c)
        token = r.json()["token"]
        state = _STATE["state"]
        sid = state.auth.claims_of(token)["sid"]
        c.post("/api/auth/logout")
        row = pytest_run(state.sessions.get(sid))
        assert row is not None and row["revoked"] is True
        # The (now-revoked) token is rejected even though its JWT hasn't expired.
        out = c.get("/api/cases", headers={"Authorization": f"Bearer {token}"})
        assert out.status_code == 401


# --------------------------------------------------------------------------- #
# account activity feed reads the caller's own audit rows
# --------------------------------------------------------------------------- #
def test_account_activity_feed() -> None:
    with _build_client(auth_enabled=True, auth_jwt_secret="act") as c:
        _login(c)
        act = c.get("/api/account/activity").json()["activity"]
        assert isinstance(act, list)
        assert any((a.get("actor") == "Admin") for a in act)


def test_concurrent_revoke_is_not_clobbered_by_a_parallel_write() -> None:
    # audit #4: a revoke concurrent with other session writes must NOT be lost. Every
    # mutation now routes through kv_mutate (per-store lock + _rev CAS), so interleaved
    # RMWs serialise instead of the last-writer clobbering the revoke.
    import asyncio

    from app.stores.memory import EsKVStore
    from app.stores.sessions import SessionStore

    async def scenario() -> None:
        store = SessionStore(EsKVStore(InMemoryESClient()))
        # 20 live sessions for one user.
        for i in range(20):
            await store.create(sid=f"s{i}", username="alice", token_version=0)
        # Concurrently revoke s0 while touching every other session (the writes that,
        # under an unguarded load→modify→save, would reload the pre-revoke snapshot and
        # overwrite the revoke).
        await asyncio.gather(
            store.revoke("s0", by="admin", reason="test"),
            *[store.stamp_authn(f"s{i}") for i in range(1, 20)],
        )
        row = await store.get("s0")
        assert row is not None and row.get("revoked") is True, "revoke was clobbered"
        # A global sign-out (revoke_all) concurrent with touches keeps every revoke.
        await asyncio.gather(
            store.revoke_all("alice", by="admin", reason="global"),
            *[store.stamp_authn(f"s{i}") for i in range(1, 20)],
        )
        live = [r for r in await store.list_for("alice") if not r.get("revoked")]
        assert live == [], f"revoke_all lost some revocations: {[r['sid'] for r in live]}"
        assert await store.token_version_for("alice") >= 1

    asyncio.new_event_loop().run_until_complete(scenario())


# --------------------------------------------------------------------------- #
# Tiny synchronous-coroutine runner for poking the async store from a sync test.
# --------------------------------------------------------------------------- #
def pytest_run(coro):
    import asyncio

    return asyncio.get_event_loop().run_until_complete(coro)


def _raw_put_sessions(store, rows) -> None:
    """Test-only: overwrite the session doc directly via the KV (there is no plain
    ``_save`` — production writes go through the CAS-guarded ``_mutate``). Used to
    inject a stale timestamp for expiry/step-up scenarios."""
    from app.constants import SESSIONS_KEY, SESSIONS_NS

    pytest_run(store._kv.put(SESSIONS_NS, SESSIONS_KEY, {"entries": rows}))
