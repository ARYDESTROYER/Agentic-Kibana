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

NOTE: :class:`ProjectHoneypotProvider` is implemented + tested but NOT registered here —
it needs a Wave-0 config toggle (``use_honeypot``) + a ``Secrets.honeypot_access_key``
that the frozen config does not yet expose. It registers with a one-line change once
those land.
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
    # ProjectHoneypotProvider intentionally NOT registered — pending Wave-0 config.
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
