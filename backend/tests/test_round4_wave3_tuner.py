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
from collections import Counter
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
    CaseStatus,
    DecisionBy,
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
    terminal_case_reader,
    wilson_lower_bound,
)
from app.models import Case, Entity, FeedbackEntry, TriggerReason
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
        feedback=(
            [FeedbackEntry(
                analyst="analyst",
                actual_outcome="true_positive" if tp else "false_positive",
            )]
            if (tp or fp)
            else []
        ),
    )


def _tuning_prefs(**over: Any) -> Preferences:
    """Preferences with tuning ENABLED + a low min_samples for compact tests."""
    cfg = ThresholdTuningConfig(
        enabled=True, min_samples=over.pop("min_samples", 25),
        fp_rate_target=over.pop("fp_rate_target", 0.30),
        max_n_step=over.pop("max_n_step", 1),
        shadow_eval=over.pop("shadow_eval", True),
        cadence=over.pop("cadence", "nightly"),
        auto_apply_confirmed=over.pop("auto_apply_confirmed", True),
    )
    return Preferences(threshold_tuning=cfg, **over)


def _writer_capture():
    """A write_prefs callback that captures the last-written Preferences."""
    box: dict[str, Preferences] = {}

    async def _write(p: Preferences) -> Preferences:
        box["prefs"] = p
        return p

    return _write, box


def test_auto_apply_policy_requires_shadow_evaluation() -> None:
    """An operator cannot persist automatic writes without the TP replay guard."""
    with pytest.raises(ValueError, match="auto_apply_confirmed requires shadow_eval"):
        ThresholdTuningConfig(
            enabled=True,
            shadow_eval=False,
            auto_apply_confirmed=True,
        )


class _TerminalCaseRepository:
    """Small status-partitioned repository used to exercise the scheduler pager."""

    def __init__(self, rows: dict[str, list[Case]]) -> None:
        self.rows = rows

    async def list(
        self, *, status: str, limit: int, offset: int,
        sort_field: str, sort_order: str,
    ) -> tuple[list[Case], int]:
        assert sort_field == "updated_at" and sort_order == "desc"
        source = self.rows.get(status, [])
        return source[offset: offset + limit], len(source)


class _FailingTerminalCaseRepository(_TerminalCaseRepository):
    def __init__(self, rows: dict[str, list[Case]], fail_status: str) -> None:
        super().__init__(rows)
        self.fail_status = fail_status

    async def list(self, **kwargs: Any) -> tuple[list[Case], int]:
        if kwargs["status"] == self.fail_status:
            raise RuntimeError("terminal partition unavailable")
        return await super().list(**kwargs)


class _UnconfirmedProposalStore:
    """Fail-soft drafting seam: returns a row but never makes it readable."""

    async def add_unique(self, proposal, _dedupe_key):  # noqa: ANN001
        return proposal, True

    async def get(self, _proposal_id):  # noqa: ANN001
        return None


async def test_terminal_case_reader_pages_two_statuses_as_one_sequence() -> None:
    """700 CLOSED + 700 RESOLVED rows cross two 500-row scheduler pages safely."""
    closed = [
        _closed_case(case_id=f"closed-{index}", rule="paged")
        for index in range(700)
    ]
    resolved = [
        _closed_case(case_id=f"resolved-{index}", rule="paged").model_copy(
            update={"status": CaseStatus.RESOLVED}
        )
        for index in range(700)
    ]
    repository = _TerminalCaseRepository({
        CaseStatus.CLOSED.value: closed,
        CaseStatus.RESOLVED.value: resolved,
    })
    cases = await tuner._read_window(
        terminal_case_reader(repository),
        window_start=now_utc() - timedelta(days=14),
        page_size=500,
    )
    counts = Counter(case.case_id for case in cases)
    assert len(cases) == 1400
    assert len(counts) == 1400
    assert set(counts.values()) == {1}
    assert set(counts) == {
        *(case.case_id for case in closed),
        *(case.case_id for case in resolved),
    }


@pytest.mark.parametrize("failed", [CaseStatus.CLOSED.value, CaseStatus.RESOLVED.value])
async def test_terminal_case_reader_aborts_when_either_partition_fails(failed: str) -> None:
    rows = {
        CaseStatus.CLOSED.value: [_closed_case(case_id="closed-ok", rule="r")],
        CaseStatus.RESOLVED.value: [
            _closed_case(case_id="resolved-ok", rule="r").model_copy(
                update={"status": CaseStatus.RESOLVED}
            )
        ],
    }
    reader = terminal_case_reader(_FailingTerminalCaseRepository(rows, failed))
    with pytest.raises(RuntimeError, match=f"status {failed}"):
        await reader(500, 0)


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


async def test_failed_write_prefs_records_no_ledger_or_audit(app_state: AppState) -> None:
    # audit #24: if the config write fails, the ledger + audit must NOT claim an apply
    # (which would emit a false 'applied/reversible' record AND block re-tuning the
    # still-noisy rule next window).
    prefs = _tuning_prefs(min_samples=25)
    cases = [_closed_case(case_id=f"c{i}", rule="noisy_rule") for i in range(30)]
    store = TuningStore(app_state._kv)
    audit = FakeAudit()

    async def _failing_write(p):  # noqa: ANN001
        raise RuntimeError("prefs store down")

    outcome = await run_once(
        prefs, cases, app_state.proposals, audit,
        tuning_store=store, write_prefs=_failing_write,
    )
    assert outcome.auto_applied == [], "no apply may be recorded when the write failed"
    assert await store.list(active_only=True) == [], "ledger must not claim the apply"
    assert audit.by_type(ActionType.TUNING) == [], "no false 'applied' audit"
    # The rule is NOT marked tuned this window → it can be re-tuned once the store recovers.


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
    # Manual cadence is operator-triggered only; the background scheduler must not
    # reinterpret it as "run on every tick".
    assert await app_state._tuner_cadence_elapsed(
        ThresholdTuningConfig(enabled=True, cadence="manual")) is False


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
    assert p.payload.get("reason_code") == "shadow_eval_would_hide_confirmed_tp"
    assert "analyst-confirmed true positive" in p.payload.get("reason", "")
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
    returned, rec = await _handle_proposal(
        prop, prefs, [], prefs.threshold_tuning,
        proposals=app_state.proposals, audit=audit, tuning_store=store,
        writers={"correlation_n": apply_correlation_n}, outcome=outcome,
    )
    assert returned is prefs  # no prefs advance → no live write
    assert rec is None  # a suppression drop is HITL, never an auto-apply record
    assert outcome.auto_applied == []
    pending = await app_state.proposals.list(status="pending")
    assert len(pending) == 1
    assert pending[0].payload.get("reason_code") == "suppression_drop"
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


async def test_severity_floor_not_re_raised_within_cadence_window(app_state: AppState) -> None:
    # audit #23: a second pass over the SAME unchanging noise must NOT re-raise the feed's
    # severity_floor (it would climb +1 every run to the max). Mirrors the correlation_n
    # per-window guard.
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

    out1 = await run_once(prefs, cases, app_state.proposals, audit,
                          tuning_store=store, write_prefs=write)
    assert len(out1.auto_applied) == 1
    after_prefs = box["prefs"]
    assert after_prefs.sources[0].feeds()[0].severity_floor == 3

    # Second pass over the SAME closed cases + the now-raised prefs: no re-raise.
    out2 = await run_once(after_prefs, cases, app_state.proposals, audit,
                          tuning_store=store, write_prefs=write)
    assert out2.auto_applied == [], "severity_floor must not climb again within the window"


def test_severity_floor_requires_an_explicit_rule_to_feed_mapping() -> None:
    """A noisy rule must never raise the first unrelated feed as a fallback."""
    source = SourceInstance(
        id="src1", source_type=SourceType.ELASTICSEARCH, ingest_mode=IngestMode.PULL,
        config={"index_patterns": [{
            "pattern": "alerts-*", "id": "feedA", "role": "events",
            "severity_floor": 2, "query": "different_rule",
        }]},
    )
    prefs = _tuning_prefs(min_samples=25, max_n_step=0, sources=[source])
    cases = [_closed_case(case_id=f"u{i}", rule="unmapped_noisy_rule") for i in range(30)]
    stats = tuner._accumulate_rule_stats(
        cases,
        ewma_alpha=prefs.threshold_tuning.ewma_alpha,
        z=prefs.threshold_tuning.wilson_z,
    )

    assert derive_proposals(prefs, stats) == []


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
# Outcome provenance + approval rails
# --------------------------------------------------------------------------- #
async def test_model_outputs_do_not_train_and_evidence_request_is_idempotent(
    app_state: AppState,
) -> None:
    prefs = _tuning_prefs(min_samples=5, auto_apply_confirmed=False)
    cases = [_closed_case(case_id=f"m{i}", rule="model_only") for i in range(8)]
    for case in cases:
        case.feedback = []  # verdict + automatic disposition remain, but no human label

    store = TuningStore(app_state._kv)
    write, box = _writer_capture()
    first = await run_once(
        prefs, cases, app_state.proposals, FakeAudit(),
        tuning_store=store, write_prefs=write,
    )
    stat = first.rule_stats["model_only"]
    assert (stat.observed, stat.total, stat.unconfirmed, stat.fp, stat.tp) == (8, 0, 8, 0, 0)
    assert first.auto_applied == [] and "prefs" not in box
    assert len(first.proposals) == 1
    payload = first.proposals[0].payload
    assert payload["action"] == "collect_evidence"
    assert payload["reason_code"] == "insufficient_analyst_evidence"
    assert payload["observed_cases"] == 8 and payload["analyst_samples"] == 0

    second = await run_once(
        prefs, cases, app_state.proposals, FakeAudit(),
        tuning_store=store, write_prefs=write,
    )
    assert len(second.proposals) == 1  # existing row returned to the caller
    assert len(await app_state.proposals.list()) == 1  # no scheduler spam


async def test_confirmed_evidence_queues_apply_when_auto_apply_policy_is_off(
    app_state: AppState,
) -> None:
    prefs = _tuning_prefs(min_samples=5, auto_apply_confirmed=False)
    cases = [_closed_case(case_id=f"h{i}", rule="human_noise") for i in range(8)]
    write, box = _writer_capture()
    result = await run_once(
        prefs, cases, app_state.proposals, FakeAudit(),
        tuning_store=TuningStore(app_state._kv), write_prefs=write,
    )
    assert result.auto_applied == [] and "prefs" not in box
    assert len(result.proposals) == 1
    payload = result.proposals[0].payload
    assert payload["action"] == "apply_change"
    assert payload["reason_code"] == "policy_requires_approval"
    assert payload["analyst_samples"] == 8


def test_latest_feedback_wins_and_explicit_disposition_requires_classification_action() -> None:
    case = _closed_case(case_id="graded", rule="r")
    case.feedback = [
        FeedbackEntry(ts="2026-01-01T00:00:00+00:00", analyst="a", actual_outcome="false_positive"),
        FeedbackEntry(ts="2026-01-02T00:00:00+00:00", analyst="b", actual_outcome="true_positive"),
    ]
    assert tuner._analyst_outcome(case) == ("true_positive", "analyst_feedback")

    case.feedback = []
    case.decision_by = DecisionBy.ANALYST
    case.disposition = Disposition.FALSE_POSITIVE
    case.history = [{"event": "analyst_action", "action": "acknowledge"}]
    assert tuner._analyst_outcome(case) == (None, None)
    case.history.append({"event": "analyst_action", "action": "set_disposition"})
    assert tuner._analyst_outcome(case) == (
        "false_positive", "explicit_analyst_disposition",
    )


async def test_model_true_positive_does_not_shadow_block_but_confirmed_one_does(
    app_state: AppState,
) -> None:
    prefs = _tuning_prefs(min_samples=5, auto_apply_confirmed=True)
    false_positives = [_closed_case(case_id=f"fp{i}", rule="guard") for i in range(8)]
    model_tp = _closed_case(
        case_id="model-tp", rule="guard", fp=False, tp=True, observed_count=1,
    )
    model_tp.feedback = []
    write, box = _writer_capture()
    unblocked = await run_once(
        prefs, [*false_positives, model_tp], app_state.proposals, FakeAudit(),
        tuning_store=TuningStore(app_state._kv), write_prefs=write,
    )
    assert len(unblocked.auto_applied) == 1

    confirmed_tp = model_tp.model_copy(update={
        "case_id": "confirmed-tp",
        "cluster_signature": "sig:confirmed-tp",
        "feedback": [FeedbackEntry(analyst="human", actual_outcome="true_positive")],
    })
    prop = TuningProposal(
        rule_id="guard", kind="correlation_n", before=5, after=6,
        stat=RuleStat(rule_id="guard", observed=9, total=9, fp=8, tp=1),
    )
    assert shadow_eval_hides_true_positive(prop, [model_tp]) is False
    assert shadow_eval_hides_true_positive(prop, [confirmed_tp]) is True


def test_rule_ids_are_normalized_and_deduplicated_per_case() -> None:
    case = _closed_case(case_id="norm", rule=" noisy_rule ")
    case.rule_ids = [" noisy_rule ", "noisy_rule", ""]
    stats = tuner._accumulate_rule_stats([case], ewma_alpha=0.2, z=1.96)
    assert list(stats) == ["noisy_rule"]
    assert stats["noisy_rule"].observed == 1
    assert stats["noisy_rule"].total == 1


def test_trailing_space_rule_uses_the_canonical_live_threshold() -> None:
    """Regression for the live duplicate ``1->2`` record.

    The case export contained ``"External ... ES|QL "`` while the preference key was
    canonical and already at ``n=2``.  The old stats path kept the trailing space, so
    proposal derivation read the default ``n=1`` on every pass and repeatedly wrote a
    misleading ``1->2`` record.  Every stage now shares the stripped identity.
    """
    rule = "External Admin Panel Successful Access ES|QL"
    cfg = ThresholdTuningConfig(
        enabled=True,
        min_samples=5,
        fp_rate_target=0.3,
        max_n_step=1,
        shadow_eval=True,
        auto_apply_confirmed=True,
    )
    prefs = Preferences(
        default_correlation=CorrelationRule(n=1),
        correlation_rules={rule: CorrelationRule(n=2)},
        threshold_tuning=cfg,
    )
    cases = [
        _closed_case(case_id=f"canonical-{index}", rule=f" {rule} ")
        for index in range(8)
    ]
    stats = tuner._accumulate_rule_stats(cases, ewma_alpha=0.2, z=1.96)
    proposals = derive_proposals(prefs, stats)

    assert list(stats) == [rule]
    assert len(proposals) == 1
    assert proposals[0].rule_id == rule
    assert (proposals[0].before, proposals[0].after) == (2, 3)
    updated = apply_correlation_n(prefs, proposals[0])
    assert updated is not None
    assert set(updated.correlation_rules) == {rule}
    assert updated.correlation_for(rule).n == 3


async def test_auto_apply_ledger_failure_restores_the_exact_threshold(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A config write without durable rollback provenance is compensated, not claimed."""
    prefs = _tuning_prefs(min_samples=5, auto_apply_confirmed=True)
    cases = [_closed_case(case_id=f"saga-{i}", rule="saga_rule") for i in range(8)]
    store = TuningStore(app_state._kv)
    writes: list[Preferences] = []

    async def write(next_prefs: Preferences) -> Preferences:
        writes.append(next_prefs)
        return next_prefs

    async def ledger_unavailable(_records):  # noqa: ANN001
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(store, "add_many_strict", ledger_unavailable)
    outcome = await run_once(
        prefs,
        cases,
        app_state.proposals,
        FakeAudit(),
        tuning_store=store,
        write_prefs=write,
    )

    assert outcome.auto_applied == []
    assert outcome.persistence_errors
    assert len(writes) == 2  # bounded write, then exact compensation
    assert writes[0].correlation_for("saga_rule").n == 6
    assert writes[-1].correlation_for("saga_rule").n == 5
    assert await store.list_strict(active_only=True) == []


async def test_rollback_retry_finalises_ledger_after_restore(
    app_state: AppState, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A lost rollback-ledger write is retryable after the preference reached before."""
    store = TuningStore(app_state._kv)
    record = TuningRecord(
        rule_id="retry_rule",
        target="correlation_n",
        before=5,
        after=6,
        evidence_source="analyst_confirmed",
    )
    await store.add_many_strict([record])
    live = Preferences(correlation_rules={"retry_rule": CorrelationRule(n=6)})
    writes: list[Preferences] = []

    async def write(next_prefs: Preferences) -> Preferences:
        writes.append(next_prefs)
        return next_prefs

    original_finalize = store.mark_rolled_back_strict

    async def finalize_unavailable(_record_id: str):
        raise RuntimeError("ledger unavailable")

    monkeypatch.setattr(store, "mark_rolled_back_strict", finalize_unavailable)
    assert await rollback(
        record.id, live, tuning_store=store, write_prefs=write,
    ) is False
    assert writes[-1].correlation_for("retry_rule").n == 5
    assert (await store.get_strict(record.id)).rolled_back is False  # type: ignore[union-attr]

    monkeypatch.setattr(store, "mark_rolled_back_strict", original_finalize)
    assert await rollback(
        record.id, writes[-1], tuning_store=store, write_prefs=write,
    ) is True
    final = await store.get_strict(record.id)
    assert final is not None and final.rolled_back is True


async def test_legacy_applied_record_is_reviewable_without_automatic_rollback(
    app_state: AppState,
) -> None:
    prefs = _tuning_prefs(min_samples=5, auto_apply_confirmed=False)
    store = TuningStore(app_state._kv)
    legacy = TuningRecord(
        rule_id=" legacy_rule ", target="correlation_n", before=5, after=6,
        fp_rate=0.8, samples=30,
    )
    await store.add(legacy)
    write, box = _writer_capture()
    first = await run_once(
        prefs, [], app_state.proposals, FakeAudit(), tuning_store=store, write_prefs=write,
    )
    assert "prefs" not in box
    assert len(first.proposals) == 1
    payload = first.proposals[0].payload
    assert payload["action"] == "review_history"
    assert payload["record_id"] == legacy.id
    assert payload["rule_id"] == "legacy_rule"
    still_active = await store.get(legacy.id)
    assert still_active is not None and still_active.rolled_back is False

    await run_once(
        prefs, [], app_state.proposals, FakeAudit(), tuning_store=store, write_prefs=write,
    )
    assert len(await app_state.proposals.list()) == 1


async def test_tuner_never_claims_unconfirmed_proposal_and_scheduler_retries(
    app_state: AppState,
) -> None:
    prefs = _tuning_prefs(min_samples=5, auto_apply_confirmed=False)
    cases = [_closed_case(case_id=f"missing-{i}", rule="missing_queue") for i in range(8)]
    write, box = _writer_capture()
    outcome = await run_once(
        prefs,
        cases,
        _UnconfirmedProposalStore(),
        FakeAudit(),
        tuning_store=TuningStore(app_state._kv),
        write_prefs=write,
    )
    assert outcome.proposals == []
    assert outcome.persistence_errors
    assert "scheduler retry required" in outcome.reason
    assert "prefs" not in box

    # The same validator used immediately before the durable cadence stamp rejects the
    # pass. The scheduler records the outage and leaves last_run empty, so the next
    # minute remains eligible for retry rather than hiding the missing approval row.
    with pytest.raises(RuntimeError, match="proposal persistence failed"):
        app_state._require_tuner_success(outcome)
    app_state._scheduler_failure("threshold_tuner", RuntimeError(outcome.reason))
    health = await app_state.scheduler_health()
    assert "proposal persistence failed" in health["workers"]["threshold_tuner"]["last_error"]
    assert await app_state.tuning_store.get_last_run_at() is None


async def test_atomic_tuning_mutator_preserves_unrelated_concurrent_preferences(
    app_state: AppState,
) -> None:
    prefs = _tuning_prefs(min_samples=5, auto_apply_confirmed=True)
    concurrent = prefs.model_copy(update={
        "branding": prefs.branding.model_copy(update={"org_name": "Concurrent SOC"}),
    })
    cases = [_closed_case(case_id=f"atomic-{i}", rule="atomic_rule") for i in range(8)]
    captured: dict[str, Preferences] = {}

    async def mutate(transform):  # noqa: ANN001
        captured["prefs"] = transform(concurrent)
        return captured["prefs"]

    async def stale_writer(_prefs):  # noqa: ANN001
        raise AssertionError("production must prefer the atomic mutator")

    outcome = await run_once(
        prefs,
        cases,
        app_state.proposals,
        FakeAudit(),
        tuning_store=TuningStore(app_state._kv),
        write_prefs=stale_writer,
        mutate_prefs=mutate,
    )
    assert len(outcome.auto_applied) == 1
    assert captured["prefs"].branding.org_name == "Concurrent SOC"
    assert captured["prefs"].correlation_for("atomic_rule").n == 6


async def test_legacy_review_is_queued_during_startup_without_mutating_record() -> None:
    from app.config import Secrets
    from app.es.fake import InMemoryESClient
    from app.llm.providers import MockProvider

    es = InMemoryESClient()
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
    )
    providers = {"anthropic": MockProvider(), "openai": MockProvider(), "mock": MockProvider()}
    first = AppState.create(secrets=secrets, es=es, provider_overrides=providers)
    await first.startup(start_poller=False)
    legacy = TuningRecord(
        rule_id="startup_legacy",
        target="correlation_n",
        before=5,
        after=6,
        fp_rate=0.81,
        samples=31,
    )
    await first.tuning_store.add(legacy)
    await first.shutdown()

    restarted = AppState.create(secrets=secrets, es=es, provider_overrides=providers)
    try:
        await restarted.startup(start_poller=False)
        queued = await restarted.proposals.list(status="pending")
        matches = [p for p in queued if (p.payload or {}).get("record_id") == legacy.id]
        assert len(matches) == 1
        assert matches[0].payload["action"] == "review_history"
        still_active = await restarted.tuning_store.get(legacy.id)
        assert still_active is not None
        assert still_active.rolled_back is False
        assert still_active.before == 5 and still_active.after == 6
    finally:
        await restarted.shutdown()


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
