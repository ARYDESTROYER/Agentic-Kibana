"""Round 5 / Coupling-F (G8) — the generic EntryPointRegistry + loose-coupling seams.

Covers the DECOUPLING work, offline (no third-party plugins installed, no network):

* the ONE generic ``EntryPointRegistry[T]`` the connector + enrichment registries now
  compose (register precedence, key handling, defensive manifest listing, isolated
  discovery);
* the connector + enrichment registries stay byte-identical on top of it;
* the NEW entry-point discovery groups (``tlsoc.channels`` + ``tlsoc.llm_providers``);
* the narrow ``PollerHost`` / ``ResetHost`` Protocols + the public AppState accessors
  the poller/reset/OIDC-state now depend on instead of ``_real_*``/``_kv`` privates.

These prove the seams exist + behave, not that a third-party plugin loads (that needs a
real installed distribution). Discovery is asserted to be ISOLATED — a broken group /
plugin warns, never raises.
"""

from __future__ import annotations

import logging

import pytest

from app.plugins.registry import EntryPointRegistry, discover_entry_points


# --------------------------------------------------------------------------- #
# generic EntryPointRegistry[T]
# --------------------------------------------------------------------------- #
class _Plugin:
    def __init__(self, key: str, label: str = "") -> None:
        self.key = key
        self.label = label or key

    def manifest(self) -> dict:
        return {"key": self.key, "label": self.label}


def _reg() -> EntryPointRegistry[str, _Plugin]:
    return EntryPointRegistry("tlsoc.nonexistent_group", lambda p: p.key, what="widget")


def test_register_get_and_membership() -> None:
    reg = _reg()
    a = _Plugin("a")
    reg.register(a)
    assert reg.get("a") is a
    assert "a" in reg
    assert reg.get("missing") is None
    assert reg.keys() == ["a"]
    assert reg.values() == [a]
    assert list(reg) == [a]


def test_register_skips_missing_key(caplog) -> None:
    reg = _reg()
    with caplog.at_level(logging.WARNING):
        reg.register(_Plugin(""))  # empty key
    assert reg.keys() == []
    assert any("no key" in r.message for r in caplog.records)


def test_register_override_precedence_is_last_wins_and_logged(caplog) -> None:
    reg = _reg()
    first = _Plugin("dup", "first")
    second = _Plugin("dup", "second")
    reg.register(first)
    with caplog.at_level(logging.INFO):
        reg.register(second)  # same key, different object → overridden
    assert reg.get("dup") is second  # last wins
    assert any("overridden by" in r.message for r in caplog.records)


def test_register_same_object_twice_is_idempotent_no_override_log(caplog) -> None:
    reg = _reg()
    p = _Plugin("x")
    reg.register(p)
    with caplog.at_level(logging.INFO):
        reg.register(p)  # SAME object → not an override
    assert not any("overridden by" in r.message for r in caplog.records)


def test_pop_removes_plugin() -> None:
    reg = _reg()
    p = _Plugin("gone")
    reg.register(p)
    assert reg.pop("gone") is p
    assert reg.get("gone") is None
    assert reg.pop("gone") is None  # already gone → None


def test_iter_manifests_is_defensive(caplog) -> None:
    reg = _reg()
    reg.register(_Plugin("ok"))

    class _Bad(_Plugin):
        def manifest(self) -> dict:  # noqa: D401 — raises on purpose
            raise RuntimeError("boom")

    reg.register(_Bad("bad"))
    with caplog.at_level(logging.WARNING):
        mans = reg.iter_manifests(lambda p: p.manifest())
    # The good plugin's manifest survives; the bad one is skipped + warned.
    assert [m["key"] for m in mans] == ["ok"]
    assert any("manifest() failed" in r.message for r in caplog.records)


def test_iter_manifests_transform_applies() -> None:
    reg = _reg()
    reg.register(_Plugin("k"))
    mans = reg.iter_manifests(
        lambda p: p.manifest(),
        transform=lambda p, m: {**m, "augmented": True},
    )
    assert mans == [{"key": "k", "label": "k", "augmented": True}]


def test_discover_on_absent_group_is_a_safe_noop() -> None:
    # No distribution exports this group → discovery registers nothing + never raises.
    reg = _reg()
    reg.discover()
    assert reg.keys() == []


def test_discover_entry_points_isolates_a_bad_loader(caplog, monkeypatch) -> None:
    registered: list = []

    class _EP:
        name = "broken"

        def load(self):  # noqa: D401 — simulate a plugin that fails to import
            raise ImportError("cannot import plugin")

    import app.plugins.registry as reg_mod

    monkeypatch.setattr(
        reg_mod.importlib_metadata, "entry_points", lambda group: [_EP()]
    )
    with caplog.at_level(logging.WARNING):
        discover_entry_points("tlsoc.x", registered.append, what="widget")
    assert registered == []  # the bad loader never registers
    assert any("Could not load" in r.message for r in caplog.records)


def test_discover_entry_points_registers_a_good_loader(monkeypatch) -> None:
    registered: list = []

    class _EP:
        name = "good"

        def load(self):
            return _Plugin("loaded")

    import app.plugins.registry as reg_mod

    monkeypatch.setattr(
        reg_mod.importlib_metadata, "entry_points", lambda group: [_EP()]
    )
    discover_entry_points("tlsoc.x", registered.append, what="widget")
    assert len(registered) == 1 and registered[0].key == "loaded"


# --------------------------------------------------------------------------- #
# connector + enrichment registries stay byte-identical on the generic
# --------------------------------------------------------------------------- #
def test_connector_registry_composes_generic_and_lists_builtins() -> None:
    from app.connectors.registry import get_registry

    reg = get_registry()
    types = reg.source_types()
    assert len(types) >= 3  # elastic/opensearch/wazuh + receivers
    mans = reg.manifests()
    # sorted by (category, display_name) — stable
    assert mans == sorted(mans, key=lambda m: (m.category, m.display_name))
    # The historical ``_classes`` live view still works (demo toggle relies on it).
    assert isinstance(reg._classes, dict) and reg._classes


def test_enrichment_registry_composes_generic_and_lists_builtins() -> None:
    from app.enrichment.registry import get_provider_registry

    reg = get_provider_registry()
    names = reg.names()
    assert names == sorted(names)  # stable, deterministic (#4-adjacent)
    assert len(reg.classes()) == len(names)
    assert len(reg.manifests()) == len(names)


# --------------------------------------------------------------------------- #
# NEW discovery groups: notifications channels + LLM providers
# --------------------------------------------------------------------------- #
def test_notification_channels_have_discovery_group() -> None:
    from app.notifications import channel as ch

    assert ch.ENTRY_POINT_GROUP == "tlsoc.channels"
    ch.ensure_registered()  # built-ins + (isolated) third-party discovery
    # Built-ins still present; discovery of an absent group changed nothing.
    for t in ("email", "slack", "webhook"):
        assert t in ch.channel_types()


def test_notification_channel_discovery_merges_a_plugin(monkeypatch) -> None:
    from app.notifications import channel as ch
    from app.notifications.channel import NotificationChannel, SendResult

    class _OpsGenie(NotificationChannel):
        type = "opsgenie_test"

        async def send(self, event) -> SendResult:  # pragma: no cover — never called here
            return SendResult(ok=True)

    class _EP:
        name = "opsgenie"

        def load(self):
            return _OpsGenie

    import app.plugins.registry as reg_mod

    monkeypatch.setattr(reg_mod.importlib_metadata, "entry_points", lambda group: [_EP()])
    # Force a fresh discovery pass.
    monkeypatch.setattr(ch, "_DISCOVERED", False, raising=False)
    ch._discover_third_party()
    assert "opsgenie_test" in ch.channel_types()


def test_llm_provider_discovery_group_and_merge(monkeypatch) -> None:
    import app.llm.providers as prov

    assert prov.ENTRY_POINT_GROUP == "tlsoc.llm_providers"
    # Built-ins present + untouched.
    for name in ("anthropic", "openai", "mock"):
        assert name in prov.PROVIDER_REGISTRY

    def _factory(**_):  # a discovered provider factory
        return prov.MockProvider()

    class _EP:
        name = "vllm-cluster"

        def load(self):
            return ("vllm_cluster_test", _factory)

    monkeypatch.setattr(prov, "_LLM_DISCOVERED", False, raising=False)
    import app.plugins.registry as reg_mod

    monkeypatch.setattr(reg_mod.importlib_metadata, "entry_points", lambda group: [_EP()])
    prov.ensure_providers_discovered()
    assert prov.PROVIDER_REGISTRY.get("vllm_cluster_test") is _factory
    # cleanup so we don't leak into the module-global registry for other tests
    prov.PROVIDER_REGISTRY.pop("vllm_cluster_test", None)


# --------------------------------------------------------------------------- #
# narrow Protocols + public accessors (poller/reset/OIDC-state seams)
# --------------------------------------------------------------------------- #
@pytest.mark.asyncio
async def test_appstate_satisfies_poller_and_reset_protocols(app_state) -> None:
    from app.engine.poller_manager import PollerHost
    from app.engine.reset import ResetHost

    assert isinstance(app_state, PollerHost)
    assert isinstance(app_state, ResetHost)


@pytest.mark.asyncio
async def test_public_real_accessors_return_the_real_collaborators(app_state) -> None:
    # The poller/reset now depend on these public accessors (not _real_* privates).
    assert app_state.real_cases is app_state._real_cases
    assert app_state.real_audit is app_state._real_audit
    assert app_state.real_pipeline is app_state._real_pipeline
    assert app_state.real_ingest_service is app_state._real_ingest_service
    assert app_state.kv is app_state._kv
    assert app_state.is_sql_backend() is False  # in-memory ES fixture
    assert app_state.sql_engine is None


@pytest.mark.asyncio
async def test_event_bus_injected_at_pipeline_construction(app_state) -> None:
    # Round 5 promoted event_bus from a post-hoc setter to a ctor kwarg; the pipeline
    # carries the module-global bus from construction.
    assert app_state._real_pipeline.event_bus is app_state.event_bus


@pytest.mark.asyncio
async def test_oidc_state_public_accessor_round_trips(app_state) -> None:
    store = app_state.oidc_state
    await store.stash("s-tok", {"provider": "google", "nonce": "n", "redirect_uri": "r"})
    rec = await store.consume("s-tok")
    assert rec and rec["provider"] == "google" and rec["nonce"] == "n"
    # Single-use: a replay finds it consumed.
    assert await store.consume("s-tok") is None
    # Unknown token → None (never raises).
    assert await store.consume("never-existed") is None
