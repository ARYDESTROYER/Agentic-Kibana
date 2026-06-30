"""Built-in enrichment providers (Round 3).

Wave 1 ships the two providers that the legacy ``EnrichTool`` already had —
AbuseIPDB + VirusTotal — refactored behind the :class:`EnrichmentProvider` SPI with
their scoring semantics kept byte-identical so the deterministic risk scorer and the
existing tests are unchanged. The remaining ~10 providers (GreyNoise, Shodan, OTX,
URLhaus, ThreatFox, MalwareBazaar, RDAP, …) land in Wave 2 under this same package.

The registry imports :data:`BUILTIN_PROVIDERS` to discover them; third-party
providers register out-of-tree via the ``tlsoc.enrichers`` entry-point group.
"""

from __future__ import annotations

from ..base import EnrichmentProvider
from .abuseipdb import AbuseIPDBProvider
from .virustotal import VirusTotalProvider

BUILTIN_PROVIDERS: list[type[EnrichmentProvider]] = [
    AbuseIPDBProvider,
    VirusTotalProvider,
]

__all__ = ["BUILTIN_PROVIDERS", "AbuseIPDBProvider", "VirusTotalProvider"]
