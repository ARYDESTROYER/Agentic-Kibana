"""Round 4 · Wave 3 — daily CAMPAIGN correlation (deterministic, $0, advisory).

Verifies the three hard rails of the cross-case campaign pass:

* 3 cases sharing an IP fold into ONE campaign referencing all 3 (a solitary,
  unrelated case forms NO campaign).
* the pass is IDEMPOTENT — re-running yields the SAME campaign id + content.
* a NEEDS_HUMAN case can JOIN a campaign and its status is unchanged (#3), and no
  member case's ``cluster_signature`` is ever recomputed/mutated (#4).
* the module imports neither ``case_manager`` nor calls ``decide()``.

Plus the CampaignStore round-trip (upsert idempotency, list/get/delete) over an
in-memory KV fake (network-free).
"""

from __future__ import annotations

import asyncio
import inspect
from datetime import datetime, timedelta, timezone

import pytest

from app.config import CampaignConfig, CrossSourceCorrelationConfig, Preferences
from app.constants import CaseStatus, EntityType, SourceSurface, Verdict
from app.engine import campaigns as campaigns_engine
from app.engine.campaigns import build_campaigns, correlate_campaigns
from app.engine.signatures import cluster_signature
from app.models import Campaign, Case, Entity
from app.stores.campaigns import CampaignStore

# A RECENT default timestamp (relative to now, not a hardcoded calendar day) so the
# store-backed pass's trailing daily window (`_read_recent_cases`, 24h) always sees the
# fixture cases as "today's cases". A fixed date here is a time-bomb: once real time
# moves past the window, the store-read tests wrongly see zero recent cases.
_RECENT_TS = (datetime.now(timezone.utc) - timedelta(hours=2)).replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------- #
# Fakes (network-free): an in-memory KV + a paging cases store.
# --------------------------------------------------------------------------- #
class _FakeKV:
    def __init__(self) -> None:
        self.store: dict[tuple[str, str], dict] = {}

    async def get(self, ns, key):
        return self.store.get((ns, key))

    async def put(self, ns, key, value):
        self.store[(ns, key)] = value


class _FakeCaseStore:
    """A minimal cases store exposing the paged ``list`` the engine uses."""

    def __init__(self, cases: list[Case]) -> None:
        self._cases = list(cases)

    async def list(self, *, limit=50, offset=0, sort_field="created_at", sort_order="desc", **_kw):
        rows = sorted(self._cases, key=lambda c: c.created_at, reverse=(sort_order == "desc"))
        total = len(rows)
        page = rows[offset: offset + limit] if limit else rows[offset:]
        return page, total


def _mk_case(
    case_id: str,
    *,
    ip: str | None = None,
    mitre: list[str] | None = None,
    status: CaseStatus = CaseStatus.OPEN,
    verdict: Verdict | None = None,
    ts: str = _RECENT_TS,
    severity_band: str | None = None,
) -> Case:
    entity = Entity(type=EntityType.IP, value=ip or "0.0.0.0")
    return Case(
        case_id=case_id,
        cluster_signature=cluster_signature(EntityType.IP, ip or "0.0.0.0"),
        created_at=ts,
        updated_at=ts,
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=entity,
        mitre=list(mitre or []),
        status=status,
        verdict=verdict,
        severity_band=severity_band,
    )


def _prefs() -> Preferences:
    # Campaign enabled, daily; entity binding falls back to the daily default since
    # cross-source correlation is off.
    return Preferences(campaign=CampaignConfig(enabled=True, cadence="daily"))


# --------------------------------------------------------------------------- #
# Core clustering: 3 cases sharing an IP → one campaign; a loner → none.
# --------------------------------------------------------------------------- #
def test_three_cases_sharing_ip_form_one_campaign():
    shared = "203.0.113.5"
    cases = [
        _mk_case("case-a", ip=shared),
        _mk_case("case-b", ip=shared),
        _mk_case("case-c", ip=shared),
        _mk_case("case-lonely", ip="198.51.100.9"),  # unrelated → no campaign
    ]
    result = build_campaigns(cases, _prefs())
    assert len(result) == 1
    camp = result[0]
    assert sorted(camp.case_ids) == ["case-a", "case-b", "case-c"]
    # The binding entity is surfaced.
    assert any(e.entity_type == "ip" and e.value == shared for e in camp.entities)


def test_single_unrelated_case_is_not_a_campaign():
    cases = [_mk_case("solo", ip="10.0.0.1")]
    assert build_campaigns(cases, _prefs()) == []


def test_mitre_only_component_without_shared_entity_is_not_a_campaign():
    # Two cases with DISTINCT IPs (different time bucket-safe) but a shared MITRE
    # technique: connected by MITRE, but no shared ENTITY → NOT a campaign.
    cases = [
        _mk_case("m-1", ip="192.0.2.1", mitre=["T1059"]),
        _mk_case("m-2", ip="192.0.2.2", mitre=["T1059"]),
    ]
    assert build_campaigns(cases, _prefs()) == []


# --------------------------------------------------------------------------- #
# Idempotency: re-running yields the same id + content.
# --------------------------------------------------------------------------- #
def test_pass_is_idempotent():
    shared = "203.0.113.5"
    cases = [_mk_case("case-a", ip=shared), _mk_case("case-b", ip=shared)]
    first = build_campaigns(cases, _prefs())
    second = build_campaigns(list(reversed(cases)), _prefs())  # input order must not matter
    assert len(first) == len(second) == 1
    assert first[0].id == second[0].id
    assert first[0].case_ids == second[0].case_ids
    assert first[0].entities == second[0].entities
    # The id is a stable content hash of the member cluster signatures.
    assert first[0].id.startswith("campaign-")


def test_campaign_id_is_stable_content_hash_of_member_signatures():
    # Identity = hash of the SORTED DISTINCT member cluster_signatures (spec). A
    # different set of member signatures → a different, stable id; the same set (any
    # order) → the same id.
    from app.engine.campaigns import _campaign_id

    a = _campaign_id(["sig-a", "sig-b"])
    b = _campaign_id(["sig-b", "sig-a"])  # order-independent
    c = _campaign_id(["sig-a", "sig-b", "sig-c"])  # different membership
    assert a == b
    assert a != c
    assert a.startswith("campaign-")


# --------------------------------------------------------------------------- #
# #3 — a NEEDS_HUMAN case joins a campaign; its status is UNCHANGED.
# --------------------------------------------------------------------------- #
def test_needs_human_case_joins_campaign_status_unchanged():
    shared = "203.0.113.5"
    nh = _mk_case("case-nh", ip=shared, status=CaseStatus.NEEDS_HUMAN, verdict=None)
    other = _mk_case("case-o", ip=shared, status=CaseStatus.OPEN)
    result = build_campaigns([nh, other], _prefs())
    assert len(result) == 1
    assert "case-nh" in result[0].case_ids
    # The pass returns campaigns only — it NEVER mutates the case.
    assert nh.status == CaseStatus.NEEDS_HUMAN
    assert nh.verdict is None
    # And a campaign never carries a close/escalate decision on a member.
    assert nh.decision_by is None


# --------------------------------------------------------------------------- #
# #4 — member cluster_signatures are never recomputed / altered.
# --------------------------------------------------------------------------- #
def test_member_cluster_signatures_unchanged():
    shared = "203.0.113.5"
    a = _mk_case("case-a", ip=shared)
    b = _mk_case("case-b", ip=shared)
    before = {a.case_id: a.cluster_signature, b.case_id: b.cluster_signature}
    build_campaigns([a, b], _prefs())
    assert a.cluster_signature == before["case-a"]
    assert b.cluster_signature == before["case-b"]
    # The frozen signature is exactly the entity-centric #4 key.
    assert a.cluster_signature == cluster_signature(EntityType.IP, shared)


# --------------------------------------------------------------------------- #
# The module never imports case_manager / calls decide().
# --------------------------------------------------------------------------- #
def test_module_never_imports_case_manager_or_decide():
    # AST-scan the actual CODE (docstrings/comments legitimately NAME the invariant,
    # so a raw substring check on the source would false-positive): assert no import
    # of case_manager and no call to a ``decide`` symbol.
    import ast

    tree = ast.parse(inspect.getsource(campaigns_engine))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                assert "case_manager" not in alias.name
        if isinstance(node, ast.ImportFrom):
            assert "case_manager" not in (node.module or "")
            for alias in node.names:
                assert alias.name != "decide"
                assert "case_manager" not in alias.name
        if isinstance(node, ast.Call):
            fn = node.func
            name = fn.id if isinstance(fn, ast.Name) else (fn.attr if isinstance(fn, ast.Attribute) else "")
            assert name != "decide"
    # No case_manager / decide symbol reachable from the module namespace.
    assert not hasattr(campaigns_engine, "decide")
    assert not hasattr(campaigns_engine, "case_manager")


# --------------------------------------------------------------------------- #
# The store-backed pass: page the read + upsert idempotently.
# --------------------------------------------------------------------------- #
def test_correlate_campaigns_via_store_and_upsert():
    shared = "203.0.113.5"
    cases = [_mk_case("case-a", ip=shared), _mk_case("case-b", ip=shared),
             _mk_case("case-c", ip=shared), _mk_case("loner", ip="198.51.100.1")]
    store = CampaignStore(_FakeKV())
    case_store = _FakeCaseStore(cases)

    async def go():
        # 1) explicit snapshot
        camps = await correlate_campaigns(cases, _prefs())
        assert len(camps) == 1
        await store.upsert_many(camps)
        # 2) paged read from the store (cutoff window includes today's cases)
        camps2 = await correlate_campaigns(None, _prefs(), case_store)
        assert len(camps2) == 1 and camps2[0].id == camps[0].id
        # Idempotent upsert: re-upserting the same content keeps ONE entry.
        stored = await store.upsert_many(camps2)
        assert len(stored) == 1
        listed, total = await store.list()
        assert total == 1 and listed[0].id == camps[0].id
        # get + delete round-trip.
        got = await store.get(camps[0].id)
        assert got is not None and sorted(got.case_ids) == ["case-a", "case-b", "case-c"]
        assert await store.delete(camps[0].id) is True
        assert (await store.list())[1] == 0

    asyncio.run(go())


def test_store_preserves_created_at_on_update():
    store = CampaignStore(_FakeKV())

    async def go():
        c1 = Campaign(id="campaign-x", case_ids=["a", "b"], created_at="2026-07-01T00:00:00+00:00")
        await store.upsert(c1)
        c2 = Campaign(id="campaign-x", case_ids=["a", "b", "c"], created_at="2026-07-02T00:00:00+00:00")
        saved = await store.upsert(c2)
        # created_at is preserved from the original; case_ids updated.
        assert saved.created_at == "2026-07-01T00:00:00+00:00"
        assert saved.case_ids == ["a", "b", "c"]

    asyncio.run(go())


def test_disabled_campaign_config_still_clusters_snapshot():
    # build_campaigns is a pure aggregator; the enabled toggle gates the SCHEDULE
    # (owned by the caller), not the pure fn. Snapshot clustering still works so a
    # manual/on-demand run is possible. (Zero behaviour change: nothing invokes it
    # until a later wave wires the scheduler behind the default-OFF toggle.)
    shared = "203.0.113.5"
    prefs = Preferences(campaign=CampaignConfig(enabled=False))
    result = build_campaigns([_mk_case("a", ip=shared), _mk_case("b", ip=shared)], prefs)
    assert len(result) == 1
