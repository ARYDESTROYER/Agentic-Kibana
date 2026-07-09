"""Overhaul B3 — Coverage Observability (Ask A5, offline).

Proves the "am I seeing everything?" surface added by B3 — all ADDITIVE, advisory, and
byte-identical to ``decide()`` (#3), never calling an LLM (#6), rendering connector error
strings as plain text (#9), and never returning a secret (#10):

* A5.1 — the IN-MEMORY per-source last-tick snapshot on ``Poller`` + ``PollerManager``:
  a healthy source records ``ok:True`` at the end of ``poll_once``; a monkeypatched raising
  connector records ``ok:False`` + a plain-text error on the child, with the healthy source
  unaffected (silent-vs-broken fix);
* A5.2 — the additive ``GET /api/sources/health`` fields (last_poll_at/ok/error/
  events_per_min/last_event_millis/silent) + NO ``secret``/``api_key`` key;
* A5.3 — the ``AuditDoc.source_id`` tag on the poll audit record + ``records(source_id=)``;
* A5.4 — the per-source ``by_source`` dimension on ``NoiseCounterStore`` (sums to the pooled
  total; a pre-migration doc with no ``by_source`` key reads as ``{}`` with byte-identical
  pooled totals);
* A5.5 — the ``GET /api/sources/coverage`` rollup + its cross-consistency with the
  noise-reduction endpoint's ``cases`` stage;
* the ``events_per_min_from_ticks`` pure helper.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.api.routes import sources_coverage, sources_health
from app.api.routes_metrics import metrics_noise_reduction
from app.config import CorrelationRule, SourceInstance
from app.constants import (
    NOISE_KEY,
    NOISE_NS,
    ActionType,
    CorrelationMode,
    EntityType,
    SourceType,
)
from app.engine.noise_counters import events_per_min_from_ticks
from app.state import AppState
from app.stores.noise_counters import NoiseCounterStore, _norm_bucket
from app.utils import now_utc, to_millis
from tests.conftest import make_log_event

asyncio = pytest.mark.asyncio

NOW = datetime(2026, 7, 8, 12, 0, 0, tzinfo=timezone.utc)


# --------------------------------------------------------------------------- #
# helpers (mirror test_round4_wave2_poller_manager)
# --------------------------------------------------------------------------- #
async def _set_threshold(state: AppState, n: int = 3) -> None:
    p = state.prefs.model_copy(deep=True)
    p.default_correlation = CorrelationRule(
        mode=CorrelationMode.THRESHOLD, n=n, window_seconds=3600, group_by=EntityType.IP
    )
    await state.update_prefs(p)


def _source(sid: str, pattern: str, *, primary: bool = False, **cfg) -> SourceInstance:
    return SourceInstance(
        id=sid, source_type=SourceType.ELASTICSEARCH, display_name=sid,
        enabled=True, is_primary=primary,
        config={"data_view_pattern": pattern, **cfg},
    )


def _seed(state: AppState, index: str, ip: str, n: int = 4) -> None:
    base = to_millis(now_utc()) - 60_000
    for i in range(n):
        state.es.add_log(index, make_log_event(ip=ip, ts_millis=base + i * 1000),
                         doc_id=f"{index}-{ip}-{i}")


async def _configure_sources(state: AppState, sources: list[SourceInstance]) -> None:
    prefs = state.prefs.model_copy(deep=True)
    prefs.sources = sources
    await state.update_prefs(prefs)
    state.rebuild_log_source()


# --------------------------------------------------------------------------- #
# events_per_min_from_ticks — the pure rate helper.
# --------------------------------------------------------------------------- #
def test_events_per_min_from_ticks_pure() -> None:
    # <2 samples → an honest 0.0 (not enough signal), never a fabricated rate.
    assert events_per_min_from_ticks([]) == 0.0
    assert events_per_min_from_ticks([(100.0, 5)]) == 0.0
    # 60s span, 10 arrivals AFTER the window-start sample → 10/min.
    assert events_per_min_from_ticks([(0.0, 3), (60.0, 10)]) == 10.0
    # Multi-sample: span 120s, 4+8 arrivals after the first → 12/120*60 = 6.0/min.
    assert events_per_min_from_ticks([(0.0, 99), (60.0, 4), (120.0, 8)]) == 6.0
    # A zero span / a malformed deque degrades to 0.0, never raises.
    assert events_per_min_from_ticks([(50.0, 1), (50.0, 9)]) == 0.0
    assert events_per_min_from_ticks(None) == 0.0


# --------------------------------------------------------------------------- #
# A5.1 — per-source last-tick snapshot (healthy).
# --------------------------------------------------------------------------- #
@asyncio
async def test_per_source_last_tick_snapshot_both_sources(app_state: AppState):
    """Two enabled PULL sources — one seeded, one empty — both record a wall-clock last
    tick with ``ok:True`` after one ``poll_once`` (proves "attempted" ≠ "received")."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "srcA-logs", "10.0.0.1")     # produces events
    # srcB configured but its index is empty → polled, nothing received, still ok.
    await _configure_sources(app_state, [
        _source("srcA", "srcA-logs*", primary=True),
        _source("srcB", "srcB-logs*"),
    ])
    await app_state.poller.poll_once(app_state.prefs)

    snaps = app_state.poller.last_tick_by_source()
    assert {"srcA", "srcB"} <= set(snaps)
    for sid in ("srcA", "srcB"):
        snap = snaps[sid]
        assert snap is not None and snap["ok"] is True and snap["error"] is None
        assert isinstance(snap["ts"], str) and snap["ts"]
        assert "events_per_min" in snap and isinstance(snap["events_per_min"], float)
    # The seeded source genuinely polled MORE events than the empty one.
    assert snaps["srcA"]["stats"]["polled"] >= 4
    assert snaps["srcB"]["stats"]["polled"] == 0


# --------------------------------------------------------------------------- #
# A5.1 — a raising connector records ok:False (silent-vs-broken), isolated.
# --------------------------------------------------------------------------- #
@asyncio
async def test_raising_connector_records_ok_false(app_state: AppState, monkeypatch):
    """A source whose connector ``.poll`` raises records ``ok:False`` + a plain-text error
    on ITS OWN child while the healthy source's snapshot is ``ok:True`` (per-source
    isolation via ``PollerManager._run_one``'s except path)."""
    await _set_threshold(app_state, 3)
    _seed(app_state, "okS-logs", "10.1.0.1")
    await _configure_sources(app_state, [
        _source("okS", "okS-logs*", primary=True),
        _source("badS", "badS-logs*"),
    ])

    # Break badS's connector: its un-fed poll raises out of poll_once → the fan-out
    # except path captures ok:False on the child (never aborting okS).
    bad = next(p for p in app_state.poller._children
               if getattr(p._source, "connector_id", None) == "badS")

    async def _boom(*_a, **_k):
        raise RuntimeError("connector query failed <script>")

    monkeypatch.setattr(bad._source, "poll", _boom)

    stats = await app_state.poller.poll_once(app_state.prefs)
    assert stats["clusters"] >= 1  # the healthy source still produced its cluster

    snaps = app_state.poller.last_tick_by_source()
    assert snaps["okS"] is not None and snaps["okS"]["ok"] is True
    assert snaps["badS"] is not None and snaps["badS"]["ok"] is False
    # The error is captured verbatim (the UI renders it PLAIN, #9 — never as markup).
    assert "connector query failed" in (snaps["badS"]["error"] or "")


# --------------------------------------------------------------------------- #
# A5.1 — single-source fast path also captures ok:False on a raise.
# --------------------------------------------------------------------------- #
@asyncio
async def test_single_source_fast_path_captures_failure(app_state: AppState, monkeypatch):
    await _set_threshold(app_state, 3)
    await _configure_sources(app_state, [_source("solo", "solo-logs*", primary=True)])
    primary = app_state.poller._primary

    async def _boom(*_a, **_k):
        raise RuntimeError("boom")

    monkeypatch.setattr(primary._source, "poll", _boom)
    with pytest.raises(RuntimeError):
        await app_state.poller.poll_once(app_state.prefs)
    # Even on the byte-identical single-poll fast path, the failure is now visible.
    assert primary._last_tick is not None and primary._last_tick["ok"] is False
    assert "boom" in (primary._last_tick["error"] or "")


# --------------------------------------------------------------------------- #
# A5.2 — GET /api/sources/health additive fields + NO secrets.
# --------------------------------------------------------------------------- #
def test_sources_health_new_fields_and_no_secrets(client):
    assert client.post("/api/sources", json={
        "id": "elk-a", "source_type": "elasticsearch", "is_primary": True,
        "config": {"data_view_pattern": "all-logs-*",
                   "es_api_key": "SHOULD-NEVER-LEAK"}}).status_code == 200
    assert client.post("/api/sources", json={
        "id": "wh", "source_type": "webhook"}).status_code == 200

    r = client.get("/api/sources/health")
    assert r.status_code == 200, r.text
    rows = {s["source_id"]: s for s in r.json()["sources"]}
    assert {"elk-a", "wh"} <= set(rows)

    for row in rows.values():
        # The additive coverage-observability fields are present on every row.
        for key in ("last_poll_at", "last_poll_ok", "last_poll_error",
                    "events_per_min", "last_event_millis", "silent"):
            assert key in row, key
        assert isinstance(row["events_per_min"], (int, float))
        assert isinstance(row["silent"], bool)
        # #10 — a health row NEVER carries a secret, even when the source config had one.
        for k in row:
            assert "secret" not in k
            assert "api_key" not in k
        for v in row.values():
            assert v != "SHOULD-NEVER-LEAK"


# --------------------------------------------------------------------------- #
# A5.3 — the poll audit record is tagged with source_id.
# --------------------------------------------------------------------------- #
@asyncio
async def test_poll_audit_is_tagged_with_source_id(app_state: AppState):
    await _set_threshold(app_state, 3)
    _seed(app_state, "aud-logs", "10.2.0.1")
    await _configure_sources(app_state, [_source("audSrc", "aud-logs*", primary=True)])
    await app_state.poller.poll_once(app_state.prefs)

    # The append-only trail now has a per-source poll history (GET /api/audit?source_id=).
    rows = await app_state.audit.records(source_id="audSrc", limit=50)
    assert rows, "expected a source-tagged poll audit row"
    assert any(r.get("action_type") == ActionType.POLL.value
               and r.get("source_id") == "audSrc" for r in rows)
    # A different source_id filter returns none of audSrc's rows.
    other = await app_state.audit.records(source_id="does-not-exist", limit=50)
    assert all(r.get("source_id") != "audSrc" for r in other)


# --------------------------------------------------------------------------- #
# A5.4 — NoiseCounterStore per-source dimension sums to the pooled total.
# --------------------------------------------------------------------------- #
@asyncio
async def test_noise_counter_by_source_sums_to_pooled(app_state: AppState):
    store = NoiseCounterStore(app_state._kv)
    await store.record({"ingested": {"critical": 2}, "clustered": {"critical": 1},
                        "source_id": "sA"}, now=NOW)
    await store.record({"ingested": {"high": 3}, "suppressed": 1, "source_id": "sB"}, now=NOW)

    w = await store.read_window(24, now=NOW)
    # Pooled totals unchanged (byte-identical accounting).
    assert w["ingested"]["critical"] == 2 and w["ingested"]["high"] == 3
    assert w["clustered"]["critical"] == 1 and w["suppressed"] == 1
    # Per-source breakdown present and summing to the pooled total.
    assert set(w["by_source"]) == {"sA", "sB"}
    assert w["by_source"]["sA"]["ingested"]["critical"] == 2
    assert w["by_source"]["sB"]["ingested"]["high"] == 3
    assert w["by_source"]["sB"]["suppressed"] == 1
    pooled = sum(w["ingested"].values())
    per_source = sum(sum(bs["ingested"].values()) for bs in w["by_source"].values())
    assert per_source == pooled == 5


@asyncio
async def test_noise_counter_source_id_none_folds_pooled_only(app_state: AppState):
    """A delta WITHOUT a source_id folds into the pooled totals only (byte-identical) — the
    per-source map stays empty for that contribution."""
    store = NoiseCounterStore(app_state._kv)
    await store.record({"ingested": {"low": 4}}, now=NOW)  # no source_id
    w = await store.read_window(24, now=NOW)
    assert w["ingested"]["low"] == 4       # pooled counted it
    assert w["by_source"] == {}            # ...but nothing attributed


# --------------------------------------------------------------------------- #
# A5.4 — back-compat: a pre-migration bucket (no by_source key) reads as {}.
# --------------------------------------------------------------------------- #
def test_norm_bucket_pre_migration_doc_reads_empty_by_source() -> None:
    # A bucket exactly as the OLD code wrote it — no ``by_source`` key at all.
    nb = _norm_bucket({"ingested": {"high": 4}, "clustered": {"high": 1},
                       "suppressed": 2, "ignored": 1})
    assert nb["ingested"]["high"] == 4 and nb["clustered"]["high"] == 1
    assert nb["suppressed"] == 2 and nb["ignored"] == 1
    assert nb["by_source"] == {}


@asyncio
async def test_read_window_over_pre_migration_kv_doc(app_state: AppState):
    """A whole KV document written before A5.4 (buckets without ``by_source``) still parses,
    yields byte-identical pooled totals, and an empty per-source view."""
    hour = int(NOW.timestamp() // 3600)
    old_doc = {
        "buckets": {str(hour): {
            "ingested": {"critical": 5, "high": 2}, "clustered": {"high": 1},
            "suppressed": 3, "ignored": 1,
        }},
        "since": NOW.isoformat(),
    }
    await app_state._kv.put(NOISE_NS, NOISE_KEY, old_doc)
    store = NoiseCounterStore(app_state._kv)
    w = await store.read_window(24, now=NOW)
    assert w["available"] is True
    assert w["ingested"]["critical"] == 5 and w["ingested"]["high"] == 2
    assert w["clustered"]["high"] == 1 and w["suppressed"] == 3 and w["ignored"] == 1
    assert w["by_source"] == {}


# --------------------------------------------------------------------------- #
# A5.5 — the coverage rollup: silent-source detection.
# --------------------------------------------------------------------------- #
@asyncio
async def test_coverage_flags_a_silent_source(app_state: AppState):
    await _configure_sources(app_state, [_source("quietSrc", "quiet-logs*", primary=True)])
    # Simulate the source having last reported LONG ago (older than k×poll_interval) —
    # the same wall-clock silence clock state.silent_sources() consults.
    app_state._source_last_event["quietSrc"] = datetime.now(timezone.utc) - timedelta(hours=2)

    cov = await sources_coverage(state=app_state, _=None)
    assert cov["sources_total"] == 1
    assert cov["sources_enabled"] == 1
    assert cov["sources_silent"] >= 1
    assert cov["worst_last_event_seconds"] >= 3600
    # It also surfaces on the per-source health row's ``silent`` flag.
    health = await sources_health(state=app_state, _=None)
    row = next(r for r in health["sources"] if r["source_id"] == "quietSrc")
    assert row["silent"] is True


@asyncio
async def test_coverage_disabled_source_excluded(app_state: AppState):
    prefs = app_state.prefs.model_copy(deep=True)
    prefs.sources = [
        _source("onSrc", "on-logs*", primary=True),
        _source("offSrc", "off-logs*"),
    ]
    prefs.sources[1].enabled = False
    await app_state.update_prefs(prefs)
    app_state.rebuild_log_source()

    cov = await sources_coverage(state=app_state, _=None)
    assert cov["sources_total"] == 2
    assert cov["sources_enabled"] == 1  # the disabled source never counts as enabled


# --------------------------------------------------------------------------- #
# A5.5 — coverage.alerts_triaged_24h agrees with the noise-reduction cases stage.
# --------------------------------------------------------------------------- #
@asyncio
async def test_coverage_alerts_triaged_matches_noise_reduction(app_state: AppState):
    await _set_threshold(app_state, 3)
    _seed(app_state, "cs-a-logs", "10.7.0.1")
    _seed(app_state, "cs-b-logs", "10.7.0.2")
    await _configure_sources(app_state, [
        _source("csA", "cs-a-logs*", primary=True),
        _source("csB", "cs-b-logs*"),
    ])
    await app_state.poller.poll_once(app_state.prefs)

    cov = await sources_coverage(state=app_state, _=None)
    noise = await metrics_noise_reduction(window_hours=24, state=app_state, _=None)
    cases_stage = next(s for s in noise["stages"] if s["key"] == "cases")
    # Both compute "cases opened in the last 24h" with the SAME window filter → they agree.
    assert cov["alerts_triaged_24h"] == cases_stage["total"]
    assert cov["alerts_triaged_24h"] >= 2  # two sources each opened a case


# --------------------------------------------------------------------------- #
# B3(1) — a MULTI-FEED source whose EVERY feed raises records ok:False.
#
# Silent-vs-broken blind: the per-feed loop in ``Poller.poll_once`` isolates each feed's
# failure (log + continue), so before the fix ``poll_once`` unconditionally recorded
# ``ok:True`` at the end — a 100%-broken multi-feed source showed as HEALTHY on
# GET /api/sources/health. Only the no-index_patterns legacy path (exception escapes)
# detected failure.
# --------------------------------------------------------------------------- #
@asyncio
async def test_multi_feed_all_feeds_raise_records_ok_false(app_state: AppState, monkeypatch):
    await _set_threshold(app_state, 3)
    await _configure_sources(app_state, [
        _source("multiFeed", "mf-logs*", primary=True,
                index_patterns=[{"pattern": "mf-a-*"}, {"pattern": "mf-b-*"}]),
    ])
    primary = app_state.poller._primary
    # Sanity: this source really took the MULTI-FEED path (explicit index_patterns → >=2 feeds).
    assert len(primary._source_feeds()) >= 2

    async def _boom(*_a, **_k):
        raise RuntimeError("feed scan failed <script>")

    monkeypatch.setattr(primary, "_poll_feed_scan", _boom)

    # The per-feed isolation never aborts the tick, so poll_once RETURNS (does not raise) ...
    await app_state.poller.poll_once(app_state.prefs)
    # ... but the tick is now recorded ok:False with the per-feed error list (rendered PLAIN, #9).
    snap = app_state.poller.last_tick_by_source()["multiFeed"]
    assert snap is not None and snap["ok"] is False
    assert "feed scan failed" in (snap["error"] or "")


# --------------------------------------------------------------------------- #
# B3(2) — every term-filter field in AuditLogger.records() is keyword-mapped.
#
# ``AUDIT_MAPPING`` never mapped ``source_id`` as keyword, so on real ES the default
# dynamic mapping makes it analyzed text → a term query on a hyphenated/dotted/UUID source
# id silently returns ZERO (FakeES masks it with plain equality). This guards the whole
# term-filter set so it cannot recur.
# --------------------------------------------------------------------------- #
def test_audit_records_term_filters_are_keyword_mapped() -> None:
    import inspect
    import re

    from app.audit.audit_log import AuditLogger
    from app.es.indices import AUDIT_MAPPING

    src = inspect.getsource(AuditLogger.records)
    fields = set(re.findall(r'\{"term":\s*\{"([a-z_]+)"', src))
    assert fields, "expected {'term': {...}} filters in AuditLogger.records()"
    assert "source_id" in fields  # the field this regression specifically guards
    props = AUDIT_MAPPING["properties"]
    for f in sorted(fields):
        assert f in props, f"{f} is a records() term-filter but has no AUDIT_MAPPING entry"
        assert props[f].get("type") == "keyword", (
            f"{f} must be keyword-mapped — a term query on analyzed text silently returns 0")


# --------------------------------------------------------------------------- #
# B3(3) — silent-threshold recalibration: a quiet-but-healthy ALERT feed is NOT flagged;
# a genuinely dead source (prior events, quiet for hours) IS. The old ~2-min flat check
# (k×poll_interval) false-positived on any legitimately quiet / bursty alert feed.
# --------------------------------------------------------------------------- #
@asyncio
async def test_quiet_alert_source_not_flagged_but_dead_source_is(app_state: AppState):
    p = app_state.prefs.model_copy(deep=True)
    p.poll_interval_seconds = 30  # base flat window = 4×30 = 120s (the old bug)
    p.sources = [
        _source("quietAlerts", "quiet-a-logs*", primary=True),
        _source("deadSrc", "dead-logs*"),
    ]
    await app_state.update_prefs(p)

    now = datetime.now(timezone.utc)
    # Both build a genuine activity history (>= established-obs non-empty ticks) via the
    # real producer path, so each earns the raised long-quiet tolerance.
    for _ in range(app_state._SILENT_SOURCE_ESTABLISHED_OBS + 1):
        await app_state.observe_source_volume("quietAlerts", 5, when=now - timedelta(minutes=3))
        await app_state.observe_source_volume("deadSrc", 5, when=now - timedelta(hours=3))

    silent = app_state.silent_sources(now=now)
    assert "quietAlerts" not in silent   # a 3-min quiet gap on a real feed ≠ silent (no FP)
    assert "deadSrc" in silent           # hours dead WITH prior events = genuinely silent

    # The flat check is preserved as a conservative COLD-START fallback: a barely-seen source
    # (below the established-obs bar) still uses the short window, so a brand-new source that
    # stops right after its first event is caught fast.
    app_state._source_last_event["coldSrc"] = now - timedelta(minutes=10)
    app_state._source_event_ticks["coldSrc"] = 1  # only just started (< established bar)
    p2 = app_state.prefs.model_copy(deep=True)
    p2.sources = list(p2.sources) + [_source("coldSrc", "cold-logs*")]
    await app_state.update_prefs(p2)

    silent2 = app_state.silent_sources(now=now)
    assert "coldSrc" in silent2          # cold-start flat check (10 min > ~2 min) still fires
    assert "quietAlerts" not in silent2  # ...while the established quiet feed still isn't flagged
