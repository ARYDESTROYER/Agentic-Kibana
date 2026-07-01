"""Enrichment-provider registry — discovery for built-in + third-party providers.

Mirrors :mod:`app.connectors.registry`. Built-ins (AbuseIPDB, VirusTotal in Wave 1)
are registered here; out-of-tree providers register via the ``tlsoc.enrichers``
entry-point group, so the community can ``pip install tlsoc-enricher-<vendor>`` and
have it appear with zero core change.

The registry's primary job is request-time FILTERING: :meth:`for_indicator` returns
the providers that (a) handle the indicator's :class:`IndicatorKind`, (b) are toggled
on by the operator's :class:`app.config.EnrichmentConfig`, and (c) — if key-gated —
have their secret key configured in :class:`app.config.Secrets`. The dispatcher then
calls only those.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ..constants import IndicatorKind
from ..plugins.registry import EntryPointRegistry
from .base import EnrichmentProvider, ProviderManifest
from .providers import BUILTIN_PROVIDERS

if TYPE_CHECKING:
    from ..config import EnrichmentConfig, Secrets

logger = logging.getLogger("tlsoc.enrichment.registry")

ENTRY_POINT_GROUP = "tlsoc.enrichers"


def _provider_key(cls: type[EnrichmentProvider]) -> str | None:
    """The registry key for a provider class (its declared ``name``)."""
    return getattr(cls, "name", None)


class ProviderRegistry:
    """A registry of :class:`EnrichmentProvider` classes, keyed by provider name.

    Round 5 (Coupling-F): the ``name -> class`` map, ``register`` precedence log,
    ``get`` + entry-point discovery are the shared
    :class:`app.plugins.registry.EntryPointRegistry`; this class keeps the request-time
    ``for_indicator`` FILTER (the whole point of the enrichment registry) + name-keyed
    manifest listing on top. Behaviour is byte-identical.
    """

    def __init__(self) -> None:
        self._reg: EntryPointRegistry[str, type[EnrichmentProvider]] = EntryPointRegistry(
            ENTRY_POINT_GROUP, _provider_key, what="enrichment provider", log=logger,
        )

    # Live view of the generic's store so any caller reaching ``registry._classes``
    # keeps working byte-identically (mirrors the connector registry).
    @property
    def _classes(self) -> dict[str, type[EnrichmentProvider]]:
        return self._reg._items  # noqa: SLF001 — same package, deliberate live view

    def register(self, cls: type[EnrichmentProvider]) -> None:
        self._reg.register(cls)

    def get(self, name: str) -> type[EnrichmentProvider] | None:
        return self._reg.get(name)

    def names(self) -> list[str]:
        return sorted(self._classes.keys())

    def classes(self) -> list[type[EnrichmentProvider]]:
        return list(self._classes.values())

    def manifest(self, name: str) -> ProviderManifest | None:
        cls = self._classes.get(name)
        if cls is None:
            return None
        try:
            return cls.manifest()
        except Exception as exc:  # noqa: BLE001 — one bad provider must not break listing
            logger.warning("manifest() failed for %s: %s", cls, exc)
            return None

    def manifests(self) -> list[ProviderManifest]:
        """Every provider's manifest, sorted for stable UI display."""
        out: list[ProviderManifest] = self._reg.iter_manifests(  # type: ignore[assignment]
            lambda cls: cls.manifest(),
        )
        out.sort(key=lambda m: (m.display_name or m.name))
        return out

    # --- the filter the dispatcher relies on ------------------------------- #
    def for_indicator(
        self,
        kind: IndicatorKind,
        cfg: "EnrichmentConfig",
        secrets: "Secrets",
    ) -> list[type[EnrichmentProvider]]:
        """The provider CLASSES that should run for ``kind`` given the operator's
        config + secrets: handles the kind AND toggled on AND (if key-gated) keyed.

        Master ``cfg.enabled`` off ⇒ no providers (enrichment globally disabled)."""
        if not getattr(cfg, "enabled", True):
            return []
        out: list[type[EnrichmentProvider]] = []
        for cls in self._classes.values():
            try:
                if not cls.handles(kind):
                    continue
                if not cls.enabled_by_config(cfg):
                    continue
                if not cls.key_present(secrets):
                    continue
                out.append(cls)
            except Exception as exc:  # noqa: BLE001 — a bad provider never breaks the filter
                logger.warning("filter check failed for %s: %s", cls, exc)
        # Stable order so dispatch + aggregation are deterministic.
        out.sort(key=lambda c: getattr(c, "name", ""))
        return out

    def instances_for_indicator(
        self,
        kind: IndicatorKind,
        cfg: "EnrichmentConfig",
        secrets: "Secrets",
    ) -> list[EnrichmentProvider]:
        """Construct the enabled, capable providers for ``kind`` (ready to call)."""
        out: list[EnrichmentProvider] = []
        for cls in self.for_indicator(kind, cfg, secrets):
            try:
                out.append(cls(cfg, secrets))
            except Exception as exc:  # noqa: BLE001 — a bad ctor never breaks dispatch
                logger.warning("could not construct provider %s: %s", cls, exc)
        return out


def _load_entry_point_providers(reg: ProviderRegistry) -> None:
    """Discover out-of-tree providers registered under ``tlsoc.enrichers``."""
    reg._reg.discover()  # noqa: SLF001 — same package; discovery is isolated + warned


def _build_default_registry() -> ProviderRegistry:
    reg = ProviderRegistry()
    for cls in BUILTIN_PROVIDERS:
        reg.register(cls)
    _load_entry_point_providers(reg)
    return reg


_registry: ProviderRegistry | None = None


def get_provider_registry() -> ProviderRegistry:
    """The process-wide enrichment-provider registry (built once, lazily)."""
    global _registry
    if _registry is None:
        _registry = _build_default_registry()
    return _registry


__all__ = ["ProviderRegistry", "get_provider_registry", "ENTRY_POINT_GROUP"]
