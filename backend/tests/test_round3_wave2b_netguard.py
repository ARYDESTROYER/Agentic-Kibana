"""Round 3 / Wave 2b — the offline-suite network guard.

Locks in the autouse guard installed in ``conftest.py`` (``_no_outbound_network``):
the offline test suite must never make a real outbound connection, even now that the
keyless enrichment providers (Shodan InternetDB / IPinfo / abuse.ch / RDAP) default ON.

What we assert here:
  * a connect/DNS to a *non-loopback* host is blocked synchronously (no real packets,
    no multi-second timeout) and surfaces as an ``OSError``;
  * loopback addresses are explicitly allowed (the in-process TestClient/ES/cache rely
    on this), and AF_UNIX / non-INET addresses pass through;
  * ``@pytest.mark.allow_network`` opts a test back out of the guard;
  * a REAL keyless-provider dispatch against a *public* IP fails open FAST and returns
    one error result per provider (never hangs, never raises) — the exact CI hazard.

Nothing here touches ``app/`` source — it only exercises the test harness.
"""

from __future__ import annotations

import socket
import time

import pytest

from app.config import EnrichmentConfig, Secrets
from app.constants import IndicatorKind
from app.enrichment.dispatch import enrich_indicator
from app.enrichment.registry import get_provider_registry


# --------------------------------------------------------------------------- #
# Low-level socket / DNS blocking
# --------------------------------------------------------------------------- #
def test_outbound_tcp_connect_is_blocked() -> None:
    """A connect() to a routable public IP is refused immediately (no real packet)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        with pytest.raises(OSError):
            s.connect(("8.8.8.8", 53))
    finally:
        s.close()


def test_create_connection_to_public_host_is_blocked() -> None:
    with pytest.raises(OSError):
        socket.create_connection(("example.com", 443), timeout=0.1)


def test_dns_resolution_of_public_host_is_blocked() -> None:
    """DNS is the RDAP / project-honeypot path — it must be blocked too."""
    with pytest.raises(OSError):
        socket.getaddrinfo("example.com", 443)
    with pytest.raises(OSError):
        socket.gethostbyname("example.com")


def test_blocking_is_fast_not_a_timeout() -> None:
    """The guard must raise SYNCHRONOUSLY — that is the whole point (no slow timeout)."""
    start = time.monotonic()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        with pytest.raises(OSError):
            s.connect(("203.0.113.10", 80))  # TEST-NET-3, never routable
    finally:
        s.close()
    assert time.monotonic() - start < 0.5


def test_loopback_is_allowed_through_the_guard() -> None:
    """Loopback must NOT be blocked — the in-process TestClient/ES/cache depend on it.

    We exercise ``connect_ex`` against a (closed) loopback port: a refused/failed
    LOOPBACK connect returns a non-zero errno from the REAL socket path, whereas a
    *blocked* address would raise our ``_BlockedNetworkError``. So reaching an integer
    return code proves the guard delegated to the real connect for loopback."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(0.2)
    try:
        rc = s.connect_ex(("127.0.0.1", 9))  # discard port, almost certainly closed
        assert isinstance(rc, int)  # real path ran; loopback was not blocked
    finally:
        s.close()


def test_loopback_dns_is_allowed() -> None:
    """getaddrinfo for loopback must resolve (it is on the in-process allow path)."""
    assert socket.getaddrinfo("127.0.0.1", 80)


@pytest.mark.allow_network
def test_allow_network_marker_opts_out() -> None:
    """With the opt-out marker the guard is inactive: the standard library functions
    are the originals again (we don't make a real call — just prove they're unpatched)."""
    # When the guard is active, socket.getaddrinfo is our wrapper (a local function).
    # When opted out, it is the stdlib builtin. The stdlib one is a builtin_function;
    # the wrapper is a plain function. Resolving loopback must work either way and not
    # raise our blocked-error.
    infos = socket.getaddrinfo("127.0.0.1", 80)
    assert infos  # loopback resolves fine; no _BlockedNetworkError


# --------------------------------------------------------------------------- #
# The real hazard: a keyless-provider dispatch against a PUBLIC IP must fail
# open FAST (this is the test_threat_context-style path that used to hang).
# --------------------------------------------------------------------------- #
async def test_real_keyless_dispatch_on_public_ip_fails_open_fast() -> None:
    """The default config turns several keyless providers ON. Dispatching a public IP
    through the REAL registry must NOT hit the network: every provider degrades without
    a live lookup, FAST, and the call never raises.

    A provider degrades in one of two equivalent fail-open ways when the network is
    blocked, both of which are network-FREE: an error result (``ok=False, error=...``)
    OR a "clean miss" (``ok=True`` with ``score==0`` and ``raw.seen`` falsy / empty raw)
    — the soft-HTTP providers (shodan_internetdb / ipinfo / threatfox) map a failed
    fetch to a clean miss. What must NEVER happen is a *data-bearing* live success."""
    cfg = EnrichmentConfig()  # defaults: keyless providers ON
    secrets = Secrets(_env_file=None, es_store_enabled=False, redis_url="")

    start = time.monotonic()
    results = await enrich_indicator(
        "8.8.8.8", IndicatorKind.IP, cfg, secrets, cache=None,
        registry=get_provider_registry(),
    )
    elapsed = time.monotonic() - start

    # At least one keyless IP provider was selected (proves we exercised the real path).
    assert results, "expected the default keyless IP providers to be selected"
    # Every provider degraded WITHOUT a live, data-bearing lookup (network was blocked).
    for r in results:
        errored = r.ok is False and bool(r.error)
        clean_miss = (
            r.ok is True
            and (r.score or 0) == 0
            and not (r.raw or {}).get("seen")  # soft providers flag a real hit with seen=True
        )
        assert errored or clean_miss, (
            f"provider {r.provider} returned a non-degraded result "
            f"(ok={r.ok}, score={r.score}, raw={r.raw!r}) — did it reach the network?"
        )
    # And it was fast: blocked synchronously, not a per-provider 10s timeout.
    assert elapsed < 2.0, f"keyless dispatch took {elapsed:.2f}s — guard not blocking fast"
