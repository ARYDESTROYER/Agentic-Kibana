"""IP enrichment tool (Section 6.5 / Non-negotiable #8).

Resolves an IP's reputation against external threat-intel providers (AbuseIPDB,
VirusTotal) with a Redis-backed cache in front to protect both cost and tight
free-tier API limits. Enrichment NEVER breaks an investigation: every provider
or network failure is caught, logged and turned into a best-effort, neutral
result, so a flaky third party can degrade the signal but never crash the engine.

The reusable core is ``enrich_ip`` — the deterministic risk scorer calls it
directly; ``run`` is the thin MCP-shaped wrapper around it.
"""

from __future__ import annotations

import ipaddress
import logging
from typing import Any

import httpx

from ..cache import Cache
from ..config import Preferences, Secrets
from ..models import EnrichmentResult
from .base import Tool, ToolResult

logger = logging.getLogger("tlsoc.tools.enrich")

_TIMEOUT = 8.0
_ABUSEIPDB_URL = "https://api.abuseipdb.com/api/v2/check"
_VIRUSTOTAL_URL = "https://www.virustotal.com/api/v3/ip_addresses"


class EnrichTool(Tool):
    name = "enrich"
    description = (
        "Look up the reputation of an external IP address against threat-intel "
        "providers (AbuseIPDB, VirusTotal). Returns a 0-100 reputation score, a "
        "malicious flag and the originating country. Private/invalid IPs are "
        "skipped. Results are cached to respect free-tier limits."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "ip": {"type": "string", "description": "the IP address to enrich"},
        },
        "required": ["ip"],
        "additionalProperties": False,
    }

    def __init__(self, secrets: Secrets, prefs: Preferences, cache: Cache) -> None:
        self._secrets = secrets
        self._prefs = prefs
        self._cache = cache

    # ----- reusable core (the risk scorer calls this directly) -----
    async def enrich_ip(self, ip: str) -> EnrichmentResult:
        """Resolve reputation for ``ip``. Never raises — always returns a result."""
        cfg = self._prefs.enrichment

        # 1) Validate / skip private, loopback, reserved or invalid addresses.
        if not _is_public_ip(ip):
            return EnrichmentResult(
                ip=ip,
                reputation_score=0,
                is_malicious=False,
                sources={"note": "private/invalid; skipped"},
            )

        # 2) Enrichment disabled by preference — neutral result, no providers.
        if not cfg.enabled:
            return EnrichmentResult(
                ip=ip,
                reputation_score=0,
                is_malicious=False,
                sources={"note": "disabled"},
            )

        # 3) Cache hit returns the stored result flagged as cached.
        cache_key = f"enrich:{ip}"
        try:
            cached = await self._cache.get_json(cache_key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("enrich cache read failed for %s: %s", ip, exc)
            cached = None
        if cached:
            result = EnrichmentResult.model_validate(cached)
            result.cached = True
            return result

        # 4) Query the enabled providers; best-effort, never raises.
        sources: dict[str, Any] = {}
        country: str | None = None
        scores: list[float] = []
        error: str | None = None

        abuse_score, abuse_country, abuse_err = await self._query_abuseipdb(ip, cfg)
        if abuse_score is not None:
            sources["abuseipdb"] = abuse_score
            scores.append(abuse_score)
        if abuse_country and cfg.use_geoip:
            country = abuse_country
        if abuse_err:
            sources["abuseipdb_error"] = abuse_err
            error = abuse_err

        vt_score, vt_country, vt_err = await self._query_virustotal(ip, cfg)
        if vt_score is not None:
            sources["virustotal"] = vt_score
            scores.append(vt_score)
        if vt_country and cfg.use_geoip and country is None:
            country = vt_country
        if vt_err:
            sources["virustotal_error"] = vt_err
            error = vt_err

        reputation_score = max(scores) if scores else 0.0
        reputation_score = max(0.0, min(100.0, reputation_score))
        result = EnrichmentResult(
            ip=ip,
            reputation_score=reputation_score,
            is_malicious=reputation_score >= 50,
            country=country,
            sources=sources,
            error=error,
        )

        # 5) Cache only successful (non-error) results.
        if error is None:
            try:
                await self._cache.set_json(cache_key, result.model_dump(mode="json"), cfg.cache_ttl_seconds)
            except Exception as exc:  # noqa: BLE001
                logger.warning("enrich cache write failed for %s: %s", ip, exc)

        return result

    # ----- MCP-shaped wrapper -----
    async def run(self, ip: str = "", **kwargs: Any) -> ToolResult:
        result = await self.enrich_ip(ip)
        verdict = "malicious" if result.is_malicious else "clean"
        summary = (
            f"{result.ip}: reputation {result.reputation_score:.0f}/100 ({verdict})"
            + (f", country {result.country}" if result.country else "")
            + (" [cached]" if result.cached else "")
        )
        return ToolResult(
            ok=result.error is None,
            summary=summary,
            data=result.model_dump(),
            error=result.error,
            meta={"ip": result.ip, "cached": result.cached},
        )

    # ----- providers (each fully isolated; returns (score, country, error)) -----
    async def _query_abuseipdb(
        self, ip: str, cfg: Any
    ) -> tuple[float | None, str | None, str | None]:
        key = self._secrets.abuseipdb_api_key
        if not (cfg.use_abuseipdb and key):
            return None, None, None
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.get(
                    _ABUSEIPDB_URL,
                    params={"ipAddress": ip, "maxAgeInDays": 90},
                    headers={"Key": key, "Accept": "application/json"},
                )
                resp.raise_for_status()
                data = resp.json().get("data", {}) or {}
            confidence = float(data.get("abuseConfidenceScore", 0) or 0)
            country = data.get("countryCode") or None
            return confidence, country, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("AbuseIPDB lookup failed for %s: %s", ip, exc)
            return None, None, f"abuseipdb: {exc}"

    async def _query_virustotal(
        self, ip: str, cfg: Any
    ) -> tuple[float | None, str | None, str | None]:
        key = self._secrets.virustotal_api_key
        if not (cfg.use_virustotal and key):
            return None, None, None
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.get(
                    f"{_VIRUSTOTAL_URL}/{ip}",
                    headers={"x-apikey": key, "Accept": "application/json"},
                )
                resp.raise_for_status()
                attributes = (resp.json().get("data", {}) or {}).get("attributes", {}) or {}
            stats = attributes.get("last_analysis_stats", {}) or {}
            malicious = float(stats.get("malicious", 0) or 0)
            total = float(sum(float(v or 0) for v in stats.values())) if stats else 0.0
            ratio = (malicious / total * 100.0) if total > 0 else 0.0
            country = attributes.get("country") or None
            return ratio, country, None
        except Exception as exc:  # noqa: BLE001
            logger.warning("VirusTotal lookup failed for %s: %s", ip, exc)
            return None, None, f"virustotal: {exc}"


def _is_public_ip(ip: str) -> bool:
    """True only for syntactically valid, globally routable addresses."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return not (
        addr.is_private
        or addr.is_loopback
        or addr.is_reserved
        or addr.is_link_local
        or addr.is_multicast
        or addr.is_unspecified
    )
