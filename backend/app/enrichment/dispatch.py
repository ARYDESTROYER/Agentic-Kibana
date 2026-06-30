"""Enrichment dispatcher — fan one indicator out to every capable enabled provider.

:func:`enrich_indicator` is the multi-provider entry point. Given an observable
``(value, kind)`` it:

  1. asks the :class:`app.enrichment.registry.ProviderRegistry` which providers
     handle this kind AND are toggled on AND (if key-gated) have their key — see
     :meth:`ProviderRegistry.for_indicator`;
  2. for each, returns a Redis-cached result if present, else calls the provider
     concurrently via ``asyncio.gather`` with a per-provider timeout (#8);
  3. FAILS OPEN per provider — a timeout / error becomes
     ``ProviderResult(ok=False, error=...)``, never a raised exception, so one flaky
     provider can never break the batch or drop the alert.

The cache key mirrors the legacy ``enrich:<ip>`` scheme but is namespaced per
provider + kind (``enrich:v2:<provider>:<kind>:<value>``) so providers + indicator
kinds never collide and the legacy ``enrich:<ip>`` cache entries are left intact.

Only successful (``ok=True``, non-error) results are cached, matching the legacy
behaviour of never caching an error so a transient failure self-heals.
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from ..constants import IndicatorKind
from ..models import ProviderResult
from .registry import ProviderRegistry, get_provider_registry

if TYPE_CHECKING:
    from ..cache import Cache
    from ..config import EnrichmentConfig, Secrets
    from .base import EnrichmentProvider

logger = logging.getLogger("tlsoc.enrichment.dispatch")

# Per-provider hard timeout. Matches the legacy EnrichTool per-request _TIMEOUT (8s)
# but is applied around the whole provider call so a hung client can never stall the
# gather. A provider that exceeds it fails open with a timeout error.
_PROVIDER_TIMEOUT = 10.0


def _cache_key(provider: str, kind: IndicatorKind, value: str) -> str:
    return f"enrich:v2:{provider}:{kind.value}:{value}"


async def _one_provider(
    provider: "EnrichmentProvider",
    value: str,
    kind: IndicatorKind,
    cache: "Cache | None",
    cfg: "EnrichmentConfig",
) -> ProviderResult:
    """Resolve one provider with cache-read → call → cache-write, fail-open.

    NEVER raises: ``provider.lookup`` already fails open, and the timeout/cache layers
    here catch everything else."""
    key = _cache_key(provider.name, kind, value)
    ttl = int(getattr(cfg, "cache_ttl_seconds", 21600) or 21600)

    # 1) Cache read (best-effort).
    if cache is not None:
        try:
            cached = await cache.get_json(key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("enrich cache read failed for %s: %s", key, exc)
            cached = None
        if cached:
            try:
                result = ProviderResult.model_validate(cached)
                # Mark cache provenance without changing the score contract.
                result.raw = {**(result.raw or {}), "_cached": True}
                return result
            except Exception as exc:  # noqa: BLE001 — a bad cache entry is ignored
                logger.warning("enrich cache decode failed for %s: %s", key, exc)

    # 2) Live call with a hard per-provider timeout (fail-open on timeout).
    try:
        result = await asyncio.wait_for(provider.lookup(value, kind), timeout=_PROVIDER_TIMEOUT)
    except asyncio.TimeoutError:
        logger.warning("%s timed out for %s (%s)", provider.name, value, kind.value)
        return ProviderResult(
            provider=provider.name,
            indicator=value,
            indicator_kind=kind.value,
            ok=False,
            error=f"{provider.name}: timeout",
        )
    except Exception as exc:  # noqa: BLE001 — belt-and-braces; lookup() shouldn't raise
        logger.warning("%s raised for %s: %s", provider.name, value, exc)
        return ProviderResult(
            provider=provider.name,
            indicator=value,
            indicator_kind=kind.value,
            ok=False,
            error=f"{provider.name}: {exc}",
        )

    # 3) Cache only successful results (mirror legacy: never cache an error).
    if cache is not None and result.ok and not result.error:
        try:
            await cache.set_json(key, result.model_dump(mode="json"), ttl)
        except Exception as exc:  # noqa: BLE001
            logger.warning("enrich cache write failed for %s: %s", key, exc)
    return result


async def enrich_indicator(
    value: str,
    kind: IndicatorKind,
    cfg: "EnrichmentConfig",
    secrets: "Secrets",
    cache: "Cache | None" = None,
    *,
    registry: ProviderRegistry | None = None,
) -> list[ProviderResult]:
    """Enrich one observable against every capable, enabled provider.

    Returns one :class:`app.models.ProviderResult` per provider that was actually
    queried (filtered by kind + config toggle + key presence). Returns ``[]`` when
    enrichment is disabled, the value is empty, or no provider is capable/enabled —
    callers treat an empty list as a neutral (clean) signal. NEVER raises."""
    if not value or not str(value).strip():
        return []
    reg = registry or get_provider_registry()
    try:
        providers = reg.instances_for_indicator(kind, cfg, secrets)
    except Exception as exc:  # noqa: BLE001 — a registry error must not drop the alert
        logger.warning("provider selection failed for %s (%s): %s", value, kind.value, exc)
        return []
    if not providers:
        return []

    results = await asyncio.gather(
        *(_one_provider(p, value, kind, cache, cfg) for p in providers),
        return_exceptions=True,
    )
    out: list[ProviderResult] = []
    for p, r in zip(providers, results):
        if isinstance(r, ProviderResult):
            out.append(r)
        else:  # gather caught something unexpected — fail open for that provider
            logger.warning("provider %s dispatch error: %s", p.name, r)
            out.append(
                ProviderResult(
                    provider=p.name,
                    indicator=value,
                    indicator_kind=kind.value,
                    ok=False,
                    error=f"{p.name}: {r}",
                )
            )
    return out


__all__ = ["enrich_indicator"]
