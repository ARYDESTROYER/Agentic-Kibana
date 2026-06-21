"""Offline tests for the auth + security primitives (stdlib-only, no new deps).

Covers PBKDF2 password hashing, the tiny HS256 JWT, the AuthService, and the
three request-path middlewares (security headers, rate limit, CSRF). Each
middleware is exercised over a throwaway FastAPI app via Starlette's TestClient.
"""

from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.testclient import TestClient

from app.auth.passwords import hash_password, verify_password
from app.auth.service import AuthService, AuthUser
from app.auth.tokens import TokenError, decode, encode
from app.middleware.csrf import CSRFMiddleware
from app.middleware.rate_limit import RateLimitMiddleware
from app.middleware.security_headers import SecurityHeadersMiddleware


# --------------------------------------------------------------------------- #
# 1. Password hashing
# --------------------------------------------------------------------------- #
def test_password_hash_verify_roundtrip() -> None:
    stored = hash_password("correct horse battery staple")
    assert stored.startswith("pbkdf2_sha256$")
    assert verify_password("correct horse battery staple", stored) is True


def test_password_wrong_password_is_false() -> None:
    stored = hash_password("s3cret")
    assert verify_password("not-the-password", stored) is False


def test_password_salt_makes_hashes_unique() -> None:
    a = hash_password("same")
    b = hash_password("same")
    assert a != b
    assert verify_password("same", a) and verify_password("same", b)


def test_password_malformed_stored_is_false_not_raises() -> None:
    for bad in ["", "garbage", "pbkdf2_sha256$x$y", "sha256$1$ab$cd", "a$b$c$d", "$$$"]:
        assert verify_password("x", bad) is False


def test_password_iteration_count_embedded() -> None:
    stored = hash_password("pw", iterations=50_000)
    assert stored.split("$")[1] == "50000"
    assert verify_password("pw", stored) is True


# --------------------------------------------------------------------------- #
# 2. JWT (HS256, stdlib)
# --------------------------------------------------------------------------- #
def test_jwt_encode_decode_roundtrip() -> None:
    token = encode({"sub": "alice", "role": "admin"}, "topsecret", expires_in_s=3600)
    claims = decode(token, "topsecret")
    assert claims["sub"] == "alice"
    assert claims["role"] == "admin"
    assert claims["exp"] > claims["iat"]


def test_jwt_tampered_token_raises() -> None:
    token = encode({"sub": "alice"}, "topsecret", expires_in_s=3600)
    head, payload, sig = token.split(".")
    # Flip a character in the signature segment.
    tampered = f"{head}.{payload}.{'A' if sig[0] != 'A' else 'B'}{sig[1:]}"
    with pytest.raises(TokenError):
        decode(tampered, "topsecret")


def test_jwt_wrong_secret_raises() -> None:
    token = encode({"sub": "alice"}, "topsecret", expires_in_s=3600)
    with pytest.raises(TokenError):
        decode(token, "different-secret")


def test_jwt_expired_token_raises() -> None:
    token = encode({"sub": "alice"}, "topsecret", expires_in_s=-1)
    with pytest.raises(TokenError):
        decode(token, "topsecret")


def test_jwt_malformed_token_raises() -> None:
    for bad in ["", "abc", "a.b", "a.b.c.d", "not-base64.@@@.@@@"]:
        with pytest.raises(TokenError):
            decode(bad, "topsecret")


# --------------------------------------------------------------------------- #
# 3. AuthService
# --------------------------------------------------------------------------- #
def _service(enabled: bool = True) -> AuthService:
    users = {"analyst": hash_password("hunter2")}
    return AuthService(enabled=enabled, jwt_secret="signing-secret", token_hours=8, users=users)


def test_authservice_authenticate_good_returns_token() -> None:
    svc = _service()
    token = svc.authenticate("analyst", "hunter2")
    assert token is not None
    user = svc.verify(token)
    assert isinstance(user, AuthUser) and user.username == "analyst"


def test_authservice_authenticate_bad_returns_none() -> None:
    svc = _service()
    assert svc.authenticate("analyst", "wrong") is None
    assert svc.authenticate("nobody", "hunter2") is None


def test_authservice_verify_garbage_returns_none() -> None:
    svc = _service()
    assert svc.verify("not.a.token") is None
    assert svc.verify("") is None


def test_authservice_is_enabled_flag() -> None:
    assert _service(enabled=True).is_enabled is True
    assert _service(enabled=False).is_enabled is False


def test_authservice_ephemeral_secret_when_enabled_without_secret(caplog) -> None:
    import logging

    with caplog.at_level(logging.WARNING):
        svc = AuthService(enabled=True, jwt_secret="", token_hours=1, users={})
    assert any("EPHEMERAL" in rec.message or "ephemeral" in rec.message.lower()
               for rec in caplog.records)
    # The generated secret still produces working, self-consistent tokens.
    users = {"u": hash_password("p")}
    svc2 = AuthService(enabled=True, jwt_secret="", token_hours=1, users=users)
    tok = svc2.authenticate("u", "p")
    assert tok is not None and svc2.verify(tok).username == "u"


# --------------------------------------------------------------------------- #
# 4. SecurityHeadersMiddleware
# --------------------------------------------------------------------------- #
def _app_with(middleware_cls, **kwargs) -> FastAPI:
    app = FastAPI()
    app.add_middleware(middleware_cls, **kwargs)

    @app.get("/")
    def root() -> PlainTextResponse:
        return PlainTextResponse("ok")

    @app.post("/")
    def root_post() -> JSONResponse:
        return JSONResponse({"ok": True})

    return app


def test_security_headers_present() -> None:
    client = TestClient(_app_with(SecurityHeadersMiddleware))
    r = client.get("/")
    assert r.status_code == 200
    assert r.headers["Content-Security-Policy"] == (
        "default-src 'self'; frame-ancestors 'none'; object-src 'none'"
    )
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "no-referrer"
    # Plain HTTP request -> no HSTS.
    assert "Strict-Transport-Security" not in r.headers


def test_security_headers_hsts_only_on_https() -> None:
    client = TestClient(_app_with(SecurityHeadersMiddleware))
    r = client.get("/", headers={"X-Forwarded-Proto": "https"})
    assert "Strict-Transport-Security" in r.headers


def test_security_headers_individually_toggleable() -> None:
    client = TestClient(_app_with(SecurityHeadersMiddleware, frame_options=False))
    r = client.get("/")
    assert "X-Frame-Options" not in r.headers
    assert r.headers["X-Content-Type-Options"] == "nosniff"


# --------------------------------------------------------------------------- #
# 5. RateLimitMiddleware
# --------------------------------------------------------------------------- #
def test_rate_limit_returns_429_after_capacity() -> None:
    # capacity=3, negligible refill so the 4th request within the window is blocked.
    client = TestClient(
        _app_with(RateLimitMiddleware, capacity=3, refill_per_second=0.0)
    )
    statuses = [client.get("/").status_code for _ in range(5)]
    assert statuses[:3] == [200, 200, 200]
    assert 429 in statuses[3:]
    blocked = client.get("/")
    assert blocked.status_code == 429
    assert blocked.json() == {"detail": "rate limit exceeded"}


def test_rate_limit_disabled_is_passthrough() -> None:
    client = TestClient(
        _app_with(RateLimitMiddleware, capacity=1, refill_per_second=0.0, enabled=False)
    )
    assert all(client.get("/").status_code == 200 for _ in range(10))


def test_rate_limit_refills_over_time() -> None:
    client = TestClient(
        _app_with(RateLimitMiddleware, capacity=1, refill_per_second=1000.0)
    )
    assert client.get("/").status_code == 200
    # Either immediately blocked or refilled; after a short wait it must succeed.
    time.sleep(0.05)
    assert client.get("/").status_code == 200


# --------------------------------------------------------------------------- #
# 6. CSRFMiddleware
# --------------------------------------------------------------------------- #
def test_csrf_allows_get() -> None:
    client = TestClient(_app_with(CSRFMiddleware, enabled=True))
    assert client.get("/").status_code == 200


def test_csrf_blocks_unguarded_post() -> None:
    client = TestClient(_app_with(CSRFMiddleware, enabled=True))
    r = client.post("/")
    assert r.status_code == 403
    assert r.json() == {"detail": "CSRF token invalid or missing"}


def test_csrf_allows_matching_cookie_and_header_post() -> None:
    client = TestClient(_app_with(CSRFMiddleware, enabled=True))
    client.cookies.set("tlsoc_csrf", "abc123")
    r = client.post("/", headers={"X-CSRF-Token": "abc123"})
    assert r.status_code == 200


def test_csrf_blocks_mismatched_token_post() -> None:
    client = TestClient(_app_with(CSRFMiddleware, enabled=True))
    client.cookies.set("tlsoc_csrf", "abc123")
    r = client.post("/", headers={"X-CSRF-Token": "different"})
    assert r.status_code == 403


def test_csrf_disabled_is_passthrough() -> None:
    client = TestClient(_app_with(CSRFMiddleware, enabled=False))
    assert client.post("/").status_code == 200


def test_csrf_exempt_prefix_bypasses() -> None:
    app = FastAPI()
    app.add_middleware(CSRFMiddleware, enabled=True, exempt_prefixes=("/api/ingest",))

    @app.post("/api/ingest")
    def ingest() -> JSONResponse:
        return JSONResponse({"ok": True})

    client = TestClient(app)
    assert client.post("/api/ingest").status_code == 200
