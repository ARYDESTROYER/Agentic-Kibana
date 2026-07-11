"""Autopilot / Smart-Defaults overhaul (Batch B2) — offline tests.

Covers the B2 deliverables (all fully offline — fake ES, no LLM, no network):

  * config default SNAPSHOT — the $0/#3-safe smart engines flip ON + the STANDARDS
    numbers (risk floor 70, per-tick cap 25, tuner min_samples 30 / fp 0.10, baseline
    modified-z 3.5, hard budget $10) + the master switch on;
  * MIGRATION — a stored PRE-overhaul config auto-adopts the ON defaults ONCE + is
    flagged with the one-time banner; a fresh install is never flagged; a programmatic
    explicit opt-out is preserved byte-for-byte; a post-marker opt-out is never
    re-overwritten;
  * COLD-TENANT SAFETY — with defaults ON, a fresh/empty tenant produces/proposes
    NOTHING unsafe (no campaigns, no automation rules, no baseline anomaly, schedulers
    gated off) and ``decide()`` is never imported by the new/producer modules (#3);
  * the AUTOPILOT dial resolver + ``apply_autopilot_profile``;
  * the BASELINE realtime PRODUCER — ``observe_source_volume`` warms + persists the
    namespaced ``__source_volume__:<id>`` series, flags a flood after warm-up, stays
    quiet while cold; ``observe_cluster_volume`` is advisory-only; ``max_series`` LRU
    keeps the persisted set bounded;
  * SILENT-SOURCE v0 flat check — a previously-reporting enabled source goes silent
    after ``k x poll_interval``; an unseen source is never flagged; it works with the
    baseline learner OFF (the flat check is independent of the warm-up);
  * the COMPOSITE noise+baseline sink still records the durable counters AND feeds the
    producer, fail-open.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

import inspect

from app.config import (
    AUTOPILOT_PROFILES,
    CURRENT_AUTOPILOT_CONFIG_VERSION,
    BaselineConfig,
    CampaignConfig,
    CapsConfig,
    Preferences,
    Secrets,
    SourceInstance,
)
from app.constants import SourceType
from app.engine.baseline import BaselineEngine, source_volume_signature
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.state import AppState

asyncio = pytest.mark.asyncio

T0 = datetime(2026, 7, 9, 12, 0, tzinfo=timezone.utc)


def _build_state() -> AppState:
    secrets = Secrets(
        _env_file=None, es_store_enabled=False, redis_url="",
        anthropic_api_key=None, openai_api_key=None,
    )
    mp = MockProvider()
    overrides = {"anthropic": mp, "openai": mp, "mock": mp}
    return AppState.create(secrets=secrets, es=InMemoryESClient(), provider_overrides=overrides)


def _fast_baseline() -> BaselineConfig:
    """A single-bucket, quick-warming baseline so a realtime-producer test warms in a
    handful of observations instead of 504."""
    return BaselineConfig(seasonality="none", warmup_multiplier=5, modified_z_threshold=3.5)


# --------------------------------------------------------------------------- #
# 1. Config default snapshot — the ON posture + the STANDARDS numbers.
# --------------------------------------------------------------------------- #
def test_smart_engines_default_on_snapshot():
    p = Preferences()
    # $0 / #3-safe learners flip ON.
    assert p.threshold_tuning.enabled is True
    assert p.threshold_tuning.shadow_eval is True            # mandatory rail kept
    assert p.campaign.enabled is True
    assert p.cross_source_correlation.enabled is True
    assert p.sla.enabled is True
    assert p.priority_matrix.enabled is True
    assert p.realtime.enabled is True
    assert p.threshold_automation.enabled is True            # engine on...
    assert p.threshold_automation.rules == []                # ...but NO cost-bearing rules
    assert p.baseline.enabled is True


def test_standards_numbers_snapshot():
    p = Preferences()
    # Master switch + deterministic risk gate.
    assert p.background_scan_enabled is True
    assert p.auto_investigate_risk_floor == 70
    assert p.caps.max_auto_investigations_per_tick == 25
    # Budget backstop — hard provider-spend ceiling; case still fails to human.
    assert p.budget.enabled is True
    assert p.budget.daily_usd == 10.0
    assert p.budget.soft_warn_pct == 0.80
    assert p.budget.on_exceed == "block"
    # Tuner sensitivity (STANDARDS.md).
    assert p.threshold_tuning.min_samples == 30
    assert p.threshold_tuning.fp_rate_target == 0.10
    assert p.threshold_tuning.wilson_z == 1.96
    assert p.threshold_tuning.max_n_step == 1
    # Baseline sensitivity + bounds.
    assert p.baseline.modified_z_threshold == 3.5
    assert p.baseline.warmup_days == 14
    assert p.baseline.max_series == 50000
    # Autopilot dial default + marker.
    assert p.autopilot_profile == "balanced"
    assert p.autopilot_config_version == CURRENT_AUTOPILOT_CONFIG_VERSION
    assert p.show_autopilot_banner is False


def test_batch_and_block_stay_opt_in():
    """The cost / irreversibility levers must NOT default on."""
    p = Preferences()
    assert p.batch.enabled is False              # external cost lever
    assert p.budget.on_exceed == "block"         # hard spend ceiling; case fails human


# --------------------------------------------------------------------------- #
# 2. Autopilot dial resolver.
# --------------------------------------------------------------------------- #
def test_autopilot_profiles_map():
    assert AUTOPILOT_PROFILES["conservative"]["auto_investigate_risk_floor"] == 90
    assert AUTOPILOT_PROFILES["balanced"]["auto_investigate_risk_floor"] == 70
    assert AUTOPILOT_PROFILES["aggressive"]["auto_investigate_risk_floor"] == 40
    assert AUTOPILOT_PROFILES["conservative"]["daily_usd"] == 5.0
    assert AUTOPILOT_PROFILES["aggressive"]["max_auto_investigations_per_tick"] == 100
    # unknown profile falls back to balanced (the standard).
    assert Preferences.autopilot_bounds("nonsense") == AUTOPILOT_PROFILES["balanced"]


def test_balanced_bounds_equal_the_field_defaults():
    """A fresh install (balanced) is internally consistent with the field defaults."""
    p = Preferences()
    b = Preferences.autopilot_bounds("balanced")
    assert p.auto_investigate_risk_floor == b["auto_investigate_risk_floor"]
    assert p.budget.daily_usd == b["daily_usd"]
    assert p.caps.max_auto_investigations_per_tick == b["max_auto_investigations_per_tick"]


def test_cap_field_documents_per_source_semantics_and_global_bound():
    """DOC-CONTRACT regression: ``caps.max_auto_investigations_per_tick`` is enforced
    PER SOURCE (``handle_clusters`` runs once per source), so an N-source fan-out permits
    up to N × cap investigations/tick — it is NOT a global-per-tick knob. The field's
    documentation must say so explicitly and cite ``budget.daily_usd`` as the real GLOBAL
    spend bound, so the knob is not mistaken for a global ceiling. Behaviour is unchanged;
    this guards the honesty of the docs (the misleading knob was the confirmed defect)."""
    src = inspect.getsource(CapsConfig).lower()
    assert "per-source" in src or "per source" in src
    assert "daily_usd" in src              # cites the global $ bound
    assert "global" in src                 # explicitly distinguishes global vs per-source
    # The field itself is unchanged (per-source enforcement kept; budget is the global bound).
    assert CapsConfig().max_auto_investigations_per_tick == 25


def test_apply_autopilot_profile_scales_the_three_knobs():
    p = Preferences()
    agg = p.apply_autopilot_profile("aggressive")
    assert agg.autopilot_profile == "aggressive"
    assert agg.auto_investigate_risk_floor == 40
    assert agg.budget.daily_usd == 50.0
    assert agg.caps.max_auto_investigations_per_tick == 100
    # original untouched (returns a copy).
    assert p.auto_investigate_risk_floor == 70
    con = p.apply_autopilot_profile("conservative")
    assert (con.auto_investigate_risk_floor, con.budget.daily_usd,
            con.caps.max_auto_investigations_per_tick) == (90, 5.0, 10)


# --------------------------------------------------------------------------- #
# 3. Migration — auto-adopt + banner; opt-outs preserved.
# --------------------------------------------------------------------------- #
def _old_stored_dump() -> dict:
    """A representative PRE-overhaul persisted dump: full-dump markers present, no
    ``autopilot_config_version``, every smart engine explicitly OFF (as an old
    ``model_dump`` serialised them), plus custom sub-fields to prove they survive."""
    return {
        "data_view_pattern": "all-logs-*",
        "poll_interval_seconds": 30,
        "setup_complete": True,
        "background_scan_enabled": False,
        "threshold_tuning": {"enabled": False, "min_samples": 25, "cadence": "weekly"},
        "campaign": {"enabled": False, "cadence": "weekly"},
        "cross_source_correlation": {"enabled": False, "min_sources": 3},
        "sla": {"enabled": False, "timezone": "US/Pacific"},
        "priority_matrix": {"enabled": False},
        "realtime": {"enabled": False, "heartbeat_seconds": 30},
        "threshold_automation": {"enabled": False, "rules": []},
        "baseline": {"enabled": False, "half_life_days": 7.0},
        "budget": {"enabled": False, "daily_usd": None, "on_exceed": "block"},
    }


def test_migration_adopts_on_defaults_and_flags_banner():
    p = Preferences.model_validate(_old_stored_dump())
    # Master switch + engines adopted ON.
    assert p.background_scan_enabled is True
    assert p.auto_investigate_risk_floor == 70
    assert p.threshold_tuning.enabled is True and p.threshold_tuning.shadow_eval is True
    assert p.campaign.enabled is True
    assert p.cross_source_correlation.enabled is True
    assert p.sla.enabled is True
    assert p.priority_matrix.enabled is True
    assert p.realtime.enabled is True
    assert p.threshold_automation.enabled is True
    assert p.baseline.enabled is True
    # Budget backstop adopted, NEW default $ filled, explicit hard mode preserved.
    assert p.budget.enabled is True and p.budget.daily_usd == 10.0 and p.budget.on_exceed == "block"
    # The one-time banner + the version marker are stamped.
    assert p.show_autopilot_banner is True
    assert p.autopilot_config_version == CURRENT_AUTOPILOT_CONFIG_VERSION


def test_migration_preserves_unrelated_stored_subfields():
    p = Preferences.model_validate(_old_stored_dump())
    assert p.threshold_tuning.cadence == "weekly"
    assert p.campaign.cadence == "weekly"
    assert p.cross_source_correlation.min_sources == 3
    assert p.sla.timezone == "US/Pacific"
    assert p.realtime.heartbeat_seconds == 30
    assert p.baseline.half_life_days == 7.0


def test_migration_forces_shadow_eval_on_even_if_stored_off():
    """SAFETY-RAIL regression: migration auto-ENABLES the threshold tuner. If a stored
    PRE-overhaul config had ``shadow_eval=False`` (the rail that "never hides a confirmed
    TP"), auto-enabling the tuner while preserving that False would silently defeat the
    rail for migrated tenants. Migration MUST force ``shadow_eval=True`` unconditionally,
    while preserving every OTHER stored tuner sub-field."""
    dump = _old_stored_dump()
    dump["threshold_tuning"] = {"enabled": False, "shadow_eval": False, "min_samples": 25,
                                "cadence": "weekly"}
    p = Preferences.model_validate(dump)
    assert p.threshold_tuning.enabled is True          # auto-adopted ON
    assert p.threshold_tuning.shadow_eval is True      # rail FORCED on (was stored False)
    # Other stored sub-fields survive the forced-key merge.
    assert p.threshold_tuning.min_samples == 25
    assert p.threshold_tuning.cadence == "weekly"


def test_fresh_install_is_never_flagged():
    p = Preferences()
    assert p.show_autopilot_banner is False
    assert p.autopilot_config_version == CURRENT_AUTOPILOT_CONFIG_VERSION


def test_programmatic_optout_is_preserved_not_clobbered():
    """A targeted construction lacks the full-dump markers → migration must never fire,
    so an explicit ``enabled=False`` is respected (guards existing tests)."""
    p = Preferences(campaign=CampaignConfig(enabled=False), baseline=BaselineConfig(enabled=False))
    assert p.campaign.enabled is False
    assert p.baseline.enabled is False
    assert p.show_autopilot_banner is False


def test_post_marker_optout_is_never_re_overwritten():
    """Once a config is at CURRENT, an operator's explicit opt-out sticks."""
    migrated = Preferences.model_validate(_old_stored_dump())
    dumped = migrated.model_dump(mode="json")
    dumped["campaign"]["enabled"] = False          # operator turns it back off, AFTER the marker
    dumped["background_scan_enabled"] = False
    p2 = Preferences.model_validate(dumped)
    assert p2.campaign.enabled is False
    assert p2.background_scan_enabled is False


def test_round_trip_is_stable_no_double_migration():
    p1 = Preferences()
    p2 = Preferences.model_validate(p1.model_dump(mode="json"))
    assert p2.autopilot_config_version == CURRENT_AUTOPILOT_CONFIG_VERSION
    assert p2.show_autopilot_banner is False        # never re-flags on a current dump


# --------------------------------------------------------------------------- #
# 4. Cold-tenant safety — defaults ON must PRODUCE/PROPOSE NOTHING unsafe.
# --------------------------------------------------------------------------- #
@asyncio
async def test_cold_tenant_produces_nothing_unsafe():
    from app.engine.campaigns import correlate_campaigns

    p = Preferences()   # fresh, everything ON
    # No default cost-bearing automation rules.
    assert p.threshold_automation.rules == []
    # Campaign pass over no cases → nothing.
    assert await correlate_campaigns([], p) == []
    # Baseline is COLD → never an anomaly, even for an extreme value.
    eng = BaselineEngine(p.baseline)
    for _ in range(5):
        eng.observe("cluster-x", 0, 10.0)
    assert eng.is_warm("cluster-x", 0) is False
    assert eng.is_anomaly("cluster-x", 0, 999999.0) is False


@asyncio
async def test_cold_tenant_schedulers_gated_off_until_setup_complete():
    st = _build_state()
    # Fresh tenant: setup_complete is False → every gated scheduler no-ops even though the
    # smart engines are now default-ON.
    assert st.prefs.setup_complete is False
    assert st._schedulers_gated_off() is True


def test_new_producer_modules_never_import_decide():
    """#3 source-text guard: the baseline producer never IMPORTS the decision core
    (the docstring may reference ``decide()`` in prose — we check import lines only)."""
    import app.engine.baseline as baseline_mod

    src = open(baseline_mod.__file__, encoding="utf-8").read()
    for line in src.splitlines():
        stripped = line.strip()
        if stripped.startswith(("import ", "from ")):
            assert "case_manager" not in stripped, f"unexpected decision-core import: {line!r}"


# --------------------------------------------------------------------------- #
# 5. Baseline realtime PRODUCER — via AppState.observe_source_volume.
# --------------------------------------------------------------------------- #
@asyncio
async def test_observe_source_volume_warms_flags_flood_and_persists():
    st = _build_state()
    # Single-bucket, quick warm-up so a steady baseline builds fast; the flood must sit
    # above the warmed p99 to register (the same robust-modified-z machinery Round 4 tests
    # cover) — feed a solid steady run, then a spike.
    st.prefs.baseline = BaselineConfig(seasonality="none", warmup_multiplier=1,
                                       modified_z_threshold=3.5)

    first = await st.observe_source_volume("src-a", 10, when=T0)
    assert first is not None and first.is_anomaly is False   # steady → never an anomaly
    for _ in range(149):
        sig = await st.observe_source_volume("src-a", 10, when=T0)
        assert sig.is_anomaly is False                       # steady stream stays quiet
    # A flood after the baseline has warmed → anomaly on the namespaced source series.
    hot = await st.observe_source_volume("src-a", 5000, when=T0)
    assert hot.warm is True
    assert hot.is_anomaly is True
    assert hot.signature == source_volume_signature("src-a")

    # It persisted the source-volume series to the durable store.
    assert source_volume_signature("src-a") in (await st.baseline_store.list_signatures())


@asyncio
async def test_observe_source_volume_noop_when_baseline_off_but_still_stamps_clock():
    st = _build_state()
    st.prefs.baseline = BaselineConfig(enabled=False)
    sig = await st.observe_source_volume("src-a", 7, when=T0)
    assert sig is None                                     # learner off → no signal
    # But the silence clock was still stamped, so the v0 flat check works with the
    # learner off.
    assert st._source_last_event.get("src-a") == T0


@asyncio
async def test_observe_cluster_volume_is_advisory_only():
    st = _build_state()
    st.prefs.baseline = _fast_baseline()
    out = None
    for _ in range(6):
        out = await st.observe_cluster_volume("evt::rule-42", 3, when=T0)
    assert out is not None
    assert out.signature == "evt::rule-42"
    # It produced a signal but can NEVER close/escalate — it is a pure BaselineSignal
    # with no verdict/status field.
    assert not hasattr(out, "verdict")
    assert not hasattr(out, "status")


@asyncio
async def test_realtime_baseline_max_series_lru_bounds_the_persisted_set():
    st = _build_state()
    st.prefs.baseline = BaselineConfig(seasonality="none", warmup_multiplier=1, max_series=3)
    for i in range(10):
        await st.observe_source_volume(f"src-{i}", 5, when=T0)
    # The engine LRU keeps at most max_series in memory; the flushed set is bounded too.
    assert st._realtime_baseline.series_count() == 3
    assert (await st.baseline_store.signature_count()) <= 3


# --------------------------------------------------------------------------- #
# 6. Silent-source v0 flat check.
# --------------------------------------------------------------------------- #
def _src(_id: str) -> SourceInstance:
    return SourceInstance(id=_id, source_type=SourceType.ELASTICSEARCH, enabled=True)


@asyncio
async def test_silent_source_flat_check_after_k_intervals():
    st = _build_state()
    st.prefs.sources = [_src("src-a")]
    st.prefs.poll_interval_seconds = 30
    st.prefs.baseline = BaselineConfig(enabled=False)     # flat check is independent

    # Never seen → not silent (awaiting first event, not gone silent).
    assert st.silent_sources(now=T0) == []
    # Just observed → not silent.
    await st.observe_source_volume("src-a", 4, when=T0)
    assert st.silent_sources(now=T0) == []
    # Within k * interval (4*30 = 120s) → still fine at 100s.
    assert st.silent_sources(now=T0 + timedelta(seconds=100)) == []
    # Beyond the threshold → flagged silent.
    assert st.silent_sources(now=T0 + timedelta(seconds=200)) == ["src-a"]


@asyncio
async def test_silent_source_ignores_disabled_and_unseen_sources():
    st = _build_state()
    disabled = SourceInstance(id="src-off", source_type=SourceType.ELASTICSEARCH, enabled=False)
    st.prefs.sources = [_src("src-live"), _src("src-new"), disabled]
    st.prefs.poll_interval_seconds = 10
    await st.observe_source_volume("src-live", 2, when=T0)
    await st.observe_source_volume("src-off", 2, when=T0)   # disabled → never flagged
    later = T0 + timedelta(seconds=1000)
    flagged = st.silent_sources(now=later)
    assert flagged == ["src-live"]                          # unseen src-new + disabled excluded


# --------------------------------------------------------------------------- #
# 7. Composite noise + baseline sink.
# --------------------------------------------------------------------------- #
@asyncio
async def test_composite_sink_records_counters_and_feeds_producer():
    st = _build_state()
    st.prefs.baseline = _fast_baseline()
    payload = {
        "source_id": "src-a",
        "ingested": {"critical": 1, "high": 2, "medium": 3, "low": 0, "info": 0},  # total 6
        "clustered": {"critical": 0, "high": 0, "medium": 0, "low": 0, "info": 0},
        "suppressed": 0,
        "ignored": 0,
        "cluster_volumes": {"cluster:src-a:ip": 6},
    }
    await st._noise_and_baseline_sink(payload)
    # Durable noise counters recorded the ingested band (unchanged behaviour): total 6.
    window = await st.noise_counters.read_window(24)
    assert window["available"] is True
    assert sum(window["ingested"].values()) == 6
    # The producer stamped the source clock (total ingested 6 > 0) and warmed the series.
    assert "src-a" in st._source_last_event
    signatures = await st.baseline_store.list_signatures()
    assert source_volume_signature("src-a") in signatures
    assert "cluster:src-a:ip" in signatures


@asyncio
async def test_composite_sink_without_source_id_still_records_counters():
    """An older sink call site (no source_id) must not break: counters still record, the
    per-source producer is simply skipped (no key to attribute)."""
    st = _build_state()
    payload = {"ingested": {"info": 1}, "clustered": {"info": 0}, "suppressed": 0, "ignored": 0}
    # Must not raise, and must not stamp any source clock.
    await st._noise_and_baseline_sink(payload)
    assert st._source_last_event == {}
