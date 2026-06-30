"""IPinfo Lite geolocation/ASN enrichment provider (Round 3 Wave 2) — KEYLESS-capable.

IPinfo's free ``ipinfo.io/{ip}/json`` returns city/region/country/org/ASN context. It
is GEO/OWNERSHIP context, NOT a reputation verdict, so the score is ALWAYS 0 (it never
moves the legacy ``max()`` reputation). It runs keyless on the free anonymous tier; an
optional ``Secrets.ipinfo_token`` raises the rate limit but is not required (so the
manifest stays keyless / default-on). Every org/city/country string is UNTRUSTED and
fenced before a prompt (#9).
"""

from __future__ import annotations

from ...constants import IndicatorKind
from ...models import ProviderResult
from ...utils import now_utc
from ..base import EnrichmentProvider, ProviderManifest
from ._common import http_json_soft

_URL = "https://ipinfo.io/{ip}/json"


class IPInfoProvider(EnrichmentProvider):
    name = "ipinfo"

    @classmethod
    def manifest(cls) -> ProviderManifest:
        return ProviderManifest(
            name=cls.name,
            display_name="IPinfo Lite",
            description=(
                "Geolocation / ASN / org ownership context. Geo context only — never a "
                "reputation verdict (score is always 0). Keyless on the free tier."
            ),
            indicator_kinds=[IndicatorKind.IP],
            config_key="use_ipinfo",
            secret_fields=[],          # optional token raises rate limit; not required
            keyless=True,
            free_tier="Keyless free tier (~50k/mo); optional token raises the limit",
            docs_url="https://ipinfo.io/developers",
            default_enabled=True,
        )

    async def _lookup(self, value: str, kind: IndicatorKind) -> ProviderResult:
        token = self._secret("ipinfo_token")
        params = {"token": token} if token else None
        # Advisory geo context — a tight timeout so a slow/unreachable host degrades fast.
        data = await http_json_soft(_URL.format(ip=value), params=params, timeout=4.0)
        data = data if isinstance(data, dict) else {}
        country = data.get("country") or None
        org = data.get("org") or None
        tags: list[str] = []
        if country:
            tags.append(f"country:{country}")
        if data.get("hostname"):
            tags.append(str(data["hostname"]))
        return ProviderResult(
            provider=self.name, indicator=value, indicator_kind=kind.value,
            # GEO/OWNERSHIP CONTEXT ONLY — never a maliciousness signal.
            score=0, malicious=False, confidence=0.2,
            tags=tags,
            raw={
                "country": country,
                "countryCode": country,
                "city": data.get("city"),
                "region": data.get("region"),
                "org": org,
                "hostname": data.get("hostname"),
                "loc": data.get("loc"),
                "timezone": data.get("timezone"),
            },
            ok=True, ts=now_utc(),
        )
