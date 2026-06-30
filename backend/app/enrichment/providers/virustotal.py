"""VirusTotal enrichment provider (Round 3 — refactor of the legacy EnrichTool path).

Scores an IP against VirusTotal's aggregated AV/scanner verdicts. The scoring is kept
BYTE-IDENTICAL to the legacy ``EnrichTool._query_virustotal``: the 0..100 score is
``malicious / total * 100`` over ``last_analysis_stats`` (0 when ``total == 0``); the
country comes from ``attributes.country``. Key-gated (``Secrets.virustotal_api_key``);
Wave 1 handles :class:`IndicatorKind.IP` (the legacy ip_addresses endpoint). Wave 2
extends it to domain/url/file_hash endpoints.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest, ProviderSecretField

logger = logging.getLogger("tlsoc.enrichment.virustotal")

_TIMEOUT = 8.0
_VIRUSTOTAL_IP_URL = "https://www.virustotal.com/api/v3/ip_addresses"


class VirusTotalProvider(EnrichmentProvider):
    name = "virustotal"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="VirusTotal",
            description=(
                "Aggregated AV/scanner verdicts. Score is the malicious-vendor ratio "
                "(0..100). Free public API: ~4 lookups/min, 500/day."
            ),
            # Wave 1: IP only (legacy parity). Wave 2 adds DOMAIN/URL/FILE_HASH.
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_virustotal",
            secret_fields=[
                ProviderSecretField(
                    key="virustotal_api_key",
                    label="VirusTotal API key",
                    required=True,
                    help="Free public API key from your VirusTotal account (API key).",
                    help_link="https://www.virustotal.com/gui/my-apikey",
                ),
            ],
            keyless=False,
            free_tier="~4 lookups/min, 500/day (free public key)",
            docs_url="https://docs.virustotal.com/reference/overview",
            default_enabled=True,
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        key = self._secret("virustotal_api_key")
        if not key:
            return ProviderResult(
                provider=self.name,
                indicator=value,
                indicator_kind=kind.value,
                ok=False,
                error="virustotal: no api key",
            )
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.get(
                f"{_VIRUSTOTAL_IP_URL}/{value}",
                headers={"x-apikey": key, "Accept": "application/json"},
            )
            resp.raise_for_status()
            attributes: dict[str, Any] = (resp.json().get("data", {}) or {}).get("attributes", {}) or {}
        # IDENTICAL semantics to the legacy EnrichTool._query_virustotal.
        stats: dict[str, Any] = attributes.get("last_analysis_stats", {}) or {}
        malicious = float(stats.get("malicious", 0) or 0)
        total = float(sum(float(v or 0) for v in stats.values())) if stats else 0.0
        ratio = (malicious / total * 100.0) if total > 0 else 0.0
        country = attributes.get("country") or None
        score = int(max(0.0, min(100.0, ratio)))
        tags: list[str] = []
        suspicious = float(stats.get("suspicious", 0) or 0)
        if malicious:
            tags.append(f"malicious:{int(malicious)}")
        if suspicious:
            tags.append(f"suspicious:{int(suspicious)}")
        return ProviderResult(
            provider=self.name,
            indicator=value,
            indicator_kind=kind.value,
            score=score,
            malicious=score >= 50,
            # The provider's confidence rises with the number of scanning vendors.
            confidence=min(1.0, total / 70.0) if total else None,
            tags=tags,
            raw={
                "last_analysis_stats": stats,
                "country": country,
                "reputation": attributes.get("reputation"),
                "as_owner": attributes.get("as_owner"),
            },
            ok=True,
            ts=now_utc(),
        )
