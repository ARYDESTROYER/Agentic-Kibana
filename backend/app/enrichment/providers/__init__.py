"""Built-in enrichment providers (Round 3).

Wave 1 shipped the two providers the legacy ``EnrichTool`` already had — AbuseIPDB +
VirusTotal — refactored behind the :class:`EnrichmentProvider` SPI with byte-identical
scoring. Wave 2 adds ~14 more across IPs, domains, URLs, file hashes and emails. Every
provider is FAIL-OPEN, Redis-cached (by the dispatcher), per-provider timed-out, and
only fires when its ``EnrichmentConfig.use_*`` toggle is on AND (if key-gated) its
``Secrets`` key is set. The KEYLESS providers (shodan_internetdb / ipinfo / urlhaus /
threatfox / malwarebazaar / rdap) default ON; every key-gated provider defaults OFF.

The registry imports :data:`BUILTIN_PROVIDERS` to discover them; third-party providers
register out-of-tree via the ``tlsoc.enrichers`` entry-point group.

Round 3 Wave 2b lands the config gaps :class:`ProjectHoneypotProvider` waited on — the
``EnrichmentConfig.use_honeypot`` toggle + the ``Secrets.honeypot_access_key`` field —
so it is now REGISTERED below. It stays key-gated + default-OFF: it only fires when the
operator both enables ``use_honeypot`` AND configures the access key.
"""

from __future__ import annotations

from ..base import EnrichmentProvider
from .abuseipdb import AbuseIPDBProvider
from .abusech import MalwareBazaarProvider, ThreatFoxProvider, URLhausProvider
from .binaryedge import BinaryEdgeProvider
from .censys import CensysProvider
from .greynoise import GreyNoiseProvider
from .hibp import HIBPProvider
from .ipinfo import IPInfoProvider
from .otx import OTXProvider
from .projecthoneypot import ProjectHoneypotProvider  # implemented, pending config
from .pulsedive import PulsediveProvider
from .rdap import RDAPProvider
from .shodan import ShodanProvider
from .shodan_internetdb import ShodanInternetDBProvider
from .spur import SpurProvider
from .urlscan import URLScanProvider
from .virustotal import VirusTotalProvider
from .xforce import XForceProvider

BUILTIN_PROVIDERS: list[type[EnrichmentProvider]] = [
    # IP reputation / exposure / context
    AbuseIPDBProvider,
    VirusTotalProvider,
    GreyNoiseProvider,
    ShodanInternetDBProvider,
    ShodanProvider,
    CensysProvider,
    BinaryEdgeProvider,
    IPInfoProvider,
    OTXProvider,
    PulsediveProvider,
    SpurProvider,
    XForceProvider,
    # multi-indicator / domain / url / hash / email
    URLhausProvider,
    ThreatFoxProvider,
    MalwareBazaarProvider,
    RDAPProvider,
    URLScanProvider,
    HIBPProvider,
    # Key-gated, default-OFF (use_honeypot + honeypot_access_key). Registered in Wave 2b.
    ProjectHoneypotProvider,
]

__all__ = [
    "BUILTIN_PROVIDERS",
    "AbuseIPDBProvider",
    "VirusTotalProvider",
    "GreyNoiseProvider",
    "ShodanInternetDBProvider",
    "ShodanProvider",
    "CensysProvider",
    "BinaryEdgeProvider",
    "IPInfoProvider",
    "OTXProvider",
    "PulsediveProvider",
    "SpurProvider",
    "XForceProvider",
    "URLhausProvider",
    "ThreatFoxProvider",
    "MalwareBazaarProvider",
    "RDAPProvider",
    "URLScanProvider",
    "HIBPProvider",
    "ProjectHoneypotProvider",
]
