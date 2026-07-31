"""Focused contract tests for truthful Agent Improvement evidence.

The aggregate is deliberately advisory and privacy-preserving: it compares complete
UTC cohorts, emits no synthetic score or case identifiers, and never participates in
``case_manager.decide()``.  These tests exercise both the pure function and the
permission-gated read route without involving an LLM or external service.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.deps import require_auth
from app.api.routes_metrics import router as metrics_router
from app.auth.passwords import hash_password
from app.config import Secrets
from app.constants import CaseStatus, DecisionBy, EntityType, SourceSurface
from app.engine.agent_improvement import agent_improvement_metrics
from app.es.fake import InMemoryESClient
from app.llm.providers import MockProvider
from app.models import Case, Entity, FeedbackEntry, StatusHistoryEntry, UsageDoc
from app.state import AppState
from app.stores.tuning import TuningRecord


AS_OF = date(2026, 7, 27)


def _feedback(
    at: str,
    *,
    assessment: str = "agree",
    outcome: str = "true_positive",
    verdict: str = "TRUE_POSITIVE",
) -> FeedbackEntry:
    return FeedbackEntry(
        ts=at,
        analyst="analyst@example.test",
        assessment=assessment,
        actual_outcome=outcome,
        ai_verdict=verdict,
    )


def _history(
    from_status: str,
    to_status: str,
    at: str,
    *,
    by: str = "analyst@example.test",
) -> StatusHistoryEntry:
    return StatusHistoryEntry(
        from_status=from_status,
        to_status=to_status,
        at=at,
        by=by,
    )


def _case(
    case_id: str,
    *,
    created_at: str = "2026-06-22T00:00:00+00:00",
    feedback: list[FeedbackEntry] | None = None,
    history: list[StatusHistoryEntry] | None = None,
    source_id: str = "source-a",
    severity: str = "high",
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=f"cluster-{case_id}",
        created_at=created_at,
        updated_at=created_at,
        source_surface=SourceSurface.AUTOMATED_SCAN,
        entity=Entity(type=EntityType.IP, value="198.51.100.23"),
        source_id=source_id,
        source_name="Source A",
        severity_band=severity,
        status=CaseStatus.CLOSED,
        feedback=feedback or [],
        status_history=history or [],
    )


def _reviewed_case(
    case_id: str,
    *,
    day: str,
    assessment: str = "agree",
    outcome: str = "true_positive",
    verdict: str = "TRUE_POSITIVE",
) -> Case:
    """One graded case with a 60-minute human review episode on ``day``."""
    return _case(
        case_id,
        created_at=f"{day}T08:00:00+00:00",
        feedback=[
            _feedback(
                f"{day}T12:00:00+00:00",
                assessment=assessment,
                outcome=outcome,
                verdict=verdict,
            )
        ],
        history=[
            _history("open", "investigating", f"{day}T09:00:00+00:00"),
            _history("investigating", "closed", f"{day}T10:00:00+00:00"),
        ],
    )


def test_complete_utc_windows_are_half_open_and_daily_buckets_are_stable() -> None:
    cases = [
        # Included at the baseline's exact lower boundary.
        _case("baseline-start", feedback=[_feedback("2026-06-22T00:00:00Z")]),
        # The current lower boundary belongs to current, never baseline.
        _case("current-start", feedback=[_feedback("2026-07-20T00:00:00Z")]),
        # The exclusive as-of boundary is a partial/future day and is excluded.
        _case("at-end", feedback=[_feedback("2026-07-27T00:00:00Z")]),
    ]

    result = agent_improvement_metrics(cases, as_of=AS_OF)

    assert result["windows"] == {
        "as_of_exclusive": "2026-07-27",
        "current": {"start": "2026-07-20", "end_exclusive": "2026-07-27", "days": 7},
        "baseline": {"start": "2026-06-22", "end_exclusive": "2026-07-20", "days": 28},
        "timezone": "UTC",
        "complete_days_only": True,
    }
    agreement = result["metrics"]["analyst_reported_verdict_agreement"]
    assert agreement["current"]["total_graded_cases"] == 1
    assert agreement["baseline"]["total_graded_cases"] == 1
    assert result["exclusions"]["feedback_after_as_of"] == 1

    points = result["daily_points"]
    assert len(points) == 35
    assert points[0]["date"] == "2026-06-22"
    assert points[-1]["date"] == "2026-07-26"
    assert sum(point["window"] == "baseline" for point in points) == 28
    assert sum(point["window"] == "current" for point in points) == 7


def test_latest_valid_feedback_wins_once_per_case() -> None:
    case = _case(
        "dedupe-me",
        feedback=[
            _feedback("2026-07-10T12:00:00Z", assessment="agree"),
            _feedback("2026-07-21T12:00:00Z", assessment="not-a-grade"),
            _feedback("2026-07-22T12:00:00Z", assessment=" Partial "),
        ],
    )

    result = agent_improvement_metrics([case], as_of=AS_OF)
    current = result["metrics"]["analyst_reported_verdict_agreement"]["current"]
    baseline = result["metrics"]["analyst_reported_verdict_agreement"]["baseline"]

    assert current["total_graded_cases"] == 1
    assert current["feedback_counts"] == {"agree": 0, "partial": 1, "disagree": 0}
    assert current["unadjusted_value"] == 0.5
    assert baseline["total_graded_cases"] == 0
    assert result["exclusions"]["invalid_feedback_assessment"] == 1
    assert result["exclusions"]["superseded_feedback"] == 1
    assert next(p for p in result["daily_points"] if p["date"] == "2026-07-10")[
        "quality_sample_count"
    ] == 0


def test_missing_and_small_samples_are_not_rendered_as_reassuring_zeros() -> None:
    empty = agent_improvement_metrics([], as_of=AS_OF)
    empty_agreement = empty["metrics"]["analyst_reported_verdict_agreement"]["current"]
    assert empty_agreement["value"] is None
    assert empty_agreement["available"] is False
    assert empty_agreement["status"] == "unavailable"
    assert empty["headline"]["state"] == "insufficient_evidence"
    assert all(point["status"] == "collecting_evidence" for point in empty["daily_points"])

    small = agent_improvement_metrics(
        [_case("one-grade", feedback=[_feedback("2026-07-22T12:00:00Z")])],
        as_of=AS_OF,
    )
    small_agreement = small["metrics"]["analyst_reported_verdict_agreement"]["current"]
    assert small_agreement["value"] is None
    assert small_agreement["unadjusted_value"] == 1.0
    assert small_agreement["available"] is False
    assert small_agreement["status"] == "unavailable"
    assert small_agreement["minimum_sample"] == 30
    assert small["headline"]["composite_score"] is None


def test_material_correction_uses_disagreement_or_allowlisted_outcome_conflict() -> None:
    cases = [
        _case(
            "explicit-disagreement",
            feedback=[
                _feedback(
                    "2026-07-22T12:00:00Z",
                    assessment="disagree",
                    outcome="true_positive",
                    verdict="TRUE_POSITIVE",
                )
            ],
        ),
        _case(
            "tp-conflict",
            feedback=[
                _feedback(
                    "2026-07-22T12:01:00Z",
                    assessment="agree",
                    outcome="false_positive",
                    verdict="TRUE_POSITIVE",
                )
            ],
        ),
        _case(
            "fp-conflict",
            feedback=[
                _feedback(
                    "2026-07-22T12:02:00Z",
                    assessment="agree",
                    outcome="false_negative",
                    verdict="FALSE_POSITIVE",
                )
            ],
        ),
        _case(
            "needs-human-not-inferred",
            feedback=[
                _feedback(
                    "2026-07-22T12:03:00Z",
                    assessment="partial",
                    outcome="false_positive",
                    verdict="NEEDS_HUMAN",
                )
            ],
        ),
    ]

    result = agent_improvement_metrics(cases, as_of=AS_OF)
    correction = result["metrics"]["material_analyst_correction_rate"]["current"]
    agreement = result["metrics"]["analyst_reported_verdict_agreement"]["current"]

    assert correction["total_graded_cases"] == 4
    assert correction["material_corrections"] == 3
    assert correction["unadjusted_value"] == 0.75
    assert agreement["unadjusted_value"] == 0.625


def test_human_turnaround_uses_only_the_final_live_episode() -> None:
    reopened = _case(
        "reopened",
        created_at="2026-07-22T08:00:00Z",
        history=[
            _history("open", "investigating", "2026-07-22T08:05:00Z"),
            _history("investigating", "closed", "2026-07-22T08:35:00Z"),
            _history("closed", "open", "2026-07-23T09:00:00Z"),
            _history("open", "investigating", "2026-07-23T09:02:00Z", by="system"),
            _history("investigating", "on_hold", "2026-07-23T09:10:00Z"),
            _history("on_hold", "resolved", "2026-07-23T10:00:00Z"),
        ],
    )
    auto_closed = _case(
        "auto-closed",
        history=[
            _history("open", "investigating", "2026-07-23T09:00:00Z"),
            _history("investigating", "closed", "2026-07-23T09:05:00Z", by="agent"),
        ],
    )
    direct_close = _case(
        "no-ack",
        history=[_history("open", "closed", "2026-07-23T09:05:00Z")],
    )

    result = agent_improvement_metrics([reopened, auto_closed, direct_close], as_of=AS_OF)
    turnaround = result["metrics"]["human_review_turnaround"]["current"]

    assert turnaround["sample_count"] == 1
    assert turnaround["p50_minutes"] == 50.0
    assert turnaround["p90_minutes"] == 50.0
    assert result["exclusions"]["non_human_terminal"] == 1
    assert result["exclusions"]["no_human_acknowledgement"] == 1
    july_23 = next(p for p in result["daily_points"] if p["date"] == "2026-07-23")
    assert july_23["turnaround_sample_count"] == 1


def test_known_automation_actor_is_not_counted_as_human_review() -> None:
    automated = _case(
        "case-manager-transition",
        created_at="2026-07-22T08:00:00Z",
        history=[
            _history(
                "open",
                "investigating",
                "2026-07-22T09:00:00Z",
                by="case_manager",
            ),
            _history(
                "investigating",
                "closed",
                "2026-07-22T10:00:00Z",
                by="case_manager",
            ),
        ],
    )

    result = agent_improvement_metrics([automated], as_of=AS_OF)

    assert result["metrics"]["human_review_turnaround"]["current"][
        "sample_count"
    ] == 0
    assert result["exclusions"]["non_human_terminal"] == 1


def test_out_of_window_case_does_not_change_reporting_exclusions() -> None:
    empty = agent_improvement_metrics([], as_of=AS_OF)
    old_unrelated = _case(
        "old-unrelated",
        created_at="2020-01-01T00:00:00Z",
    )

    with_old_case = agent_improvement_metrics([old_unrelated], as_of=AS_OF)

    assert with_old_case["exclusions"] == empty["exclusions"]


def test_truncation_overrides_otherwise_complete_and_comparable_evidence() -> None:
    cases = [
        *[_reviewed_case(f"baseline-{index}", day="2026-07-10") for index in range(30)],
        *[_reviewed_case(f"current-{index}", day="2026-07-22") for index in range(30)],
    ]

    complete = agent_improvement_metrics(cases, as_of=AS_OF, store_total=60)
    assert complete["provenance"]["truncated"] is False
    assert complete["headline"]["state"] == "stable"
    assert complete["headline"]["comparable_mix_coverage"] == 1.0

    truncated = agent_improvement_metrics(cases, as_of=AS_OF, store_total=61)
    assert truncated["provenance"] == {
        "truncated": True,
        "store_total": 61,
        "fetched": 60,
        "aggregate_only": True,
        "case_ids_included": False,
        "billing": "none",
        "decision_authority": "reporting_only",
    }
    assert truncated["headline"]["state"] == "insufficient_evidence"
    assert all(
        metric["direction"] == "insufficient_evidence"
        for metric in truncated["metrics"].values()
    )


def test_current_only_source_shift_fails_two_sided_mix_coverage() -> None:
    cases = [
        *[
            _case(
                f"baseline-{index}",
                feedback=[_feedback("2026-07-10T12:00:00Z")],
                source_id="source-a",
            )
            for index in range(30)
        ],
        *[
            _case(
                f"current-comparable-{index}",
                feedback=[_feedback("2026-07-22T12:00:00Z")],
                source_id="source-a",
            )
            for index in range(5)
        ],
        *[
            _case(
                f"current-new-{index}",
                feedback=[
                    _feedback(
                        "2026-07-22T12:00:00Z",
                        assessment="disagree",
                    )
                ],
                source_id="source-new",
            )
            for index in range(25)
        ],
    ]

    result = agent_improvement_metrics(cases, as_of=AS_OF)

    assert result["metrics"]["analyst_reported_verdict_agreement"]["current"][
        "unadjusted_value"
    ] == 0.1667
    assert result["case_mix"]["baseline_mix_coverage"] == 1.0
    assert result["case_mix"]["current_mix_coverage"] == 0.1667
    assert result["case_mix"]["comparable_mix_coverage"] == 0.1667
    assert result["headline"]["state"] == "insufficient_evidence"
    assert "source-a" not in json.dumps(result["case_mix"])
    assert "source-new" not in json.dumps(result["case_mix"])


def test_two_stratum_swapped_volume_uses_identical_reference_weights() -> None:
    cases = [
        *[
            _case(
                f"baseline-a-{index}",
                feedback=[_feedback("2026-07-10T12:00:00Z")],
                source_id="source-a",
            )
            for index in range(25)
        ],
        *[
            _case(
                f"baseline-b-{index}",
                feedback=[
                    _feedback("2026-07-10T12:00:00Z", assessment="disagree")
                ],
                source_id="source-b",
            )
            for index in range(5)
        ],
        *[
            _case(
                f"current-a-{index}",
                feedback=[_feedback("2026-07-22T12:00:00Z")],
                source_id="source-a",
            )
            for index in range(5)
        ],
        *[
            _case(
                f"current-b-{index}",
                feedback=[
                    _feedback("2026-07-22T12:00:00Z", assessment="disagree")
                ],
                source_id="source-b",
            )
            for index in range(25)
        ],
    ]

    result = agent_improvement_metrics(cases, as_of=AS_OF)
    agreement = result["metrics"]["analyst_reported_verdict_agreement"]
    correction = result["metrics"]["material_analyst_correction_rate"]

    assert result["case_mix"]["comparable_strata"] == 2
    assert result["case_mix"]["baseline_mix_coverage"] == 1.0
    assert result["case_mix"]["current_mix_coverage"] == 1.0
    assert agreement["baseline"]["unadjusted_value"] == 0.8333
    assert agreement["current"]["unadjusted_value"] == 0.1667
    assert agreement["baseline"]["value"] == 0.5
    assert agreement["current"]["value"] == 0.5
    assert agreement["delta"]["percentage_points"] == 0.0
    assert correction["baseline"]["value"] == 0.5
    assert correction["current"]["value"] == 0.5
    assert correction["delta"]["percentage_points"] == 0.0


def test_correlated_quality_metrics_alone_cannot_promote_headline() -> None:
    cases = [
        *[
            _reviewed_case(
                f"baseline-disagree-{index}",
                day="2026-07-10",
                assessment="disagree",
            )
            for index in range(30)
        ],
        *[
            _reviewed_case(
                f"current-agree-{index}",
                day="2026-07-22",
                assessment="agree",
            )
            for index in range(30)
        ],
    ]

    result = agent_improvement_metrics(cases, as_of=AS_OF)

    assert result["metrics"]["analyst_reported_verdict_agreement"][
        "direction"
    ] == "improving"
    assert result["metrics"]["material_analyst_correction_rate"][
        "direction"
    ] == "improving"
    assert result["metrics"]["human_review_turnaround"]["direction"] == "stable"
    assert result["headline"]["state"] != "improving"


def test_false_negative_guardrail_uses_confirmed_positives_and_can_block_promotion() -> None:
    baseline = [
        _reviewed_case(f"baseline-{index}", day="2026-07-10")
        for index in range(20)
    ]
    current = [
        *[
            _reviewed_case(f"current-ok-{index}", day="2026-07-22")
            for index in range(18)
        ],
        _reviewed_case(
            "current-ai-fp",
            day="2026-07-22",
            outcome="true_positive",
            verdict="FALSE_POSITIVE",
        ),
        _reviewed_case(
            "current-explicit-fn",
            day="2026-07-22",
            outcome="false_negative",
            verdict="FALSE_POSITIVE",
        ),
    ]

    result = agent_improvement_metrics([*baseline, *current], as_of=AS_OF)
    guardrail = result["guardrails"]["confirmed_false_negative_rate"]

    assert guardrail["status"] == "enough_data"
    assert guardrail["baseline"] == {
        "value": 0.0,
        "confirmed_positive_count": 20,
        "missed_positive_count": 0,
    }
    assert guardrail["current"] == {
        "value": 0.1,
        "confirmed_positive_count": 20,
        "missed_positive_count": 2,
    }
    assert guardrail["breached"] is True


def test_promotion_eligible_metrics_are_blocked_by_false_negative_breach() -> None:
    baseline = [
        _reviewed_case(
            f"eligible-baseline-{index}",
            day="2026-07-10",
            assessment="disagree",
        )
        for index in range(30)
    ]
    current = [
        *[
            _reviewed_case(
                f"eligible-current-ok-{index}",
                day="2026-07-22",
            )
            for index in range(28)
        ],
        *[
            _reviewed_case(
                f"eligible-current-miss-{index}",
                day="2026-07-22",
                outcome="true_positive",
                verdict="FALSE_POSITIVE",
            )
            for index in range(2)
        ],
    ]
    current = [
        case.model_copy(
            update={
                "status_history": [
                    _history(
                        "open",
                        "investigating",
                        "2026-07-22T09:00:00+00:00",
                    ),
                    _history(
                        "investigating",
                        "closed",
                        "2026-07-22T09:30:00+00:00",
                    ),
                ]
            }
        )
        for case in current
    ]

    result = agent_improvement_metrics([*baseline, *current], as_of=AS_OF)

    assert result["headline"]["guardrails_ready"] is True
    assert result["headline"]["improving_signals"] == 2
    assert result["guardrails"]["confirmed_false_negative_rate"]["breached"] is True
    assert result["headline"]["state"] == "guardrail_breach"


def test_within_24_hour_human_reopen_can_breach_guardrail() -> None:
    baseline = [
        _case(
            f"baseline-agent-close-{index}",
            history=[
                _history(
                    "open",
                    "closed",
                    "2026-07-10T10:00:00Z",
                    by="agent",
                )
            ],
        )
        for index in range(20)
    ]
    current = [
        _case(
            f"current-agent-close-{index}",
            history=[
                _history(
                    "open",
                    "closed",
                    "2026-07-22T10:00:00Z",
                    by="agent",
                ),
                *(
                    [
                        _history(
                            "closed",
                            "open",
                            "2026-07-22T22:00:00Z",
                        )
                    ]
                    if index == 0
                    else []
                ),
            ],
        )
        for index in range(20)
    ]

    result = agent_improvement_metrics([*baseline, *current], as_of=AS_OF)
    guardrail = result["guardrails"]["reopen_after_agent_close_rate"]

    assert guardrail["status"] == "enough_data"
    assert guardrail["baseline"]["eligible_agent_terminal_decisions"] == 20
    assert guardrail["baseline"]["human_reopens"] == 0
    assert guardrail["baseline"]["rate"] == 0.0
    assert guardrail["current"]["eligible_agent_terminal_decisions"] == 20
    assert guardrail["current"]["human_reopens"] == 1
    assert guardrail["current"]["rate"] == 0.05
    assert guardrail["breached"] is True


def test_daily_false_negative_rate_uses_confirmed_positive_denominator() -> None:
    cases = [
        *[
            _case(
                f"four-positive-{index}",
                feedback=[_feedback("2026-07-21T12:00:00Z")],
            )
            for index in range(4)
        ],
        _case(
            "fifth-grade-not-positive",
            feedback=[
                _feedback(
                    "2026-07-21T12:00:00Z",
                    outcome="false_positive",
                    verdict="TRUE_POSITIVE",
                )
            ],
        ),
        *[
            _case(
                f"five-positive-{index}",
                feedback=[
                    _feedback(
                        "2026-07-22T12:00:00Z",
                        verdict="FALSE_POSITIVE" if index == 0 else "TRUE_POSITIVE",
                    )
                ],
            )
            for index in range(5)
        ],
    ]

    result = agent_improvement_metrics(cases, as_of=AS_OF)
    july_21 = next(point for point in result["daily_points"] if point["date"] == "2026-07-21")
    july_22 = next(point for point in result["daily_points"] if point["date"] == "2026-07-22")

    assert july_21["quality_sample_count"] == 5
    assert july_21["confirmed_positive_sample_count"] == 4
    assert july_21["false_negative_rate"] is None
    assert july_22["confirmed_positive_sample_count"] == 5
    assert july_22["false_negative_rate"] == 0.2


def test_unevaluable_guardrail_and_right_censored_reopens_never_pass_silently() -> None:
    cases = [
        *[
            _reviewed_case(
                f"baseline-{index}",
                day="2026-07-10",
                outcome="unknown",
            )
            for index in range(30)
        ],
        *[
            _reviewed_case(
                f"current-{index}",
                day="2026-07-22",
                outcome="unknown",
            )
            for index in range(30)
        ],
        _case(
            "baseline-agent-close",
            history=[
                _history(
                    "open",
                    "closed",
                    "2026-07-19T00:00:00Z",
                    by="agent",
                )
            ],
        ),
        _case(
            "current-censored-agent-close",
            history=[
                _history(
                    "open",
                    "closed",
                    "2026-07-26T12:00:00Z",
                    by="agent",
                )
            ],
        ),
    ]

    result = agent_improvement_metrics(cases, as_of=AS_OF)
    false_negative = result["guardrails"]["confirmed_false_negative_rate"]
    reopen = result["guardrails"]["reopen_after_agent_close_rate"]

    assert false_negative["status"] == "unavailable"
    assert false_negative["breached"] is None
    assert reopen["status"] == "insufficient_evidence"
    assert reopen["baseline"]["eligible_agent_terminal_decisions"] == 1
    assert reopen["current"]["candidate_agent_terminal_decisions"] == 1
    assert reopen["current"]["eligible_agent_terminal_decisions"] == 0
    assert reopen["current"]["right_censored_decisions"] == 1
    assert reopen["breached"] is None
    assert result["headline"]["guardrails_ready"] is False
    assert result["headline"]["state"] == "insufficient_evidence"


def test_additive_outcomes_keep_unsupported_claims_explicitly_unavailable() -> None:
    result = agent_improvement_metrics([], as_of=AS_OF)
    outcomes = result["outcomes"]

    assert outcomes["recorded_case_cost"]["status"] == "unavailable"
    assert outcomes["observed_time_saved"]["status"] == "unavailable"
    assert outcomes["confirmed_positive_case_rate"]["status"] == "unavailable"
    assert outcomes["true_positive_alert_yield"] == {
        "label": "True-positive alert yield",
        "unit": "ratio",
        "status": "unavailable",
        "reason": (
            "Analyst outcomes are persisted per case while durable volume is counted per "
            "alert; the current schema has no defensible alert-level outcome lineage."
        ),
        "current": {
            "value": None,
            "true_positive_alerts": None,
            "total_alerts": None,
            "lineage_coverage": None,
        },
        "baseline": {
            "value": None,
            "true_positive_alerts": None,
            "total_alerts": None,
            "lineage_coverage": None,
        },
        "delta": {"percentage_points": None},
        "direction": "insufficient_evidence",
        "supported_alternative": "confirmed_positive_case_rate",
        "definition": outcomes["true_positive_alert_yield"]["definition"],
    }
    assert outcomes["source_guidance"]["status"] == "not_available"
    assert outcomes["source_guidance"]["items"] == []
    assert outcomes["source_guidance"]["long_term_objective"] is True


def test_recorded_case_cost_uses_exact_windows_and_ignores_unassociated_calls() -> None:
    records = [
        {"ts": "2026-07-10T12:00:00Z", "case_id": "baseline-a", "cost": 14.0},
        {"ts": "2026-07-11T12:00:00Z", "case_id": "baseline-b", "cost": 14.0},
        {"ts": "2026-07-22T12:00:00Z", "case_id": "current-a", "cost": 7.0},
        {"ts": "2026-07-22T12:01:00Z", "case_id": None, "cost": 999.0},
        {"ts": "2026-07-27T00:00:00Z", "case_id": "after-end", "cost": 999.0},
    ]

    result = agent_improvement_metrics(
        [],
        as_of=AS_OF,
        usage_records=records,
        usage_available=True,
    )
    cost = result["outcomes"]["recorded_case_cost"]

    assert cost["status"] == "enough_data"
    assert cost["baseline"] == {
        "total_cost": 28.0,
        "call_count": 2,
        "costed_cases": 2,
        "cost_per_costed_case": 14.0,
        "cost_per_day": 1.0,
    }
    assert cost["current"] == {
        "total_cost": 7.0,
        "call_count": 1,
        "costed_cases": 1,
        "cost_per_costed_case": 7.0,
        "cost_per_day": 1.0,
    }
    assert cost["direction"] == "down"
    assert cost["cost_per_day_direction"] == "stable"
    assert "baseline-a" not in json.dumps(cost)


def test_recorded_case_cost_does_not_treat_empty_or_capped_reads_as_evidence() -> None:
    empty = agent_improvement_metrics(
        [], as_of=AS_OF, usage_records=[], usage_available=True
    )["outcomes"]["recorded_case_cost"]
    assert empty["status"] == "unavailable"
    assert empty["direction"] == "insufficient_evidence"
    assert "no eligible case-associated usage rows" in empty["reason"]

    capped = agent_improvement_metrics(
        [],
        as_of=AS_OF,
        usage_records=[
            {"ts": "2026-07-10T12:00:00Z", "case_id": "baseline", "cost": 1.0},
            {"ts": "2026-07-22T12:00:00Z", "case_id": "current", "cost": 1.0},
        ],
        usage_available=True,
        usage_records_truncated=True,
    )["outcomes"]["recorded_case_cost"]
    assert capped["status"] == "insufficient_evidence"
    assert capped["direction"] == "insufficient_evidence"


def _closure_case(
    case_id: str,
    *,
    day: str,
    owner: str,
    elapsed_minutes: int,
    reported_saved: int = 0,
) -> Case:
    start_hour = 8
    terminal_minutes = start_hour * 60 + elapsed_minutes
    terminal = f"{day}T{terminal_minutes // 60:02d}:{terminal_minutes % 60:02d}:00Z"
    actor = "agent" if owner == "agent" else "analyst@example.test"
    decision = DecisionBy.AGENT if owner == "agent" else DecisionBy.ANALYST
    return _case(
        case_id,
        created_at=f"{day}T08:00:00Z",
        feedback=[
            FeedbackEntry(
                ts=terminal,
                analyst="analyst@example.test",
                assessment="agree",
                actual_outcome="true_positive",
                ai_verdict="TRUE_POSITIVE",
                time_saved_minutes=reported_saved,
            )
        ],
        history=[_history("open", "closed", terminal, by=actor)],
    ).model_copy(update={"decision_by": decision})


def test_observed_time_saved_is_elapsed_difference_not_manual_labor_claim() -> None:
    cases = [
        *[
            _closure_case(
                f"baseline-human-{index}", day="2026-07-10", owner="human", elapsed_minutes=60
            )
            for index in range(10)
        ],
        *[
            _closure_case(
                f"baseline-agent-{index}", day="2026-07-10", owner="agent", elapsed_minutes=30
            )
            for index in range(10)
        ],
        *[
            _closure_case(
                f"current-human-{index}", day="2026-07-22", owner="human", elapsed_minutes=50
            )
            for index in range(10)
        ],
        *[
            _closure_case(
                f"current-agent-{index}",
                day="2026-07-22",
                owner="agent",
                elapsed_minutes=10,
                reported_saved=35,
            )
            for index in range(10)
        ],
    ]

    saved = agent_improvement_metrics(cases, as_of=AS_OF)["outcomes"][
        "observed_time_saved"
    ]

    assert saved["status"] == "enough_data"
    assert saved["baseline"]["observed_difference_minutes_per_case"] == 30.0
    assert saved["current"]["human_owned_closure_p50_minutes"] == 50.0
    assert saved["current"]["agent_closed_p50_minutes"] == 10.0
    assert saved["current"]["observed_difference_minutes_per_case"] == 40.0
    assert saved["current"]["estimated_total_minutes_saved"] == 400.0
    assert saved["current"]["analyst_reported_total_minutes_saved"] == 350
    assert saved["delta"]["minutes_per_case"] == 10.0
    assert saved["direction"] == "improving"
    assert "not active labor" in saved["definition"]["caveats"]


def test_slower_agent_closures_are_never_labeled_as_saved_time() -> None:
    cases = [
        *[
            _closure_case(
                f"baseline-human-{index}", day="2026-07-10", owner="human", elapsed_minutes=20
            )
            for index in range(10)
        ],
        *[
            _closure_case(
                f"baseline-agent-{index}", day="2026-07-10", owner="agent", elapsed_minutes=40
            )
            for index in range(10)
        ],
        *[
            _closure_case(
                f"current-human-{index}", day="2026-07-22", owner="human", elapsed_minutes=20
            )
            for index in range(10)
        ],
        *[
            _closure_case(
                f"current-agent-{index}", day="2026-07-22", owner="agent", elapsed_minutes=40
            )
            for index in range(10)
        ],
    ]

    saved = agent_improvement_metrics(cases, as_of=AS_OF)["outcomes"][
        "observed_time_saved"
    ]
    assert saved["label"] == "Observed elapsed-time difference"
    assert saved["current"]["observed_difference_minutes_per_case"] == -20.0
    assert saved["current"]["observed_aggregate_elapsed_difference_minutes"] == -200.0
    assert saved["current"]["estimated_total_minutes_saved"] is None


def test_confirmed_positive_case_rate_is_supported_but_direction_is_neutral() -> None:
    baseline = [
        _case(
            f"baseline-{index}",
            feedback=[
                _feedback(
                    "2026-07-10T12:00:00Z",
                    outcome="true_positive" if index < 10 else "false_positive",
                )
            ],
        )
        for index in range(20)
    ]
    current = [
        _case(
            f"current-{index}",
            feedback=[
                _feedback(
                    "2026-07-22T12:00:00Z",
                    outcome="true_positive" if index < 15 else "false_positive",
                )
            ],
        )
        for index in range(20)
    ]

    rate = agent_improvement_metrics([*baseline, *current], as_of=AS_OF)["outcomes"][
        "confirmed_positive_case_rate"
    ]

    assert rate["status"] == "enough_data"
    assert rate["baseline"]["value"] == 0.5
    assert rate["current"]["value"] == 0.75
    assert rate["delta"]["percentage_points"] == 25.0
    assert rate["direction"] == "up"
    assert "not true-positive alerts / total alerts" in rate["definition"]["caveats"]


def test_alert_volume_and_tuning_context_are_descriptive_not_causal() -> None:
    result = agent_improvement_metrics(
        [],
        as_of=AS_OF,
        noise_comparison={
            "available": True,
            "incomplete": False,
            "window_basis": "rolling_hours",
            "current": {
                "ingested": {"high": 700},
                "clustered": {"high": 350},
            },
            "baseline": {
                "ingested": {"high": 2800},
                "clustered": {"high": 280},
            },
        },
        tuning_records=[
            {
                "applied_at": "2026-07-22T12:00:00Z",
                "rolled_back_at": None,
                "rule_id": "must-never-leak",
            }
        ],
        tuning_available=True,
    )
    volume = result["outcomes"]["alert_volume"]
    tuning = result["outcomes"]["tuning_context"]

    assert volume["status"] == "enough_data"
    assert volume["current"]["ingested_per_day"] == 100.0
    assert volume["baseline"]["ingested_per_day"] == 100.0
    assert volume["current"]["clustering_reduction_count"] == 350
    assert volume["current"]["clustering_reduction_rate"] == 0.5
    assert volume["ingested_direction"] == "stable"
    assert volume["after_clustering_direction"] == "up"
    assert tuning["status"] == "enough_data"
    assert tuning["current"]["applied_changes"] == 1
    assert tuning["cooccurring_after_clustering_direction"] == "up"
    assert tuning["causal_claim"] is False
    assert tuning["model_fine_tuning_evidence"] is False
    assert "must-never-leak" not in json.dumps(tuning)


def test_period_comparisons_distinguish_weekly_and_rolling_28_day_windows() -> None:
    cases = [
        *[_reviewed_case(f"baseline-{index}", day="2026-06-10") for index in range(30)],
        *[_reviewed_case(f"current-{index}", day="2026-07-10") for index in range(30)],
    ]

    periods = agent_improvement_metrics(cases, as_of=AS_OF)["period_comparisons"]
    weekly = periods["week_over_week"]
    monthly = periods["month_over_month"]

    assert weekly["current"] == {
        "start": "2026-07-20",
        "end_exclusive": "2026-07-27",
        "days": 7,
    }
    assert weekly["baseline"] == {
        "start": "2026-07-13",
        "end_exclusive": "2026-07-20",
        "days": 7,
    }
    assert weekly["status"] == "unavailable"
    assert monthly["label"] == "Rolling 28 days over prior 28 days"
    assert monthly["calendar_period"] is False
    assert monthly["current"]["days"] == 28
    assert monthly["baseline"]["days"] == 28
    assert monthly["status"] == "enough_data"


def test_period_comparisons_compute_distinct_weekly_and_rolling_outcomes() -> None:
    usage = [
        {"ts": "2026-06-15T12:00:00Z", "case_id": "month-baseline", "cost": 14.0},
        {"ts": "2026-07-15T12:00:00Z", "case_id": "week-baseline", "cost": 70.0},
        {"ts": "2026-07-22T12:00:00Z", "case_id": "week-current", "cost": 7.0},
    ]
    period_noise = {
        "week_over_week": {
            "available": True,
            "incomplete": False,
            "window_basis": "complete_utc_days",
            "current": {"ingested": {"high": 700}, "clustered": {"high": 350}},
            "baseline": {"ingested": {"high": 1400}, "clustered": {"high": 700}},
        },
        "month_over_month": {
            "available": True,
            "incomplete": False,
            "window_basis": "complete_utc_days",
            "current": {"ingested": {"high": 2800}, "clustered": {"high": 1400}},
            "baseline": {"ingested": {"high": 2800}, "clustered": {"high": 280}},
        },
    }

    periods = agent_improvement_metrics(
        [],
        as_of=AS_OF,
        usage_records=usage,
        usage_available=True,
        period_noise_comparisons=period_noise,
    )["period_comparisons"]
    weekly = periods["week_over_week"]["outcomes"]
    monthly = periods["month_over_month"]["outcomes"]

    assert weekly["recorded_case_cost"]["current"]["cost_per_costed_case"] == 7.0
    assert weekly["recorded_case_cost"]["baseline"]["cost_per_costed_case"] == 70.0
    assert weekly["recorded_case_cost"]["direction"] == "down"
    assert monthly["recorded_case_cost"]["current"]["cost_per_costed_case"] == 38.5
    assert monthly["recorded_case_cost"]["baseline"]["cost_per_costed_case"] == 14.0
    assert monthly["recorded_case_cost"]["direction"] == "up"
    assert weekly["alert_volume"]["after_clustering_direction"] == "down"
    assert monthly["alert_volume"]["after_clustering_direction"] == "up"


@pytest.fixture
def metrics_client(app_state):
    api = FastAPI()
    api.state.tlsoc = app_state
    api.include_router(metrics_router, dependencies=[Depends(require_auth)])
    return TestClient(api)


async def test_route_is_aggregate_only_private_and_validates_query_bounds(
    metrics_client: TestClient,
    app_state: AppState,
) -> None:
    secret_case = _case(
        "case-secret-do-not-return",
        source_id="source-id-secret-do-not-return",
        feedback=[
            FeedbackEntry(
                ts="2026-07-22T12:00:00Z",
                analyst="analyst-secret-do-not-return@example.test",
                assessment="agree",
                actual_outcome="true_positive",
                ai_verdict="TRUE_POSITIVE",
                comment="comment-secret-do-not-return",
            )
        ],
    ).model_copy(
        update={
            "source_name": "source-name-secret-do-not-return",
            "rule_ids": ["rule-id-secret-do-not-return"],
        }
    )
    await app_state.cases.save(secret_case)
    await app_state.usage_store.write_strict(
        UsageDoc(
            ts="2026-07-22T12:00:00Z",
            case_id="usage-case-secret-do-not-return",
            model="model-secret-do-not-return",
            cost=0.5,
        )
    )
    await app_state.tuning_store.add(
        TuningRecord(
            id="tuning-secret-do-not-return",
            rule_id="tuning-rule-secret-do-not-return",
            target="correlation_n",
            before=2,
            after=3,
            applied_at="2026-07-22T12:00:00Z",
        )
    )

    response = metrics_client.get("/api/metrics/agent-improvement?as_of=2026-07-26")
    assert response.status_code == 200
    body = response.json()
    encoded = json.dumps(body)
    assert "case-secret-do-not-return" not in encoded
    assert "cluster-case-secret-do-not-return" not in encoded
    assert "198.51.100.23" not in encoded
    assert "source-id-secret-do-not-return" not in encoded
    assert "source-name-secret-do-not-return" not in encoded
    assert "analyst-secret-do-not-return@example.test" not in encoded
    assert "comment-secret-do-not-return" not in encoded
    assert "rule-id-secret-do-not-return" not in encoded
    assert "usage-case-secret-do-not-return" not in encoded
    assert "model-secret-do-not-return" not in encoded
    assert "tuning-secret-do-not-return" not in encoded
    assert "tuning-rule-secret-do-not-return" not in encoded
    assert body["provenance"]["aggregate_only"] is True
    assert body["provenance"]["case_ids_included"] is False
    assert body["synthetic"] is False

    assert (
        metrics_client.get("/api/metrics/agent-improvement?current_days=0").status_code
        == 422
    )
    assert (
        metrics_client.get("/api/metrics/agent-improvement?baseline_days=6").status_code
        == 422
    )
    assert (
        metrics_client.get("/api/metrics/agent-improvement?as_of=not-a-date").status_code
        == 422
    )
    assert (
        metrics_client.get("/api/metrics/agent-improvement?as_of=2999-01-01").status_code
        == 422
    )


async def test_route_strict_read_failures_are_explicit_not_empty_success(
    metrics_client: TestClient,
    app_state: AppState,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fail_read(*_args, **_kwargs):
        raise RuntimeError("projection unavailable")

    monkeypatch.setattr(app_state.usage_store, "records_strict", fail_read)
    monkeypatch.setattr(app_state.tuning_store, "list_strict", fail_read)
    monkeypatch.setattr(app_state.noise_counters, "read_window_strict", fail_read)

    response = metrics_client.get(
        "/api/metrics/agent-improvement?as_of=2026-07-27"
    )
    assert response.status_code == 200
    body = response.json()
    outcomes = body["outcomes"]
    assert outcomes["recorded_case_cost"]["status"] == "unavailable"
    assert outcomes["alert_volume"]["status"] == "unavailable"
    assert outcomes["tuning_context"]["status"] == "unavailable"
    weekly = body["period_comparisons"]["week_over_week"]["outcomes"]
    assert weekly["recorded_case_cost"]["status"] == "unavailable"
    assert weekly["alert_volume"]["status"] == "unavailable"


async def test_route_noise_windows_share_the_exact_historical_utc_boundary(
    metrics_client: TestClient,
    app_state: AppState,
) -> None:
    async def record(day: str, ingested: int, clustered: int) -> None:
        await app_state.noise_counters.record(
            {
                "ingested": {"high": ingested},
                "clustered": {"high": clustered},
            },
            now=datetime.fromisoformat(day).replace(tzinfo=timezone.utc),
        )

    # Establish complete 56-day retention coverage, then place distinct observations
    # in the monthly baseline, weekly baseline, weekly current, and exact upper bucket.
    await record("2026-06-01T00:00:00", 1, 1)
    await record("2026-06-15T12:00:00", 10, 5)
    await record("2026-07-15T12:00:00", 20, 10)
    await record("2026-07-22T12:00:00", 30, 15)
    await record("2026-07-27T00:00:00", 1000, 1000)

    response = metrics_client.get(
        "/api/metrics/agent-improvement?as_of=2026-07-27"
    )
    assert response.status_code == 200
    body = response.json()
    main = body["outcomes"]["alert_volume"]
    weekly = body["period_comparisons"]["week_over_week"]["outcomes"][
        "alert_volume"
    ]
    monthly = body["period_comparisons"]["month_over_month"]["outcomes"][
        "alert_volume"
    ]

    assert main["window_basis"] == "complete_utc_days"
    assert main["current"]["ingested_alerts"] == 30
    assert main["baseline"]["ingested_alerts"] == 20
    assert weekly["current"]["ingested_alerts"] == 30
    assert weekly["baseline"]["ingested_alerts"] == 20
    assert monthly["current"]["ingested_alerts"] == 50
    assert monthly["baseline"]["ingested_alerts"] == 11
    # The 1000-alert bucket at the exact as_of boundary is excluded everywhere.
    assert all(
        1000 > period["current"]["ingested_alerts"]
        for period in (main, weekly, monthly)
    )


def test_route_requires_metrics_view_when_auth_and_rbac_are_enabled() -> None:
    password = "blocked-user-password"
    allowed_password = "allowed-admin-password"
    secrets = Secrets(
        _env_file=None,
        es_store_enabled=False,
        redis_url="",
        anthropic_api_key=None,
        openai_api_key=None,
        auth_enabled=True,
        auth_jwt_secret="agent-improvement-rbac-test-secret",
        auth_seed_admin=False,
        auth_admin_username="allowed",
        auth_admin_password=allowed_password,
        auth_users={"blocked": hash_password(password)},
    )
    mock = MockProvider()
    providers = {"anthropic": mock, "openai": mock, "mock": mock}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = AppState.create(
            secrets=secrets,
            es=InMemoryESClient(),
            provider_overrides=providers,
        )
        await state.startup(start_poller=False)
        rbac = state.prefs.rbac.model_copy(
            update={
                "enabled": True,
                "denies": {"analyst_tier1": {"metrics": ["view"]}},
            }
        )
        await state.update_prefs(state.prefs.model_copy(update={"rbac": rbac}))
        app.state.tlsoc = state
        yield
        await state.shutdown()

    api = FastAPI(lifespan=lifespan)
    api.include_router(metrics_router, dependencies=[Depends(require_auth)])

    with TestClient(api) as client:
        assert client.get("/api/metrics/agent-improvement").status_code == 401
        allowed_token = client.app.state.tlsoc.auth.authenticate(
            "allowed", allowed_password
        )
        assert allowed_token is not None
        allowed = client.get(
            "/api/metrics/agent-improvement",
            headers={"Authorization": f"Bearer {allowed_token}"},
        )
        assert allowed.status_code == 200

        token = client.app.state.tlsoc.auth.authenticate("blocked", password)
        assert token is not None
        denied = client.get(
            "/api/metrics/agent-improvement",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert denied.status_code == 403
        assert denied.json()["detail"] == "permission denied: metrics:view"
