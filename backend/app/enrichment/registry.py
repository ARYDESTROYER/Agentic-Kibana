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

import importlib.metadata as importlib_metadata
import logging
from typing import TYPE_CHECKING

from ..constants import IndicatorKind
from .base import EnrichmentProvider, ProviderManifest
from .providers import BUILTIN_PROVIDERS

if TYPE_CHECKING:
    from ..config import EnrichmentConfig, Secrets

logger = logging.getLogger("tlsoc.enrichment.registry")

ENTRY_POINT_GROUP = "tlsoc.enrichers"


class ProviderRegistry:
    """A registry of :class:`EnrichmentProvider` classes, keyed by provider name."""

    def __init__(self) -> None:
        self._classes: dict[str, type[EnrichmentProvider]] = {}

    def register(self, cls: type[EnrichmentProvider]) -> None:
        name = getattr(cls, "name", None)
        if not name:
            logger.warning("Enrichment provider %s has no name; skipping", cls)
            return
        if name in self._classes and self._classes[name] is not cls:
            logger.info("Enrichment provider '%s' overridden by %s", name, cls.__name__)
        self._classes[name] = cls

    def get(self, name: str) -> type[EnrichmentProvider] | None:
        return self._classes.get(name)

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
        out: list[ProviderManifest] = []
        for cls in self._classes.values():
            try:
                out.append(cls.manifest())
            except Exception as exc:  # noqa: BLE001 — one bad provider must not break listing
                logger.warning("manifest() failed for %s: %s", cls, exc)
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
    try:
        eps = importlib_metadata.entry_points(group=ENTRY_POINT_GROUP)
    except Exception as exc:  # noqa: BLE001 — never let discovery break startup
        logger.warning("enrichment entry-point discovery failed: %s", exc)
        return
    for ep in eps:
        try:
            cls = ep.load()
            reg.register(cls)
            logger.info("Loaded enrichment provider '%s' from entry point", ep.name)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not load enricher entry point '%s': %s", ep.name, exc)


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
