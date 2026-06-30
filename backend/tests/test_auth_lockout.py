"""Account lockout / brute-force throttle for password logins.

Two layers:

* unit — drive ``AuthService`` directly with a controllable monotonic clock, so the
  cooldown + staleness-window behaviour is tested without real sleeps.
* integration — the real ``/api/auth/login`` route returns a 429 + ``Retry-After``
  when an account is locked, and the admin unlock endpoint clears it.

The throttle is per-ACCOUNT + in-memory (see ``AuthService`` / ``LockoutPolicyConfig``);
only known, active accounts are counted, and a locked account still runs the
constant-time dummy verify (no timing/enumeration oracle).
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import router
from app.auth import service as service_mod
from app.auth.passwords import hash_password
from app.auth.service import AuthService
from app.config import LockoutPolicyConfig, Secrets
from app.constants import UserRole
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

# --------------------------------------------------------------------------- #
# Unit — AuthService with a controllable clock
# --------------------------------------------------------------------------- #


@pytest.fixture
def clock(monkeypatch):
    """A mutable monotonic clock the lockout logic reads. ``clock.advance(s)`` moves
    time forward so cooldown / staleness-window expiry is testable without sleeping."""

    class _Clock:
        def __init__(self) -> None:
            self.now = 1000.0

        def advance(self, seconds: float) -> None:
            self.now += seconds

    c = _Clock()
    monkeypatch.setattr(service_mod.time, "monotonic", lambda: c.now)
    return c


def _service(
    *, max_attempts: int = 3, window: int = 60, cooldown: int = 60, enabled: bool = True
) -> AuthService:
    svc = AuthService(
        enabled=True,
        jwt_secret="signing-secret",
        token_hours=8,
        users={"analyst": hash_password("hunter2")},
    )
    svc.set_lockout_policy(
        LockoutPolicyConfig(
            enabled=enabled,
            max_attempts=max_attempts,
            window_seconds=window,
            lockout_seconds=cooldown,
        )
    )
    return svc


def test_default_policy_is_enabled() -> None:
    """A freshly built service throttles by default (no explicit set_lockout_policy)."""
    svc = AuthService(
        enabled=True, jwt_secret="s", token_hours=1, users={"analyst": hash_password("hunter2")}
    )
    assert svc._lockout_policy.enabled is True  # noqa: SLF001
    assert svc._lockout_policy.max_attempts == 5  # noqa: SLF001


def test_locks_after_max_attempts(clock) -> None:
    svc = _service(max_attempts=3)
    assert svc.is_locked("analyst") is False
    for _ in range(3):
        assert svc.authenticate("analyst", "wrong") is None
    # Now locked — even the CORRECT password is refused while the cooldown runs.
    assert svc.is_locked("analyst") is True
    assert svc.authenticate("analyst", "hunter2") is None
    state = svc.lockout_state("analyst")
    assert state is not None
    assert state["locked"] is True
    assert state["retry_after"] > 0
    assert state["failed_attempts"] >= 3


def test_success_before_threshold_resets_counter(clock) -> None:
    svc = _service(max_attempts=3)
    assert svc.authenticate("analyst", "wrong") is None
    assert svc.authenticate("analyst", "wrong") is None
    # A success at 2/3 clears the counter — the account is NOT one fail from a lock.
    assert svc.authenticate("analyst", "hunter2") is not None
    assert svc.is_locked("analyst") is False
    # Two fresh failures do not trip (the counter restarted at the success).
    assert svc.authenticate("analyst", "wrong") is None
    assert svc.authenticate("analyst", "wrong") is None
    assert svc.is_locked("analyst") is False


def test_auto_unlock_after_cooldown(clock) -> None:
    svc = _service(max_attempts=3, cooldown=60)
    for _ in range(3):
        svc.authenticate("analyst", "wrong")
    assert svc.is_locked("analyst") is True
    clock.advance(61)  # past the cooldown
    assert svc.is_locked("analyst") is False
    # The correct password works again, with a fresh (cleared) counter.
    assert svc.authenticate("analyst", "hunter2") is not None


def test_stale_failures_outside_window_do_not_accumulate(clock) -> None:
    svc = _service(max_attempts=3, window=60)
    svc.authenticate("analyst", "wrong")
    svc.authenticate("analyst", "wrong")  # 2/3, but old
    clock.advance(61)  # both failures are now stale (> window)
    svc.authenticate("analyst", "wrong")  # counter restarts at 1, not 3
    assert svc.is_locked("analyst") is False


def test_admin_unlock_clears_state(clock) -> None:
    svc = _service(max_attempts=3)
    for _ in range(3):
        svc.authenticate("analyst", "wrong")
    assert svc.is_locked("analyst") is True
    assert svc.unlock("analyst") is True
    assert svc.is_locked("analyst") is False
    assert svc.authenticate("analyst", "hunter2") is not None
    # Idempotent: unlocking a not-locked account reports False.
    assert svc.unlock("analyst") is False


def test_disabled_policy_never_locks(clock) -> None:
    svc = _service(max_attempts=3, enabled=False)
    for _ in range(10):
        assert svc.authenticate("analyst", "wrong") is None
    assert svc.is_locked("analyst") is False
    assert svc.lockout_state("analyst") is None
    assert svc.authenticate("analyst", "hunter2") is not None


def test_unknown_user_is_not_tracked(clock) -> None:
    """An attacker hammering a non-existent username can neither lock it nor bloat the
    in-memory map (only known, active accounts are counted)."""
    svc = _service(max_attempts=3)
    for _ in range(10):
        assert svc.authenticate("ghost", "whatever") is None
    assert svc.is_locked("ghost") is False
    assert svc._lockouts == {}  # noqa: SLF001 — nothing tracked for the unknown name


def test_lockout_is_case_insensitive(clock) -> None:
    svc = _service(max_attempts=3)
    for _ in range(3):
        svc.authenticate("ANALYST", "wrong")
    # Lock keyed by lowercased username — both spellings see the lock.
    assert svc.is_locked("analyst") is True
    assert svc.is_locked("Analyst") is True


# --------------------------------------------------------------------------- #
# Integration — the real /api/auth/login route + admin unlock
# --------------------------------------------------------------------------- #


@pytest_asyncio.fixture
async def auth_state():
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        auth_enabled=True,
        auth_jwt_secret="test-secret",
        auth_seed_admin=False,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
    await state.users.create(
        username="alice",
        password_hash=hash_password("alice-password"),
        role=UserRole.ANALYST_TIER1.value,
        active=True,
        must_change_password=False,
    )
    await state.refresh_users()
    yield state
    await state.shutdown()


@pytest.fixture
def client(auth_state):
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.tlsoc = auth_state
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(router)
    with TestClient(app) as c:
        yield c


def _login(client, username, password):
    return client.post("/api/auth/login", json={"username": username, "password": password})


def test_login_returns_429_with_retry_after_when_locked(client, auth_state):
    # Grab a valid token BEFORE locking (rbac off → an authenticated user is treated
    # as super_admin, so alice can call the admin unlock endpoint).
    token = _login(client, "alice", "alice-password").json()["token"]

    # Default policy = 5 attempts. The first four failures are plain 401s; the fifth
    # trips the lock and is reported as a 429 (the route checks lockout AFTER the
    # failed authenticate).
    for _ in range(4):
        assert _login(client, "alice", "wrong").status_code == 401
    locked = _login(client, "alice", "wrong")
    assert locked.status_code == 429
    assert int(locked.headers["Retry-After"]) > 0
    # The correct password is ALSO refused with 429 while locked.
    blocked = _login(client, "alice", "alice-password")
    assert blocked.status_code == 429

    # Admin unlock clears it; login works again immediately.
    unlocked = client.post(
        "/api/admin/users/alice/unlock", headers={"Authorization": f"Bearer {token}"}
    )
    assert unlocked.status_code == 200
    assert unlocked.json()["unlocked"] is True
    assert _login(client, "alice", "alice-password").status_code == 200


def test_users_list_surfaces_locked_flag(client):
    token = _login(client, "alice", "alice-password").json()["token"]
    for _ in range(5):
        _login(client, "alice", "wrong")
    resp = client.get("/api/users", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    alice = next(u for u in resp.json()["users"] if u["username"] == "alice")
    assert alice["locked"] is True
