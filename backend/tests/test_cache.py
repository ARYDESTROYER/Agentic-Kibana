"""In-memory cache fallback (audit #37) — bounded + expiring."""

from __future__ import annotations

import pytest

from app.cache import Cache


@pytest.mark.asyncio
async def test_mem_fallback_is_lru_bounded(monkeypatch):
    from app import cache as cache_mod

    monkeypatch.setattr(cache_mod, "_MEM_MAX_ENTRIES", 100)
    c = Cache(redis_url=None)  # no redis → in-memory fallback
    for i in range(500):
        await c.set(f"k{i}", str(i), ttl_seconds=3600)
    assert len(c._mem) <= 100, "in-memory cache fallback must be LRU-bounded"
    # The most-recently-set keys are retained; the oldest were evicted.
    assert await c.get("k499") == "499"
    assert await c.get("k0") is None  # evicted


@pytest.mark.asyncio
async def test_mem_fallback_expires():
    c = Cache(redis_url=None)
    await c.set("k", "v", ttl_seconds=0)  # already expired
    assert await c.get("k") is None
