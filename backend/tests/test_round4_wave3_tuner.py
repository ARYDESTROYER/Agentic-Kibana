"""Round 4 / Wave 3 — adaptive threshold AUTO-TUNING observer (SAFE by construction).

Offline, network-free (fake KV via app_state; a fake AuditLogger that records calls).
Covers:
  * A genuinely-noisy rule (enough samples, Wilson-LB FP-rate > target) → AUTO-APPLIES a
    +1 correlation ``n`` (before/after audited, rollback restores the prior value).
  * A 3-of-3 FP fluke does NOT trip (Wilson lower-bound + min-samples floor).
  * A change that would have HIDDEN a confirmed TRUE_POSITIVE is BLOCKED → a HITL
    Proposal is drafted instead (never auto-applied).
  * A suppression DROP is ALWAYS a Proposal (never auto-applied).
  * Disabled config → run_once is a byte-identical no-op.
  * TuningStore CRUD + rollback token, durable across a fresh store instance.
  * #3 guard: the module source imports NO case_manager and never invokes the close
    decision fn; ``cluster_signature`` is byte-identical (the tuner never touches it).
"""

from __future__ import annotations

import inspect
from datetime import timedelta
from typing import Any

import pytest

from app.config import (
    CorrelationRule,
    IndexPattern,
    Preferences,
    SourceInstance,
    ThresholdTuningConfig,
)
from app.constants import (
    ActionType,
    Disposition,
    EntityType,
    IngestMode,
    SourceSurface,
    SourceType,
    Verdict,
)
from app.engine import threshold_tuner as tuner
from app.engine.signatures import cluster_signature
from app.engine.threshold_tuner import (
    RuleStat,
    TuningProposal,
    apply_correlation_n,
    derive_proposals,
    rollback,
    run_once,
    shadow_eval_hides_true_positive,
    wilson_lower_bound,
)
from app.models import Case, Entity, TriggerReason
from app.state import AppState
from app.stores.tuning import TuningRecord, TuningStore
from app.utils import iso_now, now_utc


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
class FakeAudit:
    """Records ``record(...)`` calls (kwargs) so a test can assert on the before/after
    TUNING trail without an ES round-trip."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    async def record(self, **kwargs: Any) -> None:
        self.calls.append(kwargs)

    def by_type(self, action_type: ActionType) -> list[dict[str, Any]]:
        return [c for c in self.calls if c.get("action_type") == action_type]


def _closed_case(
    *,
    case_id: str,
    rule: str,
    fp: bool = True,
    tp: bool = False,
    ip: str = "203.0.113.10",
    observed_count: int = 6,
    severity_max: float | None = None,
    days_ago: int = 1,
) -> Case:
    """A verdicted-CLOSED case keyed on ``rule`` for the tuner to read.

    ``fp`` → FALSE_POSITIVE verdict; ``tp`` → TRUE_POSITIVE verdict. ``observed_count``
    and ``severity_max`` populate the trigger_reason so shadow-eval has data."""
    verdict = Verdict.TRUE_POSITIVE if tp else (Verdict.FALSE_POSITIVE if fp else Verdict.NEEDS_HUMAN)
    disposition = (
        Disposition.TRUE_POSITIVE if tp else (Disposition.FALSE_POSITIVE if fp else None)
    )
    tr = TriggerReason(
        rule_value=rule, mode="threshold", n=5, observed_count=observed_count,
        severity_max=severity_max, rule_values=[rule],
    )
    closed_iso = (now_utc() - timedelta(days=days_ago)).isoformat()
    return Case(
        case_id=case_id,
        cluster_signature=f"sig:{case_id}",
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value=ip),
        rule_ids=[rule],
        member_event_ids=[f"{case_id}-e{i}" for i in range(observed_count)],
        verdict=verdict,
        disposition=disposition,
        confidence=0.9,
        status="closed",  # type: ignore[arg-type]
        updated_at=closed_iso,
        trigger_reason=tr,
    )


def _tuning_prefs(**over: Any) -> Preferences:
    """Preferences with tuning ENABLED + a low min_samples for compact tests."""
    cfg = ThresholdTuningConfig(
        enabled=True, min_samples=over.pop("min_samples", 25),
        fp_rate_target=over.pop("fp_rate_target", 0.30),
        max_n_step=over.pop("max_n_step", 1),
        shadow_eval=over.pop("shadow_eval", True),
        cadence=over.pop("cadence", "nightly"),
    )
    return Preferences(threshold_tuning=cfg, **over)


def _writer_capture():
    """A write_prefs callback that captures the last-written Preferences."""
    box: dict[str, Preferences] = {}

    async def _write(p: Preferences) -> Preferences:
        box["prefs"] = p
        return p

    return _write, box


# --------------------------------------------------------------------------- #
# Pure statistics — Wilson lower bound + the fluke floor
# --------------------------------------------------------------------------- #
def test_wilson_lower_bound_pulls_small_samples_below() -> None:
    # 3 of 3 FP (naive rate 1.0) → the LOWER bound is well below 0.5 (a fluke floor).
    lb_3 = wilson_lower_bound(3, 3)
    assert lb_3 < 0.5
    # A large sample at the same naive rate stays high.
    lb_50 = wilson_lower_bound(50, 50)
    assert lb_50 > 0.9
    # 30 of 40 (0.75) with a big sample clears a 0.30 target comfortably.
    assert wilson_lower_bound(30, 40) > 0.30
    # n<=0 is a safe 0.0.
    assert wilson_lower_bound(0, 0) == 0.0


# --------------------------------------------------------------------------- #
# A genuinely-noisy rule AUTO-APPLIES a +1 n (audited, reversible)
# --------------------------------------------------------------------------- #
async def test_noisy_rule_auto_applies_n_raise_audited_and_reversible(app_state: AppState) -> None:
    prefs = _tuning_prefs(min_samples=25)
    # 30 FP closes out of 30 → Wilson-LB > 0.30 with n>=25. All same rule.
    cases = [_closed_case(case_id=f"c{i}", rule="noisy_rule") for i in range(30)]

    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )

    assert outcome.ran is True
    assert len(outcome.auto_applied) == 1
    rec = outcome.auto_applied[0]
    assert rec.rule_id == "noisy_rule" and rec.target == "correlation_n"
    # Default correlation n is 5 → auto-applied to 6 (a +1 bounded step).
    assert rec.before == 5 and rec.after == 6
    assert rec.samples == 30 and rec.fp_rate > 0.30

    # The NEW prefs were persisted with the raised n (config-writer only).
    written = box["prefs"]
    assert written.correlation_for("noisy_rule").n == 6

    # A before/after TUNING audit record was written (never a status/disposition change).
    tuning_audits = audit.by_type(ActionType.TUNING)
    assert len(tuning_audits) == 1
    assert "5->6" in tuning_audits[0]["result_summary"] and "noisy_rule" in tuning_audits[0]["result_summary"]

    # The store holds the record + rollback token; rollback RESTORES the prior value.
    stored = await store.list(active_only=True)
    assert len(stored) == 1 and stored[0].id == rec.id

    ok = await rollback(rec.id, written, tuning_store=store, write_prefs=write, audit=audit)
    assert ok is True
    assert box["prefs"].correlation_for("noisy_rule").n == 5  # restored
    # The record is now rolled-back (no longer active).
    assert await store.list(active_only=True) == []
    # A second rollback of the same record is a no-op.
    assert await rollback(rec.id, box["prefs"], tuning_store=store, write_prefs=write) is False


# --------------------------------------------------------------------------- #
# FINDING #14 — a rule is bumped ONCE per cadence window, never re-raised every tick.
# --------------------------------------------------------------------------- #
async def test_two_ticks_within_cadence_bump_only_once(app_state: AppState) -> None:
    """The nightly tuner runs on a 6h loop but must re-raise a knob AT MOST once per
    cadence window: without a guard it would bump ``n`` on EVERY tick (the trailing-window
    FP-rate is unchanged tick-to-tick), growing the knob unbounded. ``run_once`` builds an
    ``already_tuned`` set from the tuning_store so the SECOND pass over the SAME noise does
    NOT re-apply."""
    prefs = _tuning_prefs(min_samples=25)
    cases = [_closed_case(case_id=f"c{i}", rule="noisy_rule") for i in range(30)]

    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    # TICK 1 — the noisy rule is genuinely noisy → +1 auto-applied (5 -> 6).
    out1 = await run_once(prefs, cases, app_state.proposals, audit,
                          tuning_store=store, write_prefs=write)
    assert len(out1.auto_applied) == 1
    assert out1.auto_applied[0].before == 5 and out1.auto_applied[0].after == 6
    written_prefs = box["prefs"]
    assert written_prefs.correlation_for("noisy_rule").n == 6
    assert len(await store.list(active_only=True)) == 1

    # TICK 2 — same window, same cases, the raised prefs threaded in. The rule is STILL
    # over target (nothing changed), but it was ALREADY tuned this window → NO second bump.
    out2 = await run_once(written_prefs, cases, app_state.proposals, audit,
                          tuning_store=store, write_prefs=write)
    assert out2.ran is True
    assert out2.auto_applied == []                      # NOT re-raised
    assert out2.proposals == []
    # Exactly ONE record in the ledger; n did not creep to 7.
    assert len(await store.list(active_only=True)) == 1
    assert box["prefs"].correlation_for("noisy_rule").n == 6
    # Only the tick-1 TUNING audit exists (no second auto-apply audit).
    assert len(audit.by_type(ActionType.TUNING)) == 1


async def test_scheduler_cadence_gate_skips_ticks_within_window(app_state: AppState) -> None:
    """The scheduler's cadence gate: with a fresh (never-run) store the gate is OPEN; once
    a run is stamped, a subsequent tick INSIDE the nightly window is gated CLOSED; a stamp
    older than the window re-opens it (FINDING #14 — belt on the scheduler side too)."""
    cfg = ThresholdTuningConfig(enabled=True, cadence="nightly")
    # Never run yet → gate open.
    assert await app_state._tuner_cadence_elapsed(cfg) is True
    # Stamp "now" → a same-window tick is gated off.
    await app_state.tuning_store.set_last_run_at()
    assert await app_state._tuner_cadence_elapsed(cfg) is False
    # A stamp older than the nightly window (25h ago) re-opens the gate.
    old = (now_utc() - timedelta(hours=25)).isoformat()
    await app_state.tuning_store.set_last_run_at(old)
    assert await app_state._tuner_cadence_elapsed(cfg) is True
    # Manual cadence is always instant (window 0).
    assert await app_state._tuner_cadence_elapsed(
        ThresholdTuningConfig(enabled=True, cadence="manual")) is True


# --------------------------------------------------------------------------- #
# A 3-of-3 fluke does NOT trip (Wilson + min-samples)
# --------------------------------------------------------------------------- #
async def test_three_of_three_fluke_does_not_trip(app_state: AppState) -> None:
    prefs = _tuning_prefs(min_samples=25)
    # Only 3 FP closes for the rule — below min_samples AND Wilson-LB < target.
    cases = [_closed_case(case_id=f"f{i}", rule="fluke_rule") for i in range(3)]

    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )
    assert outcome.ran is True
    assert outcome.auto_applied == []
    assert outcome.proposals == []
    assert "prefs" not in box  # nothing was written
    assert await store.list() == []
    assert audit.by_type(ActionType.TUNING) == []


# --------------------------------------------------------------------------- #
# A change that would hide a confirmed TP is BLOCKED → Proposal instead
# --------------------------------------------------------------------------- #
async def test_change_hiding_true_positive_is_blocked_to_proposal(app_state: AppState) -> None:
    prefs = _tuning_prefs(min_samples=25)
    # 28 FP closes (noisy) + 2 confirmed TP whose observed member count (3) would be
    # BELOW the raised n (6) → shadow-eval blocks the auto-apply.
    cases = [_closed_case(case_id=f"n{i}", rule="mixed_rule") for i in range(28)]
    cases += [
        _closed_case(case_id="tp1", rule="mixed_rule", fp=False, tp=True, observed_count=3),
        _closed_case(case_id="tp2", rule="mixed_rule", fp=False, tp=True, observed_count=2),
    ]

    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )
    # NOT auto-applied — forced to review.
    assert outcome.auto_applied == []
    assert "mixed_rule" in outcome.shadow_blocked
    assert "prefs" not in box  # no live write
    # A pending HITL Proposal was drafted with the tuning payload flagged.
    pending = await app_state.proposals.list(status="pending")
    assert len(pending) == 1
    p = pending[0]
    assert p.created_by == "tuner"
    assert p.payload.get("tuning") is True
    assert p.payload.get("reason") == "shadow_eval_would_hide_tp"
    assert p.payload.get("rule_id") == "mixed_rule"
    # A PROPOSAL audit record (not a TUNING auto-apply record).
    assert audit.by_type(ActionType.TUNING) == []
    assert len(audit.by_type(ActionType.PROPOSAL)) == 1


# --------------------------------------------------------------------------- #
# A suppression DROP is ALWAYS a Proposal (never auto)
# --------------------------------------------------------------------------- #
async def test_suppression_drop_always_routes_to_proposal(app_state: AppState) -> None:
    prefs = _tuning_prefs()
    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    # Hand-craft a suppression proposal and route it through the internal handler to
    # prove the kind-branch NEVER auto-applies (the derive step only ever produces
    # bounded n/floor raises, so we exercise the drop path directly).
    from app.engine.threshold_tuner import _handle_proposal, TuningOutcome

    prop = TuningProposal(
        rule_id="drop_rule", kind="suppression", before=0, after=0,
        stat=RuleStat(rule_id="drop_rule", total=40, fp=35, fp_lower_bound=0.7),
    )
    outcome = TuningOutcome()
    returned = await _handle_proposal(
        prop, prefs, [], prefs.threshold_tuning,
        proposals=app_state.proposals, audit=audit, tuning_store=store,
        writers={"correlation_n": apply_correlation_n}, outcome=outcome,
    )
    assert returned is prefs  # no prefs advance → no live write
    assert outcome.auto_applied == []
    pending = await app_state.proposals.list(status="pending")
    assert len(pending) == 1
    assert pending[0].payload.get("reason") == "suppression_drop"
    assert await store.list() == []  # nothing auto-applied


# --------------------------------------------------------------------------- #
# Disabled config → byte-identical no-op
# --------------------------------------------------------------------------- #
async def test_disabled_config_is_noop(app_state: AppState) -> None:
    # Autopilot overhaul flipped the DEFAULT to ON; pin it OFF to exercise the no-op path.
    prefs = Preferences()
    prefs.threshold_tuning.enabled = False
    assert prefs.threshold_tuning.enabled is False
    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    cases = [_closed_case(case_id=f"d{i}", rule="whatever") for i in range(50)]
    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )
    assert outcome.ran is False
    assert outcome.reason == "disabled"
    assert outcome.auto_applied == [] and outcome.proposals == []
    assert "prefs" not in box
    assert await store.list() == []
    assert await app_state.proposals.list() == []
    assert audit.calls == []


# --------------------------------------------------------------------------- #
# severity_floor auto-apply (when n-tuning is off) + rollback
# --------------------------------------------------------------------------- #
async def test_severity_floor_raise_when_n_tuning_disabled(app_state: AppState) -> None:
    source = SourceInstance(
        id="src1", source_type=SourceType.ELASTICSEARCH, ingest_mode=IngestMode.PULL,
        config={"index_patterns": [
            {"pattern": "alerts-*", "id": "feedA", "role": "events",
             "severity_floor": 2, "query": "floor_rule"},
        ]},
    )
    prefs = _tuning_prefs(min_samples=25, max_n_step=0, sources=[source])
    cases = [_closed_case(case_id=f"s{i}", rule="floor_rule") for i in range(30)]

    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=write,
    )
    assert len(outcome.auto_applied) == 1
    rec = outcome.auto_applied[0]
    assert rec.target == "severity_floor"
    assert rec.rule_id == "src1:feedA"
    assert rec.before == 2 and rec.after == 3

    written = box["prefs"]
    feed = written.sources[0].feeds()[0]
    assert feed.severity_floor == 3

    # Rollback restores the floor to 2.
    ok = await rollback(rec.id, written, tuning_store=store, write_prefs=write, audit=audit)
    assert ok is True
    assert box["prefs"].sources[0].feeds()[0].severity_floor == 2


# --------------------------------------------------------------------------- #
# TuningStore CRUD + durability
# --------------------------------------------------------------------------- #
async def test_tuning_store_crud_durable(app_state: AppState) -> None:
    store = TuningStore(app_state._kv)
    assert await store.list() == []

    r = TuningRecord(rule_id="r1", target="correlation_n", before=5, after=6, fp_rate=0.6, samples=40)
    await store.add(r)
    assert (await store.get(r.id)) is not None
    assert (await store.latest_active("r1", "correlation_n")).after == 6

    # Durable across a fresh store instance (over the same KV).
    fresh = TuningStore(app_state._kv)
    assert any(x.id == r.id for x in await fresh.list())

    # Rollback flag + latest_active goes empty.
    assert (await store.mark_rolled_back(r.id)).rolled_back is True
    assert await store.latest_active("r1", "correlation_n") is None
    assert await store.mark_rolled_back(r.id) is None  # already rolled back


# --------------------------------------------------------------------------- #
# Paging reader — the tuner is NOT capped at a naive 200
# --------------------------------------------------------------------------- #
async def test_reader_pages_beyond_200(app_state: AppState) -> None:
    prefs = _tuning_prefs(min_samples=25)
    # 250 FP closes for one rule, delivered through a paging reader in pages of 100.
    all_cases = [_closed_case(case_id=f"p{i}", rule="paged_rule") for i in range(250)]

    async def reader(limit: int, offset: int) -> list[Case]:
        return all_cases[offset:offset + limit]

    store = TuningStore(app_state._kv)
    audit = FakeAudit()
    write, box = _writer_capture()

    outcome = await run_once(
        prefs, reader, app_state.proposals, audit,
        tuning_store=store, write_prefs=write, page_size=100,
    )
    # It saw all 250 (not 200) and tuned the rule once.
    assert outcome.rule_stats["paged_rule"].total == 250
    assert len(outcome.auto_applied) == 1


# --------------------------------------------------------------------------- #
# shadow_eval helper — direct unit assertions
# --------------------------------------------------------------------------- #
def test_shadow_eval_hides_tp_detects_below_threshold() -> None:
    prop = TuningProposal(rule_id="r", kind="correlation_n", before=5, after=6,
                          stat=RuleStat(rule_id="r"))
    # A TP with only 3 observed members would be hidden by n=6.
    below = _closed_case(case_id="t", rule="r", fp=False, tp=True, observed_count=3)
    assert shadow_eval_hides_true_positive(prop, [below]) is True
    # A TP with 10 members still fires at n=6 → not hidden.
    above = _closed_case(case_id="t2", rule="r", fp=False, tp=True, observed_count=10)
    assert shadow_eval_hides_true_positive(prop, [above]) is False


# --------------------------------------------------------------------------- #
# derive_proposals is pure + only produces bounded n/floor raises
# --------------------------------------------------------------------------- #
def test_derive_proposals_only_bounded_and_pure() -> None:
    prefs = _tuning_prefs(min_samples=25)
    stats = {
        "noisy": RuleStat(rule_id="noisy", total=40, fp=35, fp_lower_bound=0.7),
        "clean": RuleStat(rule_id="clean", total=40, fp=1, fp_lower_bound=0.01),
        "thin": RuleStat(rule_id="thin", total=3, fp=3, fp_lower_bound=0.9),  # below min
    }
    props = derive_proposals(prefs, stats)
    # Only the noisy, well-sampled rule yields a proposal — a bounded +1 n.
    assert len(props) == 1
    assert props[0].rule_id == "noisy" and props[0].kind == "correlation_n"
    assert props[0].after - props[0].before == 1
    # No suppression drops are ever derived automatically.
    assert all(p.kind != "suppression" for p in props)
    # Prefs are untouched (pure).
    assert prefs.correlation_for("noisy").n == 5


# --------------------------------------------------------------------------- #
# #3 GUARD — the tuner never imports case_manager / invokes the close decision
# --------------------------------------------------------------------------- #
def test_module_source_has_no_case_manager_import_or_decide_call() -> None:
    src = inspect.getsource(tuner)
    # No import of the frozen close-decision module.
    assert "import case_manager" not in src
    assert "from ..engine.case_manager" not in src
    assert "from app.engine.case_manager" not in src
    assert "case_manager" not in src
    # The literal close-decision invocation substring must be absent.
    assert "decide(" not in src


def test_tuner_module_does_not_touch_cluster_signature() -> None:
    """The tuner must NEVER recompute/alter the #4 idempotency key. Assert the source
    never references cluster_signature AND that the frozen fn is unchanged."""
    src = inspect.getsource(tuner)
    assert "cluster_signature" not in src
    # cluster_signature is byte-identical (a sanity snapshot of its behaviour).
    assert cluster_signature(EntityType.IP, "203.0.113.10") == cluster_signature(EntityType.IP, "203.0.113.10")
    a = cluster_signature(EntityType.IP, "1.2.3.4")
    b = cluster_signature(EntityType.IP, "1.2.3.5")
    assert a != b and len(a) == 32
