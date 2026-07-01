"""Wave 2 / F4 — OIDC provider helpers + SSO callback flow (offline).

Monkeypatches the discovery / token / userinfo HTTP calls so the entire flow runs
with no network. Covers: discovery cache, authorization-URL shape, server-side code
exchange + userinfo, claim→identity mapping, the domain + tenant allowlists, the
group→role map, single-use state/nonce, ``auto_create_users`` on/off, and
provisioning idempotence (no duplicate accounts on re-login).
"""

from __future__ import annotations

import pytest
import pytest_asyncio

from app.auth import oidc
from app.config import Preferences, Secrets, SSOConfig, SSOProvider
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

# --------------------------------------------------------------------------- #
# Fake IdP wiring
# --------------------------------------------------------------------------- #
_DISCOVERY = {
    "issuer": "https://idp.example.com",
    "authorization_endpoint": "https://idp.example.com/authorize",
    "token_endpoint": "https://idp.example.com/token",
    "userinfo_endpoint": "https://idp.example.com/userinfo",
}


@pytest.fixture(autouse=True)
def _clear_discovery_cache():
    oidc._DISCOVERY_CACHE.clear()
    yield
    oidc._DISCOVERY_CACHE.clear()


def _generic_provider(**over) -> dict:
    cfg = {
        "id": "corp",
        "type": "generic",
        "display_name": "Corp IdP",
        "client_id": "client-123",
        "discovery_url": "https://idp.example.com/.well-known/openid-configuration",
        "scopes": "openid email profile",
    }
    cfg.update(over)
    return cfg


def _patch_http(monkeypatch, *, claims: dict, token: dict | None = None) -> dict:
    """Patch oidc's HTTP helpers. Returns a call-log dict to assert single-use, etc."""
    calls = {"discovery": 0, "token": 0, "userinfo": 0}

    async def fake_get_json(url, *, headers=None):
        if "well-known" in url:
            calls["discovery"] += 1
            return dict(_DISCOVERY)
        if url == _DISCOVERY["userinfo_endpoint"]:
            calls["userinfo"] += 1
            return dict(claims)
        raise AssertionError(f"unexpected GET {url}")

    async def fake_post_form(url, form):
        assert url == _DISCOVERY["token_endpoint"]
        calls["token"] += 1
        return token or {"access_token": "at-xyz", "token_type": "Bearer"}

    monkeypatch.setattr(oidc, "_http_get_json", fake_get_json)
    monkeypatch.setattr(oidc, "_http_post_form", fake_post_form)
    return calls


# --------------------------------------------------------------------------- #
# Provider unit tests
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_discovery_and_authorization_url(monkeypatch):
    _patch_http(monkeypatch, claims={})
    prov = oidc.OidcProvider(_generic_provider(), client_secret="sek")
    url = await prov.authorization_url(
        state="st", nonce="no", redirect_uri="https://app/cb"
    )
    assert url.startswith("https://idp.example.com/authorize?")
    assert "client_id=client-123" in url
    assert "response_type=code" in url
    assert "state=st" in url and "nonce=no" in url
    assert "scope=openid+email+profile" in url


@pytest.mark.asyncio
async def test_exchange_and_userinfo(monkeypatch):
    claims = {"sub": "u-1", "email": "a@corp.com", "name": "A"}
    calls = _patch_http(monkeypatch, claims=claims)
    prov = oidc.OidcProvider(_generic_provider(), client_secret="sek")
    tokens = await prov.exchange_code(code="abc", redirect_uri="https://app/cb")
    assert tokens["access_token"] == "at-xyz"
    got = await prov.fetch_userinfo(tokens["access_token"])
    assert got["email"] == "a@corp.com"
    assert calls["token"] == 1 and calls["userinfo"] == 1


def test_identity_from_google_and_microsoft():
    g = oidc.OidcProvider(_generic_provider(type="google"))
    idg = g.identity_from({"sub": "g1", "email": "x@corp.com", "hd": "corp.com", "name": "X"})
    assert idg["sub"] == "g1" and idg["domain"] == "corp.com"

    m = oidc.OidcProvider(_generic_provider(type="microsoft"))
    idm = m.identity_from({"sub": "pairwise", "oid": "oid-1", "tid": "TENANT-A", "email": "y@corp.com"})
    # Microsoft prefers the immutable oid as the subject; tenant lower-cased.
    assert idm["sub"] == "oid-1" and idm["tenant"] == "tenant-a"
    # Email domain fills `domain` when there is no `hd`.
    assert idm["domain"] == "corp.com"


def test_domain_allowlist():
    prov = oidc.OidcProvider(_generic_provider(allowed_domains=["corp.com"]))
    assert prov.check_allowed({"domain": "corp.com"}) is None
    assert prov.check_allowed({"domain": "evil.com"}) is not None


def test_tenant_allowlist():
    prov = oidc.OidcProvider(_generic_provider(type="microsoft", allowed_tenants=["tenant-a"]))
    assert prov.check_allowed({"tenant": "tenant-a"}) is None
    assert prov.check_allowed({"tenant": "tenant-b"}) is not None


def test_group_to_role_mapping():
    prov = oidc.OidcProvider(_generic_provider(
        group_claim="groups",
        group_role_map={"soc-admins": "super_admin", "soc-analysts": "analyst_tier2"},
        default_role="analyst_tier1",
    ))
    ident = prov.identity_from({"sub": "s", "email": "e@corp.com", "groups": ["other", "soc-analysts"]})
    assert prov.role_for(ident) == "analyst_tier2"
    # No mapped group → default role.
    ident2 = prov.identity_from({"sub": "s", "email": "e@corp.com", "groups": ["unknown"]})
    assert prov.role_for(ident2) == "analyst_tier1"


# --------------------------------------------------------------------------- #
# End-to-end SSO callback through the real app (provisioning + idempotence)
# --------------------------------------------------------------------------- #
@pytest_asyncio.fixture
async def sso_state(monkeypatch):
    """An auth-ENABLED AppState with SSO configured for the generic IdP."""
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        auth_enabled=True,
        auth_jwt_secret="test-secret",
        auth_seed_admin=False,  # no demo admin; we control the user set
    )
    secrets.set_sso_client_secret("corp", "client-secret")
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}
    state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
    await state.startup(start_poller=False)
    prefs = state.prefs.model_copy(update={
        "setup_complete": True,
        "sso": SSOConfig(
            enabled=True,
            providers=[SSOProvider(
                id="corp", type="generic", display_name="Corp IdP",
                client_id="client-123",
                discovery_url="https://idp.example.com/.well-known/openid-configuration",
                allowed_domains=["corp.com"],
                group_claim="groups",
                group_role_map={"soc-admins": "super_admin"},
                auto_create_users=True,
                default_role="analyst_tier1",
            )],
        ),
    })
    await state.update_prefs(prefs)
    await state.refresh_users()
    yield state
    await state.shutdown()


def _client_for(state):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.routes import router

    app = FastAPI()
    app.include_router(router)
    # The state is already started by the fixture; attach it directly (no lifespan)
    # and use a plain TestClient (no startup/shutdown re-run).
    app.state.tlsoc = state
    return TestClient(app)


@pytest.mark.asyncio
async def test_authorize_stashes_single_use_state(monkeypatch, sso_state):
    _patch_http(monkeypatch, claims={})
    # Drive authorize through the route to stash state, then assert single-use.
    from app.api import routes as routes_mod

    class _Req:
        base_url = "https://app.example.com/"

    out = await routes_mod.sso_authorize(_Req(), provider="corp", state=sso_state)  # type: ignore[arg-type]
    assert out["auth_url"].startswith("https://idp.example.com/authorize?")
    # The stored state token is in the auth_url; extract + consume it twice.
    from urllib.parse import parse_qs, urlparse

    st = parse_qs(urlparse(out["auth_url"]).query)["state"][0]
    # Consume via the SAME public store the route uses (P13: no private _kv reach).
    rec1 = await sso_state.oidc_state.consume(st)
    assert rec1 is not None and rec1["provider"] == "corp"
    rec2 = await sso_state.oidc_state.consume(st)
    assert rec2 is None  # single-use


@pytest.mark.asyncio
async def test_callback_provisions_and_is_idempotent(monkeypatch, sso_state):
    claims = {"sub": "google-sub-1", "email": "alice@corp.com", "name": "Alice", "groups": ["soc-admins"]}
    _patch_http(monkeypatch, claims=claims)
    from app.api import routes as routes_mod

    class _Req:
        base_url = "https://app.example.com/"

    # First login: authorize → consume state → callback provisions the user.
    out = await routes_mod.sso_authorize(_Req(), provider="corp", state=sso_state)  # type: ignore[arg-type]
    from urllib.parse import parse_qs, urlparse

    st = parse_qs(urlparse(out["auth_url"]).query)["state"][0]

    client = _client_for(sso_state)
    resp = client.get(f"/api/auth/sso/callback?code=abc&state={st}", follow_redirects=False)
    assert resp.status_code == 302 and resp.headers["location"] == "/"
    assert "tlsoc_token" in resp.cookies or "set-cookie" in {k.lower() for k in resp.headers}

    users = await sso_state.users.list()
    assert len(users) == 1
    u = users[0]
    assert u.username == "alice@corp.com"
    assert u.oauth_provider == "corp" and u.oauth_sub == "google-sub-1"
    assert u.role == "super_admin"  # from the group map

    # Second login (new state): must NOT create a duplicate account.
    out2 = await routes_mod.sso_authorize(_Req(), provider="corp", state=sso_state)  # type: ignore[arg-type]
    st2 = parse_qs(urlparse(out2["auth_url"]).query)["state"][0]
    resp2 = client.get(f"/api/auth/sso/callback?code=abc&state={st2}", follow_redirects=False)
    assert resp2.status_code == 302
    users2 = await sso_state.users.list()
    assert len(users2) == 1  # idempotent — no dupes


@pytest.mark.asyncio
async def test_callback_domain_denied(monkeypatch, sso_state):
    claims = {"sub": "s2", "email": "mallory@evil.com", "name": "M"}
    _patch_http(monkeypatch, claims=claims)
    from app.api import routes as routes_mod

    class _Req:
        base_url = "https://app.example.com/"

    out = await routes_mod.sso_authorize(_Req(), provider="corp", state=sso_state)  # type: ignore[arg-type]
    from urllib.parse import parse_qs, urlparse

    st = parse_qs(urlparse(out["auth_url"]).query)["state"][0]
    client = _client_for(sso_state)
    resp = client.get(f"/api/auth/sso/callback?code=abc&state={st}", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"].startswith("/login?sso_error=")
    assert (await sso_state.users.count()) == 0  # not provisioned


@pytest.mark.asyncio
async def test_callback_no_auto_create_rejects(monkeypatch, sso_state):
    # Turn OFF auto-provisioning; an unknown user is rejected, not created.
    prefs = sso_state.prefs.model_copy()
    prefs.sso.providers[0].auto_create_users = False
    await sso_state.update_prefs(prefs)
    claims = {"sub": "s3", "email": "newbie@corp.com", "name": "N"}
    _patch_http(monkeypatch, claims=claims)
    from app.api import routes as routes_mod

    class _Req:
        base_url = "https://app.example.com/"

    out = await routes_mod.sso_authorize(_Req(), provider="corp", state=sso_state)  # type: ignore[arg-type]
    from urllib.parse import parse_qs, urlparse

    st = parse_qs(urlparse(out["auth_url"]).query)["state"][0]
    client = _client_for(sso_state)
    resp = client.get(f"/api/auth/sso/callback?code=abc&state={st}", follow_redirects=False)
    assert resp.status_code == 302
    assert "sso_error=user_not_provisioned" in resp.headers["location"]
    assert (await sso_state.users.count()) == 0


@pytest.mark.asyncio
async def test_callback_invalid_state(monkeypatch, sso_state):
    _patch_http(monkeypatch, claims={"sub": "s", "email": "a@corp.com"})
    client = _client_for(sso_state)
    resp = client.get("/api/auth/sso/callback?code=abc&state=bogus", follow_redirects=False)
    assert resp.status_code == 302
    assert "sso_error=invalid_state" in resp.headers["location"]


def test_sso_providers_public_lists_enabled(sso_state):
    client = _client_for(sso_state)
    resp = client.get("/api/auth/sso/providers")
    assert resp.status_code == 200
    provs = resp.json()["providers"]
    assert provs == [{"id": "corp", "type": "generic", "display_name": "Corp IdP"}]
