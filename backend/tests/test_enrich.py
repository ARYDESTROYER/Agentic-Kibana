"""Tests for the IP enrichment tool. Fully offline — no provider keys, no network."""

from __future__ import annotations

from app.cache import Cache
from app.config import Preferences, Secrets
from app.tools.enrich import EnrichTool


def _keyless_secrets() -> Secrets:
    # Explicitly clear provider keys so the test never depends on the environment
    # and never makes a network call. ``_env_file=None`` also skips any .env file.
    return Secrets(
        _env_file=None,  # type: ignore[call-arg]
        abuseipdb_api_key=None,
        virustotal_api_key=None,
    )


def _tool(secrets: Secrets | None = None, prefs: Preferences | None = None) -> EnrichTool:
    # A keyless Secrets + a Cache with no redis_url uses the in-memory fallback.
    return EnrichTool(
        secrets or _keyless_secrets(),
        prefs or Preferences(),
        Cache(),
    )


async def test_private_ip_short_circuits() -> None:
    tool = _tool()
    result = await tool.enrich_ip("10.0.0.5")
    assert result.ip == "10.0.0.5"
    assert result.reputation_score == 0
    assert result.is_malicious is False
    assert "skipped" in result.sources.get("note", "")
    assert result.error is None


async def test_loopback_and_invalid_skip() -> None:
    tool = _tool()
    for ip in ("127.0.0.1", "not-an-ip", "999.999.999.999", ""):
        result = await tool.enrich_ip(ip)
        assert result.reputation_score == 0
        assert result.is_malicious is False
        assert "skipped" in result.sources.get("note", "")


async def test_no_keys_neutral_and_run_returns_dict() -> None:
    tool = _tool()  # public IP, but no provider keys configured
    result = await tool.enrich_ip("8.8.8.8")
    assert result.reputation_score == 0
    assert result.is_malicious is False
    assert result.error is None

    tool_result = await tool.run(ip="8.8.8.8")
    assert tool_result.ok is True
    assert isinstance(tool_result.data, dict)
    assert tool_result.data["ip"] == "8.8.8.8"


async def test_disabled_returns_neutral() -> None:
    prefs = Preferences()
    prefs.enrichment.enabled = False
    tool = _tool(prefs=prefs)
    result = await tool.enrich_ip("8.8.8.8")
    assert result.reputation_score == 0
    assert result.sources.get("note") == "disabled"


async def test_second_call_is_cached() -> None:
    # Pre-seed the cache so the second read is served from it with cached=True.
    cache = Cache()
    tool = EnrichTool(_keyless_secrets(), Preferences(), cache)

    # First call (keyless, public IP) yields a non-error result and is cached.
    first = await tool.enrich_ip("8.8.8.8")
    assert first.cached is False
    assert first.error is None

    second = await tool.enrich_ip("8.8.8.8")
    assert second.cached is True
    assert second.reputation_score == first.reputation_score
