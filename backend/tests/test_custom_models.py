"""Custom (self-hosted / LiteLLM / OpenAI-compatible) models — task 7.

Covers the runtime "add a local model" path end-to-end, offline:

  STORE     — CustomModelStore round-trip (add/get/list/base_url_for/remove/put),
              bounds + best-effort decode.
  GATEWAY   — a completion routed to a runtime-registered custom model reaches ITS
              base_url (via the store fallback, no per-role base_url) and records
              EXACTLY ONE UsageDoc at $0 with 'exact' provenance — even with NO price
              overlay set (the store-only $0 belt). Non-custom models are unchanged.
  ROUTES    — POST/DELETE /api/llm/models/custom (catalog merge, $0 overlay, secret
              tier for the key, http(s)-only base_url validation, #9 fencing, RBAC),
              POST /api/llm/providers/test (scheme validation + a mocked reachability
              probe).

All offline (fake ES + mock providers + a mocked httpx for the reachability probe).
No network.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.config import ModelConfig, Secrets
from app.constants import Role, USAGE_READ_PATTERN, UsageOutcome
from app.es.fake import InMemoryESClient
from app.llm.gateway import LLMGateway
from app.llm.providers import PROVIDER_REGISTRY, MockProvider
from app.state import AppState
from app.stores.custom_models import CustomModelStore
from app.stores.memory import EsKVStore
from app.stores.price_overlay import PriceOverlayStore
from app.stores.usage import UsageStore


class _FakeSecrets:
    anthropic_api_key = "sk-ant"
    openai_api_key = "sk-oai"
    litellm_api_key = None
    embedding_api_key = None

    def embedding_key(self):
        return self.openai_api_key


def _kv():
    return EsKVStore(InMemoryESClient())


async def _usage_docs(es: InMemoryESClient):
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [h["_source"] for h in resp["hits"]["hits"]]


# --------------------------------------------------------------------------- #
# STORE
# --------------------------------------------------------------------------- #
async def test_custom_model_store_round_trip():
    store = CustomModelStore(_kv())
    assert await store.get() == {}
    row = await store.add(
        "my-local-llama", label="Local Llama", base_url="http://litellm:4000/v1",
        context_window=8192,
    )
    assert row["id"] == "my-local-llama"
    assert row["provider"] == "openai_compatible"
    assert row["input_per_million"] == 0.0 and row["output_per_million"] == 0.0
    assert await store.base_url_for("my-local-llama") == "http://litellm:4000/v1"
    got = await store.get_model("my-local-llama")
    assert got and got["label"] == "Local Llama" and got["context_window"] == 8192
    listed = await store.list_models()
    assert [r["id"] for r in listed] == ["my-local-llama"]
    # remove
    assert await store.remove("my-local-llama") is True
    assert await store.remove("my-local-llama") is False
    assert await store.get_model("my-local-llama") is None


async def test_custom_model_store_rejects_empty_id_and_url():
    store = CustomModelStore(_kv())
    with pytest.raises(ValueError):
        await store.add("", base_url="http://x/v1")
    with pytest.raises(ValueError):
        await store.add("m", base_url="")


async def test_custom_model_store_put_drops_invalid_rows():
    store = CustomModelStore(_kv())
    out = await store.put({
        "good": {"base_url": "http://ollama:11434/v1", "label": "Ollama"},
        "bad-no-url": {"label": "no url"},          # dropped: no base_url
        "": {"base_url": "http://x/v1"},             # dropped: empty id
    })
    assert set(out) == {"good"}
    assert await store.base_url_for("good") == "http://ollama:11434/v1"


# --------------------------------------------------------------------------- #
# GATEWAY — base_url routing + $0 (the load-bearing guarantee)
# --------------------------------------------------------------------------- #
async def test_gateway_routes_custom_model_to_base_url_at_zero_cost(monkeypatch):
    """A role bound to a runtime-registered custom model (NO per-role base_url, NO price
    overlay) must (1) reach the model's registered base_url and (2) record exactly ONE
    $0 UsageDoc with 'exact' provenance — the store-only belt proving base_url routing +
    $0 pricing without any overlay."""
    captured: dict[str, Any] = {}

    def _fake_openai_compatible(**kwargs):
        captured["base_url"] = kwargs.get("base_url")
        captured["api_key"] = kwargs.get("api_key")
        return MockProvider()

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai_compatible", _fake_openai_compatible)

    store = CustomModelStore(_kv())
    await store.add("my-local-llama", base_url="http://litellm:4000/v1", label="Local")

    es = InMemoryESClient()
    # NOTE: no price_overlay passed → the ONLY source of $0 is the custom-model store.
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es), custom_models=store)
    cfg = ModelConfig(provider="openai_compatible", model="my-local-llama")  # no base_url
    res = await gw.complete(Role.CHAT, [{"role": "user", "content": "hi"}], cfg, surface="chat")

    # Routed to the registered endpoint.
    assert captured["base_url"] == "http://litellm:4000/v1"
    # A real $0 (not the conservative $1/$3 default an unknown model would bill).
    assert res.cost == 0.0
    docs = await _usage_docs(es)
    assert len(docs) == 1
    assert docs[0]["outcome"] == UsageOutcome.OK.value
    assert docs[0]["cost"] == 0.0
    assert docs[0]["pricing_source"] == "exact"  # operator-supplied local model → real $0


async def test_gateway_no_auth_local_server_gets_placeholder_bearer(monkeypatch):
    """A no-auth local server (base_url set, no key configured) still receives a
    well-formed, NON-EMPTY Bearer key so a strict OpenAI-compatible client accepts it."""
    captured: dict[str, Any] = {}

    def _fake(**kwargs):
        captured["api_key"] = kwargs.get("api_key")
        return MockProvider()

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai_compatible", _fake)

    class _NoKeys:
        anthropic_api_key = None
        openai_api_key = None
        litellm_api_key = None

        def embedding_key(self):
            return None

    store = CustomModelStore(_kv())
    await store.add("local-x", base_url="http://vllm:8000/v1")
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_NoKeys(), usage_store=UsageStore(es), custom_models=store)
    cfg = ModelConfig(provider="openai_compatible", model="local-x")
    await gw.complete(Role.CHAT, [{"role": "user", "content": "hi"}], cfg, surface="chat")
    assert captured["api_key"]  # non-empty placeholder


async def test_gateway_unknown_non_custom_model_unchanged(monkeypatch):
    """A model NOT in the custom store is untouched — it prices at the conservative
    default and provenance is 'default' (the custom path never changes a normal model)."""
    monkeypatch.setitem(PROVIDER_REGISTRY, "openai", lambda **_k: MockProvider())
    es = InMemoryESClient()
    store = CustomModelStore(_kv())  # empty
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es), custom_models=store)
    cfg = ModelConfig(provider="openai", model="zzz-unknown-model")
    res = await gw.complete(Role.CHAT, [{"role": "user", "content": "hi"}], cfg, surface="chat")
    assert res.cost > 0.0  # billed at the default rate, not silently free
    docs = await _usage_docs(es)
    assert docs[0]["pricing_source"] == "default"


async def test_gateway_overlay_still_wins_for_custom_model():
    """When an operator overlay IS present (the add-route belt), it drives the price —
    (0,0) → $0 — and provenance is 'exact', identical to the store-only path."""
    es = InMemoryESClient()
    overlay = PriceOverlayStore(_kv())
    await overlay.set_price("my-local", 0.0, 0.0)
    store = CustomModelStore(_kv())
    await store.add("my-local", base_url="http://litellm:4000/v1")
    gw = LLMGateway(secrets=_FakeSecrets(), usage_store=UsageStore(es),
                    provider_overrides={"openai_compatible": MockProvider()},
                    price_overlay=overlay, custom_models=store)
    cfg = ModelConfig(provider="openai_compatible", model="my-local",
                      base_url="http://litellm:4000/v1")
    res = await gw.complete(Role.CHAT, [{"role": "user", "content": "hi"}], cfg, surface="chat")
    assert res.cost == 0.0
    docs = await _usage_docs(es)
    assert docs[0]["pricing_source"] == "exact"


# --------------------------------------------------------------------------- #
# ROUTES — auth OFF (behaviour), then auth ON (RBAC)
# --------------------------------------------------------------------------- #
def _open_client():
    """A TestClient with the models router + the monolith router, auth OFF."""
    from app.api.routes import router as monolith_router
    from app.api.routes_models import router as models_router

    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="",
                      anthropic_api_key=None, openai_api_key=None)
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        await state.update_prefs(state.prefs.model_copy(update={"setup_complete": True}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router)
    api.include_router(models_router)
    return TestClient(api)


def test_add_custom_model_appears_in_catalog_and_picker_at_zero():
    with _open_client() as c:
        r = c.post("/api/llm/models/custom", json={
            "model_id": "team-llama-3.1",
            "base_url": "http://litellm:4000/v1",
            "label": "Team Llama 3.1",
            "context_window": 8192,
        })
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True
        assert r.json()["model"]["base_url"] == "http://litellm:4000/v1"

        # In the rich catalog with is_custom + $0 + base_url.
        cat = c.get("/api/llm/models").json()
        row = next((m for m in cat["models"] if m["id"] == "team-llama-3.1"), None)
        assert row is not None
        assert row["is_custom"] is True
        assert row["provider"] == "openai_compatible"
        assert row["input_per_million"] == 0.0 and row["output_per_million"] == 0.0
        assert row["base_url"] == "http://litellm:4000/v1"
        assert row["pricing_source"] == "exact"

        # And selectable in the per-role picker, with its base_url exposed for threading.
        picker = c.get("/api/models").json()
        assert "team-llama-3.1" in picker["providers"].get("openai_compatible", [])
        assert picker["base_urls"]["team-llama-3.1"] == "http://litellm:4000/v1"


def test_add_custom_model_stores_key_in_secret_tier_not_config():
    with _open_client() as c:
        r = c.post("/api/llm/models/custom", json={
            "model_id": "authed-litellm",
            "base_url": "https://litellm.example.com/v1",
            "api_key": "sk-litellm-secret",
        })
        assert r.status_code == 200, r.text
        # The UI only ever sees a configured boolean — never the value (#10).
        assert r.json()["configured"]["litellm_api_key"] is True


def test_add_custom_model_rejects_non_http_scheme():
    with _open_client() as c:
        for bad in ("file:///etc/passwd", "javascript:alert(1)", "not-a-url"):
            r = c.post("/api/llm/models/custom", json={"model_id": "x", "base_url": bad})
            assert r.status_code == 400, f"{bad} -> {r.status_code}"


def test_add_custom_model_allows_loopback_and_lan_hosts():
    """LAN/loopback endpoints are the LEGITIMATE local-model case — NOT blocked."""
    with _open_client() as c:
        for ok in ("http://127.0.0.1:1234/v1", "http://192.168.1.50:11434/v1",
                   "http://ollama:11434/v1"):
            r = c.post("/api/llm/models/custom", json={"model_id": f"m{hash(ok) % 99}",
                                                       "base_url": ok})
            assert r.status_code == 200, f"{ok} -> {r.text}"


def test_add_custom_model_fences_hostile_label():
    """A hostile label is returned as a PLAIN, bounded string (#9): it is stored/echoed
    verbatim (no markup execution — the UI render-escapes it) and never a prompt input.
    An over-long label is separately rejected by the Pydantic bound (422)."""
    with _open_client() as c:
        r = c.post("/api/llm/models/custom", json={
            "model_id": "evil",
            "base_url": "http://x:4000/v1",
            "label": "<script>alert(1)</script>",
        })
        assert r.status_code == 200, r.text
        label = r.json()["model"]["label"]
        assert isinstance(label, str) and label == "<script>alert(1)</script>"
        assert len(label) <= 200
        # The oversize label is rejected up front by the request bound (defense-in-depth).
        over = c.post("/api/llm/models/custom", json={
            "model_id": "evil2", "base_url": "http://x:4000/v1", "label": "A" * 5000,
        })
        assert over.status_code == 422


def test_remove_custom_model():
    with _open_client() as c:
        c.post("/api/llm/models/custom", json={"model_id": "temp", "base_url": "http://x:4000/v1"})
        assert any(m["id"] == "temp" for m in c.get("/api/llm/models").json()["models"])
        d = c.delete("/api/llm/models/custom/temp")
        assert d.status_code == 200 and d.json()["removed"] is True
        assert not any(m["id"] == "temp" for m in c.get("/api/llm/models").json()["models"])
        # Idempotent — a second delete just reports removed=False.
        assert c.delete("/api/llm/models/custom/temp").json()["removed"] is False


def test_providers_test_rejects_bad_scheme():
    with _open_client() as c:
        r = c.post("/api/llm/providers/test", json={"base_url": "file:///x"})
        assert r.status_code == 400


def test_providers_test_reports_unreachable_gracefully():
    # The offline network guard blocks the outbound probe → ok:False, never a 500.
    with _open_client() as c:
        r = c.post("/api/llm/providers/test", json={"base_url": "http://litellm:4000/v1"})
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is False


def test_providers_test_fetches_models_when_reachable(monkeypatch):
    """A mocked reachable endpoint returns its /models list to populate the dialog."""
    import app.api.routes_models as rm

    class _Resp:
        def raise_for_status(self):
            return None

        def json(self):
            return {"data": [{"id": "llama-3.1-8b"}, {"id": "mistral-7b"}]}

    class _FakeClient:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url, headers=None):
            return _Resp()

    monkeypatch.setattr(rm.httpx, "AsyncClient", _FakeClient)
    with _open_client() as c:
        r = c.post("/api/llm/providers/test",
                   json={"base_url": "http://litellm:4000/v1", "api_key": "k"})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["models"] == ["llama-3.1-8b", "mistral-7b"]


# --------------------------------------------------------------------------- #
# ROUTES — auth ON (RBAC): models:manage required to add/remove a custom model
# --------------------------------------------------------------------------- #
def _auth_client():
    from app.api.deps import require_auth
    from app.api.routes import router as monolith_router
    from app.api.routes_models import router as models_router

    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
        auth_enabled=True, auth_jwt_secret="custom-models-secret", auth_seed_admin=True,
        auth_admin_username="envadmin", auth_admin_password=None,
    )
    mock = MockProvider()
    overrides = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)
        await state.startup(start_poller=False)
        prefs = state.prefs.model_copy(update={"setup_complete": True})
        prefs = prefs.model_copy(update={"rbac": prefs.rbac.model_copy(update={"enabled": True})})
        await state.update_prefs(prefs)
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(monolith_router, dependencies=[Depends(require_auth)])
    api.include_router(models_router, dependencies=[Depends(require_auth)])
    return TestClient(api)


def test_custom_model_add_requires_models_manage():
    with _auth_client() as c:
        # Seeded super_admin CAN add.
        assert c.post("/api/auth/login",
                      json={"username": "Admin", "password": "Admin@123"}).status_code == 200
        assert c.post("/api/llm/models/custom",
                      json={"model_id": "m1", "base_url": "http://x:4000/v1"}).status_code == 200
        # An auditor (models:read, NOT models:manage) is denied.
        c.post("/api/users", json={"username": "aud", "password": "aud-pass-12345",
                                   "role": "auditor"})
        c.post("/api/auth/logout")
        assert c.post("/api/auth/login",
                      json={"username": "aud", "password": "aud-pass-12345"}).status_code == 200
        denied = c.post("/api/llm/models/custom",
                        json={"model_id": "m2", "base_url": "http://x:4000/v1"})
        assert denied.status_code == 403, denied.text
        assert c.delete("/api/llm/models/custom/m1").status_code == 403
