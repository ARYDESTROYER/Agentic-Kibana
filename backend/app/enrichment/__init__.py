"""Multi-provider threat-intel ENRICHMENT (Round 3 Wave 1 — the SPI).

Enrichment turns a single observable (an ip / domain / url / file_hash / email /
host) into one or more :class:`app.models.ProviderResult` reputation verdicts by
asking the enabled, capable threat-intel providers. It mirrors the *connector* SPI:

  * :class:`EnrichmentProvider` — the ABC every provider plugs into (a static
    :class:`ProviderManifest` + an async ``lookup`` that FAILS OPEN — it returns a
    ``ProviderResult(ok=False, error=...)`` rather than ever raising).
  * :class:`ProviderRegistry` — built-ins + a ``tlsoc.enrichers`` entry-point group,
    filtered at request time by the operator's ``EnrichmentConfig.use_*`` toggle AND
    (for key-gated providers) by the presence of the provider's secret key.
  * :func:`enrich_indicator` — the dispatcher: routes one observable to every capable
    enabled provider via ``asyncio.gather`` (per-provider timeout, fail-open),
    Redis-cached per ``(provider, value)`` exactly like the legacy enrich cache (#8).
  * :func:`fuse` — collapses ``[ProviderResult]`` into one reputation. DEFAULT is the
    byte-identical legacy ``max(score)`` (so the deterministic risk scorer is
    unchanged, #3); confidence-weighted fusion is implemented but GATED behind
    ``EnrichmentConfig.fusion_enabled`` (default False).

Every provider-returned string (tags, PTR, banner, category, raw blob) is
attacker-influenceable and MUST be fenced as UNTRUSTED before any prompt/UI (#9);
:func:`fence_provider_result` is the helper that does it.

This package is purely ADDITIVE: the legacy 2-provider IP path
(:meth:`app.tools.enrich.EnrichTool.enrich_ip`) now delegates here but returns the
SAME :class:`app.models.EnrichmentResult` shape, so ``engine/risk.py`` +
``engine/threat_context.py`` + the existing enrich tests are unchanged.
"""

from __future__ import annotations

from .aggregate import FusedReputation, fence_provider_result, fuse
from .base import EnrichmentProvider, ProviderManifest, ProviderSecretField
from .dispatch import enrich_indicator
from .registry import ProviderRegistry, get_provider_registry

__all__ = [
    "EnrichmentProvider",
    "ProviderManifest",
    "ProviderSecretField",
    "ProviderRegistry",
    "get_provider_registry",
    "enrich_indicator",
    "fuse",
    "FusedReputation",
    "fence_provider_result",
]
