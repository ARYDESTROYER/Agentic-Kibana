"""Round 3 Wave 2b — first-class cloud LLM providers + Project Honeypot config gaps.

Closes the frozen-config gaps the Wave-2 builders flagged. Covers:

  * config — the widened ``Provider`` Literal (azure/bedrock/vertex/openai_compatible
    alongside anthropic/openai/mock); the new ``ModelConfig`` endpoint overrides
    (base_url/api_version/region) defaulting safely + round-tripping; a
    ``ModelConfig(provider='azure', base_url=...)`` constructing WITHOUT
    ``model_construct``; the new ``Secrets`` cloud-LLM + enrichment fields defaulting
    None + surfacing as configured-booleans (values NEVER returned, #10);
    ``EnrichmentConfig.use_honeypot`` defaulting OFF.
  * llm — the gateway authenticating the cloud providers from the new Secrets
    (azure api-key/endpoint/api-version, bedrock IAM pair/region, vertex token/project/
    location) + the per-role ModelConfig.base_url winning over the registry; the model
    catalog / models_by_provider surfacing the cloud-provider rows.
  * enrichment — ProjectHoneypot REGISTERED + only firing when toggled AND keyed; the
    abuse.ch trio sending the optional ``Auth-Key`` header only when the key is set
    (keyless path byte-identical otherwise).

All offline (no network): the HTTP + provider-factory layers are monkeypatched.
"""

from __future__ import annotations

from typing import Any, get_args

import pytest

from app.config import (
    DEFAULT_COMPLETION_MODEL,
    DEFAULT_COMPLETION_PROVIDER,
    EnrichmentConfig,
    ModelConfig,
    Preferences,
    Provider,
    Secrets,
)
from app.constants import IndicatorKind, Role, USAGE_READ_PATTERN, UsageOutcome
from app.es.fake import InMemoryESClient
from app.llm import pricing
from app.llm.gateway import LLMGateway
from app.llm.providers import PROVIDER_REGISTRY, MockProvider
from app.stores.usage import UsageStore


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _secrets(**overrides: Any) -> Secrets:
    return Secrets(_env_file=None, **overrides)  # type: ignore[call-arg]


async def _usage_docs(es: InMemoryESClient):
    resp = await es.search(USAGE_READ_PATTERN, {"size": 100, "query": {"match_all": {}}})
    return [h["_source"] for h in resp["hits"]["hits"]]


# --------------------------------------------------------------------------- #
# config — Provider Literal widened
# --------------------------------------------------------------------------- #
def test_provider_literal_includes_cloud_providers() -> None:
    args = set(get_args(Provider))
    assert {"anthropic", "openai", "mock"}.issubset(args)  # legacy unchanged
    assert {"azure", "bedrock", "vertex", "openai_compatible"}.issubset(args)


def test_modelconfig_constructs_cloud_provider_without_model_construct() -> None:
    # Directly constructible now that the Literal is widened (no model_construct bypass).
    m = ModelConfig(provider="azure", model="azure-gpt-4o",
                    base_url="https://r.openai.azure.com", api_version="2024-10-21")
    assert m.provider == "azure"
    assert m.base_url == "https://r.openai.azure.com"
    assert m.api_version == "2024-10-21"
    # bedrock + vertex + openai_compatible likewise validate.
    for prov in ("bedrock", "vertex", "openai_compatible"):
        assert ModelConfig(provider=prov, model="x").provider == prov  # type: ignore[arg-type]


def test_modelconfig_endpoint_fields_default_safely_and_round_trip() -> None:
    base = ModelConfig()  # today's behaviour: no endpoint overrides
    assert base.base_url is None and base.api_version is None and base.region is None
    cfg = ModelConfig(provider="bedrock", model="m", region="eu-west-1",
                      base_url="https://x", api_version="v")
    rt = ModelConfig(**cfg.model_dump())
    assert rt == cfg
    rt_json = ModelConfig.model_validate(cfg.model_dump(mode="json"))
    assert rt_json == cfg


def test_modelconfig_uses_current_fresh_install_default() -> None:
    m = ModelConfig()
    assert m.provider == DEFAULT_COMPLETION_PROVIDER == "openai"
    assert m.model == DEFAULT_COMPLETION_MODEL == "gpt-5.6-luna"
    assert m.temperature == 0.1
    assert m.max_tokens == 1500


def test_every_fresh_completion_role_uses_luna_but_embeddings_stay_dedicated() -> None:
    prefs = Preferences()
    for role in ("router", "investigator", "formatter", "standup", "chat", "overview"):
        cfg = prefs.model_for(role)
        assert cfg.provider == "openai", role
        assert cfg.model == "gpt-5.6-luna", role
    assert prefs.embedding_model.provider == "openai"
    assert prefs.embedding_model.model == "text-embedding-3-small"


def test_explicit_stored_role_assignments_survive_new_defaults() -> None:
    """Changing fresh defaults must never migrate an operator's saved routing."""
    stored = Preferences().model_dump(mode="json")
    stored.update({
        "router_model": {
            "provider": "anthropic", "model": "claude-haiku-4-5", "max_tokens": 601,
        },
        "investigator_model": {
            "provider": "anthropic", "model": "claude-sonnet-4-6", "max_tokens": 2001,
        },
        "formatter_model": {
            "provider": "openai", "model": "gpt-4o-mini", "max_tokens": 1201,
        },
        "standup_model": {
            "provider": "openai", "model": "gpt-4.1-mini", "max_tokens": 1202,
        },
        "chat_model": {
            "provider": "openai_compatible", "model": "local-chat",
            "base_url": "http://model.internal", "max_tokens": 1501,
        },
        "overview_model": {
            "provider": "azure", "model": "azure-overview",
            "base_url": "https://example.openai.azure.com", "max_tokens": 901,
        },
        "embedding_model": {
            "provider": "openai", "model": "text-embedding-3-large", "max_tokens": 1500,
        },
    })

    restored = Preferences.model_validate(stored)

    assert restored.router_model.model == "claude-haiku-4-5"
    assert restored.investigator_model.model == "claude-sonnet-4-6"
    assert restored.formatter_model.model == "gpt-4o-mini"
    assert restored.standup_model.model == "gpt-4.1-mini"
    assert restored.chat_model.model == "local-chat"
    assert restored.chat_model.base_url == "http://model.internal"
    assert restored.overview_model.model == "azure-overview"
    assert restored.embedding_model.model == "text-embedding-3-large"


# --------------------------------------------------------------------------- #
# config — Secrets new fields default None + configured-boolean view (no values)
# --------------------------------------------------------------------------- #
_NEW_SECRET_FIELDS = (
    "azure_openai_api_key", "azure_openai_endpoint", "azure_openai_api_version",
    "aws_access_key_id", "aws_secret_access_key", "aws_session_token", "aws_region",
    "vertex_project", "vertex_location", "vertex_api_key",
    "honeypot_access_key", "abusech_auth_key",
)


def test_new_secret_fields_default_none() -> None:
    s = _secrets()
    for field in _NEW_SECRET_FIELDS:
        assert getattr(s, field) is None, field


def test_new_secret_fields_surface_as_configured_booleans() -> None:
    s = _secrets()
    cs = s.configured_status()
    for field in _NEW_SECRET_FIELDS:
        assert field in cs and cs[field] is False, field
    # Set a couple and confirm the boolean flips, and the VALUE never leaks (#10).
    s2 = _secrets(azure_openai_api_key="super-secret", honeypot_access_key="hkey")
    cs2 = s2.configured_status()
    assert cs2["azure_openai_api_key"] is True
    assert cs2["honeypot_access_key"] is True
    assert "super-secret" not in str(cs2) and "hkey" not in str(cs2)


def test_secrets_round_trip_preserves_new_fields() -> None:
    s = _secrets(aws_access_key_id="AKIA", aws_region="us-east-1", vertex_api_key="tok")
    dumped = s.model_dump()
    s2 = Secrets(_env_file=None, **{k: v for k, v in dumped.items()})  # type: ignore[call-arg]
    assert s2.aws_access_key_id == "AKIA"
    assert s2.aws_region == "us-east-1"
    assert s2.vertex_api_key == "tok"


def test_provider_key_maps_cloud_providers() -> None:
    s = _secrets(azure_openai_api_key="az", aws_access_key_id="akid", vertex_api_key="vt",
                 openai_api_key="oai", anthropic_api_key="ant")
    assert s.provider_key("azure") == "az"
    assert s.provider_key("bedrock") == "akid"
    assert s.provider_key("vertex") == "vt"
    assert s.provider_key("openai_compatible") == "oai"
    assert s.provider_key("anthropic") == "ant"
    assert s.provider_key("mock") == "mock"


# --------------------------------------------------------------------------- #
# config — EnrichmentConfig.use_honeypot
# --------------------------------------------------------------------------- #
def test_enrichment_use_honeypot_defaults_off_and_round_trips() -> None:
    ec = EnrichmentConfig()
    assert ec.use_honeypot is False
    ec2 = EnrichmentConfig(use_honeypot=True)
    assert ec2.use_honeypot is True
    assert EnrichmentConfig(**ec2.model_dump()).use_honeypot is True


# --------------------------------------------------------------------------- #
# llm — the gateway resolves cloud-provider kwargs from the new Secrets
# --------------------------------------------------------------------------- #
def test_gateway_resolves_azure_kwargs_from_secrets() -> None:
    s = _secrets(azure_openai_api_key="az-key", azure_openai_endpoint="https://r.azure",
                 azure_openai_api_version="2024-10-21")
    gw = LLMGateway(secrets=s, usage_store=UsageStore(InMemoryESClient()))
    kwargs = gw._provider_kwargs("azure", for_embedding=False, base_url=None)
    assert kwargs["api_key"] == "az-key"
    assert kwargs["base_url"] == "https://r.azure"
    assert kwargs["api_version"] == "2024-10-21"


def test_gateway_resolves_bedrock_kwargs_from_secrets() -> None:
    s = _secrets(aws_access_key_id="AKIA", aws_secret_access_key="sk",
                 aws_region="eu-central-1", aws_session_token="tok")
    gw = LLMGateway(secrets=s, usage_store=UsageStore(InMemoryESClient()))
    kwargs = gw._provider_kwargs("bedrock", for_embedding=False, base_url=None)
    assert kwargs["access_key_id"] == "AKIA"
    assert kwargs["secret_access_key"] == "sk"
    assert kwargs["region"] == "eu-central-1"
    assert kwargs["session_token"] == "tok"


def test_gateway_resolves_vertex_kwargs_from_secrets() -> None:
    s = _secrets(vertex_api_key="oauth-token", vertex_project="proj", vertex_location="us-west1")
    gw = LLMGateway(secrets=s, usage_store=UsageStore(InMemoryESClient()))
    kwargs = gw._provider_kwargs("vertex", for_embedding=False, base_url=None)
    assert kwargs["access_token"] == "oauth-token"
    assert kwargs["project"] == "proj"
    assert kwargs["location"] == "us-west1"


def test_gateway_per_role_overrides_win_over_secret_defaults() -> None:
    # The per-role ModelConfig.api_version / region win over the secret defaults.
    s = _secrets(azure_openai_api_version="secret-version", aws_region="secret-region")
    gw = LLMGateway(secrets=s, usage_store=UsageStore(InMemoryESClient()))
    az = gw._provider_kwargs("azure", for_embedding=False, base_url=None,
                             api_version="role-version")
    assert az["api_version"] == "role-version"
    br = gw._provider_kwargs("bedrock", for_embedding=False, base_url=None,
                             region="role-region")
    assert br["region"] == "role-region"


async def test_gateway_per_role_base_url_wins_over_registry(monkeypatch) -> None:
    grabbed: dict[str, Any] = {}

    def _fake_factory(**kwargs):
        grabbed["base_url"] = kwargs.get("base_url")
        return MockProvider()

    monkeypatch.setitem(PROVIDER_REGISTRY, "openai_compatible", _fake_factory)
    # The registry would say None for this unknown model; the per-role base_url wins.
    from app.llm import gateway as gw_mod

    monkeypatch.setattr(gw_mod, "base_url_for", lambda m: None)
    es = InMemoryESClient()
    gw = LLMGateway(secrets=_secrets(openai_api_key="k"), usage_store=UsageStore(es))
    cfg = ModelConfig(provider="openai_compatible", model="local-x",
                      base_url="https://my.vllm/v1")
    await gw.complete(Role.CHAT, [{"role": "user", "content": "hi"}], cfg, surface="chat")
    assert grabbed["base_url"] == "https://my.vllm/v1"
    # one ledger row written (#6).
    docs = await _usage_docs(es)
    assert len(docs) == 1 and docs[0]["outcome"] == UsageOutcome.OK.value


# --------------------------------------------------------------------------- #
# llm — the cloud providers surface in the catalog the webui picker reads
# --------------------------------------------------------------------------- #
def test_catalog_surfaces_cloud_providers() -> None:
    pricing.load_registry.cache_clear()
    cat = {r["id"]: r for r in pricing.model_catalog()}
    assert "azure-gpt-4o" in cat and cat["azure-gpt-4o"]["provider"] == "azure"
    assert cat["azure-gpt-4o"]["base_url"] == "https://YOUR-RESOURCE.openai.azure.com"
    bedrock_id = "anthropic.claude-3-5-sonnet-20241022-v2:0"
    assert cat[bedrock_id]["provider"] == "bedrock"
    assert cat["gemini-1.5-pro"]["provider"] == "vertex"
    oc = cat["local-llama-3.1-8b"]
    assert oc["provider"] == "openai_compatible"
    assert oc["base_url"] == "http://localhost:8000/v1"
    # the picker grouping includes the new provider buckets without dropping the legacy.
    grouped = pricing.models_by_provider()
    assert {"anthropic", "openai", "mock"}.issubset(grouped)
    assert "azure-gpt-4o" in grouped["azure"]
    assert "gemini-1.5-pro" in grouped["vertex"]


def test_cloud_registry_models_price_as_exact() -> None:
    pricing.load_registry.cache_clear()
    for mid in ("azure-gpt-4o", "anthropic.claude-3-5-sonnet-20241022-v2:0", "gemini-1.5-pro"):
        assert pricing.pricing_source(mid) == "exact", mid
        assert pricing.provider_for("something-not-in-registry") == "other"  # heuristic intact


# --------------------------------------------------------------------------- #
# enrichment — Project Honeypot registered + gated; abuse.ch Auth-Key header
# --------------------------------------------------------------------------- #
def test_project_honeypot_registered() -> None:
    from app.enrichment.providers import BUILTIN_PROVIDERS
    from app.enrichment.registry import get_provider_registry

    assert any(c.name == "projecthoneypot" for c in BUILTIN_PROVIDERS)
    assert "projecthoneypot" in set(get_provider_registry().names())


def test_project_honeypot_only_fires_when_toggled_and_keyed() -> None:
    from app.enrichment.registry import get_provider_registry

    reg = get_provider_registry()

    def _selected(cfg: EnrichmentConfig, secrets: Secrets) -> set[str]:
        return {c.name for c in reg.for_indicator(IndicatorKind.IP, cfg, secrets)}

    # default (toggle off, no key) → not selected.
    assert "projecthoneypot" not in _selected(EnrichmentConfig(), _secrets())
    # toggle ON but NO key → still not selected (key_present gate).
    assert "projecthoneypot" not in _selected(EnrichmentConfig(use_honeypot=True), _secrets())
    # key set but toggle OFF → not selected (config gate).
    keyed = _secrets(honeypot_access_key="abcdefghijkl")
    assert "projecthoneypot" not in _selected(EnrichmentConfig(use_honeypot=False), keyed)
    # toggle ON + key set → selected.
    assert "projecthoneypot" in _selected(EnrichmentConfig(use_honeypot=True), keyed)


async def test_abusech_sends_auth_key_header_only_when_set(monkeypatch) -> None:
    from app.enrichment.providers import abusech

    captured: dict[str, Any] = {}

    async def fake_json(url, **kwargs):  # noqa: ANN001
        captured["headers"] = kwargs.get("headers")
        return {"query_status": "ok", "data": [{"confidence_level": 90, "malware_printable": "X"}]}

    monkeypatch.setattr(abusech, "http_json", fake_json)

    # No key → no Auth-Key header (keyless public path byte-identical).
    prov = abusech.ThreatFoxProvider(EnrichmentConfig(), _secrets())
    r = await prov.lookup("1.2.3.4", IndicatorKind.IP)
    assert r.ok and captured["headers"] is None

    # Key set → Auth-Key header is sent.
    prov2 = abusech.ThreatFoxProvider(EnrichmentConfig(), _secrets(abusech_auth_key="KEY123"))
    await prov2.lookup("1.2.3.4", IndicatorKind.IP)
    assert captured["headers"] == {"Auth-Key": "KEY123"}


async def test_malwarebazaar_and_urlhaus_honour_auth_key(monkeypatch) -> None:
    from app.enrichment.providers import abusech

    captured: list[dict[str, Any] | None] = []

    async def fake_json(url, **kwargs):  # noqa: ANN001
        captured.append(kwargs.get("headers"))
        # A minimal "no_results" body keeps both providers on the clean-miss path.
        return {"query_status": "no_results"}

    monkeypatch.setattr(abusech, "http_json", fake_json)
    secrets = _secrets(abusech_auth_key="K")
    await abusech.MalwareBazaarProvider(EnrichmentConfig(), secrets).lookup("a" * 64, IndicatorKind.FILE_HASH)
    await abusech.URLhausProvider(EnrichmentConfig(), secrets).lookup("bad.example", IndicatorKind.DOMAIN)
    assert captured and all(h == {"Auth-Key": "K"} for h in captured)


# --------------------------------------------------------------------------- #
# settings schema — the enrichment + (object) sections still introspect cleanly,
# and the new use_honeypot field appears under enrichment.
# --------------------------------------------------------------------------- #
def test_settings_schema_exposes_use_honeypot() -> None:
    from app.api.settings_schema import settings_schema

    schema = settings_schema()
    sections = {s["key"]: s for s in schema["sections"]}
    assert "enrichment" in sections
    field_names = {f["name"] for f in sections["enrichment"]["fields"]}
    assert "use_honeypot" in field_names
