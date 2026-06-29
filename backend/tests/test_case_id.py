"""Customisable case-ID nomenclature (F7).

Covers template render/validate (allowlist + injection rejection), the per-bucket
sequence increments, period reset buckets, the legacy (disabled) fallback, and the
preview endpoint.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from app.engine.case_id import (
    SequenceStore,
    preview_samples,
    render,
    reset_bucket,
    validate_template,
)


# --- validate_template ---------------------------------------------------------
def test_validate_accepts_allowlisted_placeholders():
    ok, err = validate_template("CASE-{year}-{seq:06d}")
    assert ok and err == ""
    ok, _ = validate_template("{prefix}{sep}{yy}{mm}{dd}-{seq}")
    assert ok


def test_validate_rejects_unknown_placeholder():
    ok, err = validate_template("CASE-{evil}-{seq}")
    assert not ok and "evil" in err


def test_validate_rejects_format_spec_on_non_seq():
    ok, err = validate_template("CASE-{year:06d}")
    assert not ok


def test_validate_rejects_malformed_braces():
    ok, _ = validate_template("CASE-{seq")
    assert not ok
    ok, _ = validate_template("")
    assert not ok


# --- render --------------------------------------------------------------------
def test_render_zero_pads_sequence():
    out = render("CASE-{seq:06d}", {"seq": 1})
    assert out == "CASE-000001"


def test_render_default_template_is_case_xxxx():
    assert render("CASE-{seq:06d}", {"seq": 42}) == "CASE-000042"


def test_render_year_and_source_and_prefix():
    out = render(
        "{prefix}-{year}-{source}-{seq}",
        {"seq": 7, "prefix": "INC", "year": 2026, "source": "Prod Elastic"},
    )
    assert out == "INC-2026-prod-elastic-7"


def test_render_invalid_template_raises():
    with pytest.raises(ValueError):
        render("CASE-{nope}", {"seq": 1})


# --- reset buckets -------------------------------------------------------------
def test_reset_buckets():
    jan = datetime(2026, 1, 15, tzinfo=timezone.utc)
    jun = datetime(2026, 6, 15, tzinfo=timezone.utc)
    assert reset_bucket("none", jan) == "all"
    assert reset_bucket("calendar_year", jun) == "y2026"
    # Fiscal year (April start): June 2026 → FY2027; January 2026 → FY2026.
    assert reset_bucket("fiscal_year", jun) == "fy2027"
    assert reset_bucket("fiscal_year", jan) == "fy2026"
    # Fiscal quarter: June (Apr-Jun) is Q1 of FY2027.
    assert reset_bucket("fiscal_quarter", jun) == "fy2027q1"


# --- SequenceStore (KV read-modify-write) --------------------------------------
class _FakeKV:
    def __init__(self) -> None:
        self.store: dict[tuple[str, str], dict] = {}

    async def get(self, ns, key):
        return self.store.get((ns, key))

    async def put(self, ns, key, value):
        self.store[(ns, key)] = value


def test_sequence_increments_monotonically():
    kv = _FakeKV()
    store = SequenceStore(kv)

    async def go():
        a = await store.next("CASE", "all", start=1)
        b = await store.next("CASE", "all", start=1)
        c = await store.next("CASE", "all", start=1)
        return a, b, c

    assert asyncio.run(go()) == (1, 2, 3)


def test_sequence_respects_seq_start():
    kv = _FakeKV()
    store = SequenceStore(kv)
    assert asyncio.run(store.next("CASE", "all", start=100)) == 100
    assert asyncio.run(store.next("CASE", "all", start=100)) == 101


def test_sequence_buckets_are_independent():
    kv = _FakeKV()
    store = SequenceStore(kv)

    async def go():
        a = await store.next("CASE", "y2026", start=1)
        b = await store.next("CASE", "y2027", start=1)
        return a, b

    # Each bucket has its own counter (period reset → fresh sequence).
    assert asyncio.run(go()) == (1, 1)


# --- preview endpoint helper ---------------------------------------------------
def test_preview_renders_five_consecutive_samples():
    out = preview_samples("CASE-{seq:06d}", prefix="CASE", seq_start=1, count=5)
    assert out["valid"] is True
    assert out["samples"] == [
        "CASE-000001", "CASE-000002", "CASE-000003", "CASE-000004", "CASE-000005",
    ]


def test_preview_reports_invalid_template():
    out = preview_samples("CASE-{bad}", prefix="CASE", seq_start=1)
    assert out["valid"] is False
    assert out["samples"] == []
    assert out["error"]
