"""Comprehensive-Ingestion overhaul (Batch B1) — routing & cost-bounding tests.

Fully offline (fake ES, MockProvider, no network). Proves the B1 deliverables — the
deterministic RISK GATE for events-role clusters, the alerts-role EVERY correlation
(every SIEM detection becomes exactly one case), the per-tick auto-investigation cap,
push == pull symmetry, the honest candidate stage label, and the #3 fail-safe — WITHOUT
ever touching ``case_manager.decide()`` (asserted by a source-text guard).

Governing decisions (DECISIONS.md / STANDARDS.md):
  * events-role clusters auto-forward when ``risk_score >= auto_investigate_risk_floor``
    (default 70); below-floor stays a $0 candidate (never dropped, #4);
  * alerts-role feeds bypass the gate AND correlate with mode=EVERY so every alert is one
    case; same-signature bursts coalesce onto ONE cluster/case;
  * ``auto_forward_allowlist`` still forwards a listed rule regardless of risk (back-compat);
  * ``caps.max_auto_investigations_per_tick`` bounds per-tick spend; overflow stays candidate;
  * investigations stay SEQUENTIAL (this suite never relies on gather).
"""

from __future__ import annotations

import ast
import inspect

import pytest

from app.config import CorrelationRule, Preferences, SourceInstance
from app.constants import (
    CaseStatus,
    CorrelationMode,
    EntityType,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine import correlation as correlation_mod
from app.engine import ingest as ingest_mod
from app.engine.correlation import correlate
from app.engine.ingest import handle_clusters
from app.models import RawEvent

asyncio = pytest.mark.asyncio

BASE = 1_700_000_000_000


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _threshold(prefs: Preferences, n: int = 3, window: int = 3600) -> Preferences:
    prefs.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=n, window_seconds=window, group_by=EntityType.IP
    )
    return prefs


def _events(ip: str, n: int, *, sev: float = 7.0, rule: str = "r", role: str = "events",
            span_ms: int = 1000, rules: list[str] | None = None) -> list[RawEvent]:
    out: list[RawEvent] = []
    for i in range(n):
        r = (rules[i % len(rules)] if rules else rule)
        out.append(RawEvent(
            id=f"{ip}-{r}-{i}", index="logs", source={}, timestamp_millis=BASE + i * span_ms,
            ip=ip, user="u", host="h", rule=r, rule_name=r, severity=sev,
            index_role=role, source_id="s1", source_name="s1",
        ))
    return out


def _high_risk_prefs(ip: str) -> Preferences:
    """A prefs whose deterministic (reputation-0) risk for ``ip`` hits the 70 ceiling —
    the only way an events-role cluster clears the STANDARDS default floor 70 (reputation
    weight 0.3 caps the enrichment-free score at 70 when every other factor maxes)."""
    p = _threshold(Preferences(), n=3, window=3600)
    p.enrichment.enabled = False
    p.asset_criticality = {ip: 100.0}
    return p


def _high_risk_burst(ip: str, role: str = "events") -> list[RawEvent]:
    # big + fast + diverse → volume/velocity/diversity/asset all saturate.
    return _events(ip, 60, sev=10.0, role=role, span_ms=100,
                   rules=["a", "b", "c", "d", "e"])


# --------------------------------------------------------------------------- #
# 1. Master switch + alerts-role.
# --------------------------------------------------------------------------- #
@asyncio
async def test_master_on_alerts_cluster_is_investigated(app_state):
    """background_scan on (the new default) + an alerts-role cluster → auto-investigated,
    regardless of the empty allowlist + regardless of (low) risk."""
    p = _threshold(app_state.prefs.model_copy(deep=True))
    p.enrichment.enabled = False
    assert p.background_scan_enabled is True          # B2 default
    clusters = correlate(_events("8.8.8.8", 4, sev=3.0, role="alerts"), p)
    assert len(clusters) == 1 and clusters[0].is_alert is True
    stats = await handle_clusters(clusters, p, cases=app_state.cases,
                                  pipeline=app_state.pipeline,
                                  source_surface=SourceSurface.AUTOMATED_SCAN)
    assert stats["investigated"] == 1 and stats["candidates"] == 0


@asyncio
async def test_master_off_investigates_nothing(app_state):
    """Flipping the master switch OFF halts ALL auto-investigation — even alerts-role
    clusters register as $0 candidates (never dropped)."""
    p = _threshold(app_state.prefs.model_copy(deep=True))
    p.background_scan_enabled = False
    clusters = correlate(_events("8.8.8.8", 4, role="alerts"), p)
    stats = await handle_clusters(clusters, p, cases=app_state.cases,
                                  pipeline=app_state.pipeline,
                                  source_surface=SourceSurface.AUTOMATED_SCAN)
    assert stats["investigated"] == 0 and stats["candidates"] == 1


# --------------------------------------------------------------------------- #
# 2. The deterministic events-role RISK GATE.
# --------------------------------------------------------------------------- #
@asyncio
async def test_events_above_floor_is_investigated(app_state):
    """An events-role cluster whose deterministic risk clears the floor auto-forwards —
    the empty allowlist no longer blocks it (comprehensive ingestion)."""
    p = _threshold(app_state.prefs.model_copy(deep=True))
    p.enrichment.enabled = False
    p.auto_forward_allowlist = []                     # empty on purpose
    p.auto_investigate_risk_floor = 20               # normal cluster (~33) clears it
    clusters = correlate(_events("3.3.3.3", 6, sev=7.0, role="events"), p)
    assert clusters[0].is_alert is False
    stats = await handle_clusters(clusters, p, cases=app_state.cases,
                                  pipeline=app_state.pipeline,
                                  source_surface=SourceSurface.AUTOMATED_SCAN)
    assert stats["investigated"] == 1 and stats["candidates"] == 0


@asyncio
async def test_events_below_floor_stays_candidate_not_dropped(app_state):
    """A below-floor events-role cluster is registered as a $0 CANDIDATE — risk-scored,
    visible, never dropped (#4) — with an honest 'awaiting' stage label."""
    p = _threshold(app_state.prefs.model_copy(deep=True))
    p.enrichment.enabled = False
    p.auto_forward_allowlist = []
    p.auto_investigate_risk_floor = 90               # normal cluster (~33) below it
    clusters = correlate(_events("3.3.3.3", 6, sev=7.0, role="events"), p)
    stats = await handle_clusters(clusters, p, cases=app_state.cases,
                                  pipeline=app_state.pipeline,
                                  source_surface=SourceSurface.AUTOMATED_SCAN)
    assert stats["investigated"] == 0 and stats["candidates"] == 1
    cases, total = await app_state.cases.list()
    assert total == 1                                 # NOT dropped
    c = cases[0]
    assert c.verdict is None                          # not yet LLM-reasoned
    assert c.status == CaseStatus.OPEN
    assert c.risk_score > 0                            # risk-scored + visible
    assert "below the auto-investigate floor" in (c.summary or "")


@asyncio
async def test_default_floor_70_maxed_cluster_investigates_normal_stays_candidate(app_state):
    """At the STANDARDS default floor (70): a genuinely high-risk (maxed) events cluster
    forwards; a normal-risk events cluster stays a candidate. No allowlist, no alerts."""
    # maxed → deterministic risk == 70 → forwards at the default floor.
    ph = _high_risk_prefs("4.4.4.4")
    assert ph.auto_investigate_risk_floor == 70 and ph.auto_forward_allowlist == []
    ch = correlate(_high_risk_burst("4.4.4.4"), ph)
    assert ch[0].is_alert is False
    sh = await handle_clusters(ch, ph, cases=app_state.cases, pipeline=app_state.pipeline,
                               source_surface=SourceSurface.AUTOMATED_SCAN)
    assert sh["investigated"] == 1

    # a normal events cluster at the same default floor → candidate.
    pn = _threshold(Preferences(), n=3)
    pn.enrichment.enabled = False
    cn = correlate(_events("9.9.9.9", 6, sev=6.0, role="events"), pn)
    sn = await handle_clusters(cn, pn, cases=app_state.cases, pipeline=app_state.pipeline,
                               source_surface=SourceSurface.AUTOMATED_SCAN)
    assert sn["investigated"] == 0 and sn["candidates"] == 1


@asyncio
async def test_allowlisted_rule_forwards_below_floor(app_state):
    """Back-compat: a rule on the auto_forward_allowlist forwards regardless of risk, even
    with the risk floor set unreachably high."""
    p = _threshold(app_state.prefs.model_copy(deep=True))
    p.enrichment.enabled = False
    p.auto_investigate_risk_floor = 100              # risk gate can never fire
    p.auto_forward_allowlist = ["keepwatch"]
    clusters = correlate(_events("7.7.7.7", 6, sev=4.0, role="events", rule="keepwatch"), p)
    stats = await handle_clusters(clusters, p, cases=app_state.cases,
                                  pipeline=app_state.pipeline,
                                  source_surface=SourceSurface.AUTOMATED_SCAN)
    assert stats["investigated"] == 1 and stats["candidates"] == 0


# --------------------------------------------------------------------------- #
# 3. Alerts-role EVERY correlation — every alert = exactly one case.
# --------------------------------------------------------------------------- #
def test_single_alert_forms_a_cluster_events_do_not():
    """A LONE alerts-role event forms a cluster (EVERY override) even under the default
    n=5 THRESHOLD; a lone events-role event does not (byte-identical to before)."""
    p = Preferences()   # default_correlation THRESHOLD n=5
    assert correlate(_events("1.1.1.1", 1, role="alerts"), p)          # 1 cluster
    assert correlate(_events("2.2.2.2", 1, role="events"), p) == []    # below threshold


def test_alert_burst_is_one_cluster_not_one_per_event():
    """A burst of the SAME alert (same entity) collapses into ONE cluster — one alert
    type = one case that events attach to, never one-per-event (#4)."""
    p = Preferences()
    clusters = correlate(_events("5.5.5.5", 10, role="alerts"), p)
    assert len(clusters) == 1
    assert clusters[0].count == 10 and clusters[0].is_alert is True


@asyncio
async def test_alert_burst_becomes_a_single_case(app_state):
    p = _threshold(app_state.prefs.model_copy(deep=True))
    p.enrichment.enabled = False
    clusters = correlate(_events("5.5.5.5", 10, role="alerts"), p)
    stats = await handle_clusters(clusters, p, cases=app_state.cases,
                                  pipeline=app_state.pipeline,
                                  source_surface=SourceSurface.AUTOMATED_SCAN)
    assert stats["investigated"] == 1
    _cases, total = await app_state.cases.list()
    assert total == 1                                 # ten alerts → one case


def test_explicit_never_rule_still_suppresses_even_for_alerts():
    """An operator's explicit NEVER correlation is the suppression escape hatch — it wins
    even for an alerts-role feed (we never override an explicit NEVER)."""
    p = Preferences()
    p.correlation_rules = {"quiet": CorrelationRule(mode=CorrelationMode.NEVER, n=1,
                                                    window_seconds=60, group_by=EntityType.IP)}
    assert correlate(_events("6.6.6.6", 3, role="alerts", rule="quiet"), p) == []


# --------------------------------------------------------------------------- #
# 4. Per-tick auto-investigation cap.
# --------------------------------------------------------------------------- #
@asyncio
async def test_per_tick_cap_investigates_exactly_cap_rest_stay_candidates(app_state):
    """With more eligible clusters than the cap, EXACTLY cap are investigated and the rest
    stay candidates (deferred, never dropped) to drain over later ticks."""
    p = _threshold(app_state.prefs.model_copy(deep=True))
    p.enrichment.enabled = False
    p.caps.max_auto_investigations_per_tick = 2
    # 3 distinct-entity alerts clusters (all eligible, alerts bypass the risk gate).
    events = (_events("10.0.0.1", 1, role="alerts")
              + _events("10.0.0.2", 1, role="alerts")
              + _events("10.0.0.3", 1, role="alerts"))
    clusters = correlate(events, p)
    assert len(clusters) == 3
    stats = await handle_clusters(clusters, p, cases=app_state.cases,
                                  pipeline=app_state.pipeline,
                                  source_surface=SourceSurface.AUTOMATED_SCAN)
    assert stats["investigated"] == 2                 # exactly the cap
    assert stats["candidates"] == 1                   # overflow deferred
    assert stats["deferred"] == 1
    # The deferred cluster is a real, visible case (never dropped) labelled as deferred.
    cases, total = await app_state.cases.list()
    assert total == 3
    deferred = [c for c in cases if c.verdict is None]
    assert len(deferred) == 1
    assert "deferred" in (deferred[0].summary or "").lower()


@asyncio
async def test_deferred_candidate_drains_on_a_later_tick(app_state):
    """MULTI-TICK regression for the cap-drain bug: a cluster deferred by the per-tick cap
    on tick 1 MUST be investigated on a later tick with cap headroom — it can never be
    stuck attach-only forever.

    Before the fix, ``handle_clusters`` short-circuited ``if existing: attach; continue``
    ahead of the eligibility/cap ladder, so a $0 candidate (verdict=None) re-found on every
    later tick only ever had events attached and was NEVER re-forwarded to investigation —
    the "will drain next tick" label was a lie and overflow ALERT signatures stayed
    permanently un-triaged. This proves the candidate DRAINS, no signature is investigated
    twice, and no cluster is starved."""
    p = _threshold(app_state.prefs.model_copy(deep=True))
    p.enrichment.enabled = False
    p.caps.max_auto_investigations_per_tick = 2

    def _mk_clusters():
        # Three distinct-entity alerts clusters (all eligible — alerts bypass the risk
        # gate). Re-correlated identically each tick, so the SAME three signatures recur
        # (find_open_by_signature re-finds the tick-1 cases).
        events = (_events("10.9.0.1", 1, role="alerts")
                  + _events("10.9.0.2", 1, role="alerts")
                  + _events("10.9.0.3", 1, role="alerts"))
        clusters = correlate(events, p)
        assert len(clusters) == 3
        return clusters

    # --- tick 1: the cap bites — exactly 2 investigated, 1 deferred to a $0 candidate. ---
    s1 = await handle_clusters(_mk_clusters(), p, cases=app_state.cases,
                               pipeline=app_state.pipeline,
                               source_surface=SourceSurface.AUTOMATED_SCAN)
    assert s1["investigated"] == 2
    assert s1["deferred"] == 1 and s1["candidates"] == 1

    cases1, total1 = await app_state.cases.list()
    assert total1 == 3
    deferred = [c for c in cases1 if c.verdict is None]
    assert len(deferred) == 1
    deferred_id = deferred[0].case_id
    deferred_sig = deferred[0].cluster_signature
    decided_ids = {c.case_id for c in cases1 if c.verdict is not None}
    assert len(decided_ids) == 2                          # the two tick-1 investigations

    # --- tick 2: cap headroom is free — the deferred candidate DRAINS to investigation. ---
    s2 = await handle_clusters(_mk_clusters(), p, cases=app_state.cases,
                               pipeline=app_state.pipeline,
                               source_surface=SourceSurface.AUTOMATED_SCAN)
    # EXACTLY the previously-deferred candidate is investigated this tick; the two already-
    # decided cases are attach-only (no re-investigation, no double-spend — P1 stability).
    assert s2["investigated"] == 1
    assert s2["attached"] == 2
    assert s2["deferred"] == 0 and s2["candidates"] == 0

    cases2, total2 = await app_state.cases.list()
    assert total2 == 3                                    # no new / duplicate cases (#4)
    drained = next(c for c in cases2 if c.case_id == deferred_id)
    assert drained.cluster_signature == deferred_sig
    assert drained.verdict is not None                    # it WAS drained (investigated)
    # No cluster is starved: every case has a verdict now (all three triaged).
    assert all(c.verdict is not None for c in cases2)
    # The same signature is never investigated twice: the two tick-1 decisions kept their
    # ids and are still exactly the decided set (they were attached, not re-investigated).
    assert decided_ids == {c.case_id for c in cases2 if c.case_id in decided_ids}


# --------------------------------------------------------------------------- #
# 5. Push == pull symmetry (A6) — the SAME gate ladder for a push source.
# --------------------------------------------------------------------------- #
@asyncio
async def test_push_alerts_source_investigates_single_event(app_state):
    """A PUSH source declared wholesale ``alerts`` correlates EVERY → a single pushed
    detection becomes one investigated case, exactly like an alerts-role PULL feed."""
    p = app_state.prefs.model_copy(deep=True)
    p.enrichment.enabled = False
    p.sources = [SourceInstance(id="wh-al", source_type=SourceType.WEBHOOK,
                                config={"role": "alerts"})]
    await app_state.update_prefs(p)
    ev = [RawEvent(id="push-al-1", index="wh", source={}, timestamp_millis=BASE,
                   ip="8.8.4.4", user="u", host="h", rule="siem", rule_name="siem",
                   severity=8.0)]
    stats = await app_state.ingest_service.ingest(ev, app_state.prefs, source_id="wh-al")
    assert stats["received"] == 1
    assert stats["investigated"] == 1 and stats["candidates"] == 0


@asyncio
async def test_push_events_source_hits_the_risk_gate(app_state):
    """A PUSH events source hits the SAME deterministic risk gate as pull: a low-risk
    batch stays a candidate (never dropped)."""
    p = _threshold(app_state.prefs.model_copy(deep=True), n=3)
    p.enrichment.enabled = False
    p.auto_investigate_risk_floor = 90               # low-risk push batch stays candidate
    p.sources = [SourceInstance(id="wh-ev", source_type=SourceType.WEBHOOK, config={})]
    await app_state.update_prefs(p)
    ev = [RawEvent(id=f"push-ev-{i}", index="wh", source={}, timestamp_millis=BASE + i * 1000,
                   ip="12.12.12.12", user="u", host="h", rule="r", rule_name="r", severity=4.0)
          for i in range(5)]
    stats = await app_state.ingest_service.ingest(ev, app_state.prefs, source_id="wh-ev")
    assert stats["candidates"] >= 1 and stats["investigated"] == 0


# --------------------------------------------------------------------------- #
# 6. #3 fail-safe — a forwarded investigation that cannot complete (e.g. budget block →
#    GatewayError) still yields a NEEDS_HUMAN case; it is NEVER dropped, NEVER auto-closed.
#    (Budget enforcement itself is covered by the gateway suite; the MockProvider bypasses
#    the budget block, so we assert the routing→fail-safe integration directly here.)
# --------------------------------------------------------------------------- #
@asyncio
async def test_forwarded_investigation_failure_routes_to_needs_human(app_state, monkeypatch):
    from app.llm.gateway import GatewayError

    p = _threshold(app_state.prefs.model_copy(deep=True))
    p.enrichment.enabled = False

    def _boom(_prefs):
        raise GatewayError("daily budget ceiling exceeded")

    monkeypatch.setattr(app_state.pipeline, "_build_investigator", _boom)
    clusters = correlate(_events("8.8.8.8", 4, role="alerts"), p)
    stats = await handle_clusters(clusters, p, cases=app_state.cases,
                                  pipeline=app_state.pipeline,
                                  source_surface=SourceSurface.AUTOMATED_SCAN)
    assert stats["investigated"] == 1                 # it WAS forwarded
    cases, total = await app_state.cases.list()
    assert total == 1                                 # never dropped
    case = cases[0]
    assert case.verdict == Verdict.NEEDS_HUMAN
    assert case.status == CaseStatus.NEEDS_HUMAN      # fail-safe, never auto-closed (#3)


# --------------------------------------------------------------------------- #
# 7. #3 source-text guard — the routing modules never touch the decision core.
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("mod", [correlation_mod, ingest_mod])
def test_routing_modules_never_import_case_manager_or_call_decide(mod):
    tree = ast.parse(inspect.getsource(mod))
    imports: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imports.update(a.name for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = node.module or ""
            imports.add(base)
            imports.update(f"{base}.{a.name}" for a in node.names)
    assert not any("case_manager" in n for n in imports), imports
    call_names = {
        (n.func.id if isinstance(n.func, ast.Name) else n.func.attr)
        for n in ast.walk(tree) if isinstance(n, ast.Call)
        and isinstance(n.func, (ast.Name, ast.Attribute))
    }
    assert "decide" not in call_names
