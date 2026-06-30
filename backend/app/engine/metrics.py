"""Deterministic metrics/analytics over the suite's own cases (SOC dashboards).

Pure aggregation functions over a list of ``Case`` objects (plus the existing
usage/cost ledger summary, merged by the route). No new storage, no LLM — these
power the analytics UI: verdict mix, status breakdown, persona/playbook usage,
average risk, a coarse MTTR, a per-day case trend, and the AI-decision feedback
quality roll-up. Everything is defensive: malformed timestamps are skipped, never
raised, so a dashboard query can't fail a request.
"""

from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone
from typing import Any

from ..constants import CaseStatus, DecisionBy, TERMINAL_CASE_STATUSES, Verdict
from ..models import Case

# A labelled placeholder for a metric that could not be computed because the
# underlying transition / event never occurred (rather than a misleading 0). The UI
# renders the dash; the ``reason`` field says WHY. Reused everywhere honesty matters.
DASH = "—"


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        s = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


def _as_dt(value: Any) -> datetime | None:
    """Coerce either a datetime (the Wave-0 lifecycle anchors) or an ISO string
    (created_at/updated_at/history timestamps) to an aware UTC datetime, or None."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        return _parse_iso(value)
    return None


def percentile(values: list[float], pct: float) -> float | None:
    """Linear-interpolated percentile over ``values`` (stdlib only, no numpy).

    ``pct`` is in [0, 100]. Returns None for an empty list (the caller renders DASH).
    Deterministic; matches the common "linear interpolation between closest ranks"
    method so p50 of an even count is the mean of the two middle values."""
    if not values:
        return None
    ordered = sorted(values)
    n = len(ordered)
    if n == 1:
        return float(ordered[0])
    rank = (max(0.0, min(100.0, pct)) / 100.0) * (n - 1)
    lo = int(rank)
    hi = min(lo + 1, n - 1)
    frac = rank - lo
    return float(ordered[lo] + (ordered[hi] - ordered[lo]) * frac)


def _stat_block(samples: list[float], *, missing_reason: str) -> dict[str, Any]:
    """A p50/p90/mean/count summary block. When ``samples`` is empty the numeric
    fields are the labelled DASH and ``reason`` explains why (honest, never a fake 0)."""
    if not samples:
        return {
            "p50": DASH, "p90": DASH, "mean": DASH, "max": DASH, "count": 0,
            "available": False, "reason": missing_reason,
        }
    return {
        "p50": round(percentile(samples, 50) or 0.0, 1),
        "p90": round(percentile(samples, 90) or 0.0, 1),
        "mean": round(sum(samples) / len(samples), 1),
        "max": round(max(samples), 1),
        "count": len(samples),
        "available": True,
        "reason": "",
    }


def feedback_stats(cases: list[Case]) -> dict:
    """Aggregate analyst feedback across cases (the eval/quality loop)."""
    entries = [fb for c in cases for fb in (c.feedback or [])]
    graded_cases = sum(1 for c in cases if c.feedback)
    if not entries:
        return {
            "graded_cases": 0, "feedback_count": 0, "agreement_rate": 0.0,
            "avg_accuracy": 0.0, "avg_reasoning_quality": 0.0,
            "avg_action_appropriateness": 0.0, "time_saved_minutes": 0,
            "outcome_distribution": {},
        }
    n = len(entries)
    agree = sum(1 for e in entries if e.assessment == "agree")
    partial = sum(0.5 for e in entries if e.assessment == "partial")
    return {
        "graded_cases": graded_cases,
        "feedback_count": n,
        "agreement_rate": round((agree + partial) / n, 4),
        "avg_accuracy": round(sum(e.accuracy for e in entries) / n, 4),
        "avg_reasoning_quality": round(sum(e.reasoning_quality for e in entries) / n, 4),
        "avg_action_appropriateness": round(sum(e.action_appropriateness for e in entries) / n, 4),
        "time_saved_minutes": int(sum(e.time_saved_minutes for e in entries)),
        "outcome_distribution": dict(Counter(e.actual_outcome for e in entries if e.actual_outcome)),
    }


def compute_metrics(cases: list[Case], *, trend_days: int = 14) -> dict:
    """Case analytics for the dashboard. Pure; deterministic given the inputs."""
    total = len(cases)
    by_status = Counter((c.status.value if c.status else "unknown") for c in cases)
    by_verdict = Counter((c.verdict.value if c.verdict else "none") for c in cases)
    by_disposition = Counter(
        (c.disposition.value if getattr(c, "disposition", None) else "undetermined") for c in cases
    )
    by_persona = Counter((c.agent_persona or "generalist") for c in cases)
    by_playbook = Counter((c.playbook_id or "none") for c in cases)

    risks = [c.risk_score for c in cases if isinstance(c.risk_score, (int, float))]
    avg_risk = round(sum(risks) / len(risks), 1) if risks else 0.0

    # Coarse MTTR: resolution latency of CLOSED cases (updated_at - created_at).
    resolution_minutes: list[float] = []
    for c in cases:
        if c.status == CaseStatus.CLOSED:
            start, end = _parse_iso(c.created_at), _parse_iso(c.updated_at)
            if start and end and end >= start:
                resolution_minutes.append((end - start).total_seconds() / 60.0)
    mttr = round(sum(resolution_minutes) / len(resolution_minutes), 1) if resolution_minutes else 0.0

    # Per-day created trend (UTC date buckets) for the last ``trend_days`` days.
    day_counts: Counter[str] = Counter()
    for c in cases:
        dt = _parse_iso(c.created_at)
        if dt:
            day_counts[dt.date().isoformat()] += 1
    trend = sorted(day_counts.items())[-trend_days:]

    return {
        "total_cases": total,
        "open_cases": by_status.get(CaseStatus.OPEN.value, 0),
        "needs_human_cases": by_status.get(CaseStatus.NEEDS_HUMAN.value, 0),
        "closed_cases": by_status.get(CaseStatus.CLOSED.value, 0),
        "by_status": dict(by_status),
        "by_disposition": dict(by_disposition),
        "by_verdict": {
            "TRUE_POSITIVE": by_verdict.get(Verdict.TRUE_POSITIVE.value, 0),
            "FALSE_POSITIVE": by_verdict.get(Verdict.FALSE_POSITIVE.value, 0),
            "NEEDS_HUMAN": by_verdict.get(Verdict.NEEDS_HUMAN.value, 0),
            "none": by_verdict.get("none", 0),
        },
        "persona_usage": dict(by_persona),
        "playbook_usage": dict(by_playbook),
        "avg_risk_score": avg_risk,
        "mttr_minutes": mttr,
        "resolved_count": len(resolution_minutes),
        "cases_per_day": [{"date": d, "count": n} for d, n in trend],
        "feedback": feedback_stats(cases),
    }


# --------------------------------------------------------------------------- #
# Richer security-posture metrics (Round 3 / Feature 5). All PURE + deterministic
# over a (time-bounded) list of Cases. None of these is ever read by
# ``case_manager.decide()`` (#3) — they are read-time reporting derived from the
# verdict / status_history / lifecycle timestamps the deterministic decision already
# produced. ⚠ Advisory severity/impact/priority bands are display/aggregation only;
# we NEVER feed them back into a decision.
# --------------------------------------------------------------------------- #

# Lifecycle statuses that mark a case as ACKNOWLEDGED (a human has it) and as having
# received a FIRST RESPONSE (active work / a decision). Derived from status_history
# transitions, not from the advisory bands.
_ACK_STATUSES = frozenset(
    {CaseStatus.INVESTIGATING.value, CaseStatus.ESCALATED.value, CaseStatus.ON_HOLD.value}
)
_RESPONSE_STATUSES = frozenset(
    {
        CaseStatus.INVESTIGATING.value, CaseStatus.ESCALATED.value, CaseStatus.ON_HOLD.value,
        CaseStatus.RESOLVED.value, CaseStatus.CLOSED.value,
    }
)
_TERMINAL = frozenset(TERMINAL_CASE_STATUSES)


def _first_transition_at(case: Case, to_statuses: frozenset[str]) -> datetime | None:
    """The earliest timestamp at which this case transitioned INTO any of
    ``to_statuses`` (from its append-only ``status_history``). None if it never did."""
    best: datetime | None = None
    for entry in case.status_history or []:
        if (entry.to_status or "") in to_statuses:
            dt = _parse_iso(entry.at)
            if dt and (best is None or dt < best):
                best = dt
    return best


def _created_dt(case: Case) -> datetime | None:
    # Prefer the explicit detection instant when populated, else creation time.
    return _as_dt(case.detected_at) or _parse_iso(case.created_at)


def lifecycle_intervals(cases: list[Case]) -> dict[str, Any]:
    """MTTA / MTTR / dwell as p50+p90+mean over the case set.

    * **MTTA** (time-to-acknowledge): created → first ACK transition (or the
      ``acknowledged_at`` anchor when present).
    * **MTTR** (time-to-resolve): created → first terminal (RESOLVED/CLOSED)
      transition (or ``updated_at`` for an already-terminal case lacking history).
    * **dwell** (time-to-first-response): created → first RESPONSE transition (or
      the ``first_response_at`` anchor).

    Each is a ``_stat_block``; when NO case ever made the transition the block is a
    labelled DASH with a reason (honest — never a fake 0)."""
    mtta: list[float] = []
    mttr: list[float] = []
    dwell: list[float] = []

    for case in cases:
        start = _created_dt(case)
        if start is None:
            continue

        ack = _as_dt(case.acknowledged_at) or _first_transition_at(case, _ACK_STATUSES)
        if ack and ack >= start:
            mtta.append((ack - start).total_seconds() / 60.0)

        resp = _as_dt(case.first_response_at) or _first_transition_at(case, _RESPONSE_STATUSES)
        if resp and resp >= start:
            dwell.append((resp - start).total_seconds() / 60.0)

        end = _first_transition_at(case, _TERMINAL)
        if end is None and (case.status.value if case.status else "") in _TERMINAL:
            end = _parse_iso(case.updated_at)  # terminal but no recorded transition
        if end and end >= start:
            mttr.append((end - start).total_seconds() / 60.0)

    return {
        "mtta_minutes": _stat_block(mtta, missing_reason="no case has been acknowledged yet"),
        "mttr_minutes": _stat_block(mttr, missing_reason="no case has been resolved/closed yet"),
        "dwell_minutes": _stat_block(dwell, missing_reason="no case has received a first response yet"),
    }


def _ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def quality_metrics(cases: list[Case]) -> dict[str, Any]:
    """Triage-quality rates COUNTED from observed verdict / status_history /
    decision_by — never *decided* here. All are pure tallies (#3 untouched).

    * ``alert_to_incident_ratio`` — TRUE_POSITIVE cases / total (incident yield).
    * ``false_positive_rate`` — FALSE_POSITIVE cases / verdicted cases.
    * ``escalation_rate`` — cases that ever entered ESCALATED / total.
    * ``containment_rate`` — terminal cases / total (worked to completion).
    * ``automation_rate`` — cases whose terminal decision was made by the AGENT
      (``decision_by == agent``) / terminal cases (deterministic auto-close share).
    """
    total = len(cases)
    verdicted = sum(1 for c in cases if c.verdict is not None)
    tp = sum(1 for c in cases if c.verdict == Verdict.TRUE_POSITIVE)
    fp = sum(1 for c in cases if c.verdict == Verdict.FALSE_POSITIVE)
    nh = sum(1 for c in cases if c.verdict == Verdict.NEEDS_HUMAN)

    escalated = sum(
        1
        for c in cases
        if (c.status == CaseStatus.ESCALATED)
        or (c.escalation_level or 0) > 0
        or _first_transition_at(c, frozenset({CaseStatus.ESCALATED.value})) is not None
    )
    terminal = [c for c in cases if (c.status.value if c.status else "") in _TERMINAL]
    auto_closed = sum(1 for c in terminal if c.decision_by == DecisionBy.AGENT)

    return {
        "total_cases": total,
        "verdicted_cases": verdicted,
        "true_positive_cases": tp,
        "false_positive_cases": fp,
        "needs_human_cases": nh,
        "escalated_cases": escalated,
        "terminal_cases": len(terminal),
        "auto_closed_cases": auto_closed,
        "alert_to_incident_ratio": _ratio(tp, total),
        "false_positive_rate": _ratio(fp, verdicted),
        "escalation_rate": _ratio(escalated, total),
        "containment_rate": _ratio(len(terminal), total),
        "automation_rate": _ratio(auto_closed, len(terminal)),
    }


# Age buckets (hours) for the open-case queue, in ascending order.
_AGE_BUCKETS: tuple[tuple[str, float, float], ...] = (
    ("<1h", 0.0, 1.0),
    ("1-4h", 1.0, 4.0),
    ("4-24h", 4.0, 24.0),
    ("1-3d", 24.0, 72.0),
    ("3-7d", 72.0, 168.0),
    (">7d", 168.0, float("inf")),
)


def aging(cases: list[Case], *, now: datetime | None = None, oldest_n: int = 10) -> dict[str, Any]:
    """Queue depth + age distribution of OPEN (non-terminal) cases, the oldest-N,
    and an arrival-vs-closure balance. Pure; ``now`` injectable for determinism."""
    now = now or datetime.now(timezone.utc)
    open_cases = [c for c in cases if (c.status.value if c.status else "") not in _TERMINAL]

    buckets: Counter[str] = Counter()
    aged: list[tuple[float, Case]] = []
    for c in open_cases:
        start = _created_dt(c)
        if start is None:
            continue
        age_h = max(0.0, (now - start).total_seconds() / 3600.0)
        for label, lo, hi in _AGE_BUCKETS:
            if lo <= age_h < hi:
                buckets[label] += 1
                break
        aged.append((age_h, c))

    aged.sort(key=lambda t: t[0], reverse=True)
    oldest = [
        {
            "case_id": c.case_id,
            "case_number": c.case_number or c.case_id,
            "age_hours": round(age_h, 1),
            "status": c.status.value if c.status else "",
            "risk_score": c.risk_score,
        }
        for age_h, c in aged[: max(0, oldest_n)]
    ]

    terminal_count = sum(1 for c in cases if (c.status.value if c.status else "") in _TERMINAL)
    arrivals = len(cases)
    return {
        "queue_depth": len(open_cases),
        "age_buckets": [{"bucket": label, "count": buckets.get(label, 0)} for label, _, _ in _AGE_BUCKETS],
        "oldest": oldest,
        "arrivals": arrivals,
        "closures": terminal_count,
        "closure_vs_arrival": _ratio(terminal_count, arrivals),
        "backlog": len(open_cases),
    }


def sla_metrics(cases: list[Case], sla_policy: Any, *, now: datetime | None = None) -> dict[str, Any]:
    """SLA attainment vs ``Preferences.sla`` (response + resolve targets per P-level).

    DETERMINISTIC + advisory (#3): we compare each case's elapsed response/resolution
    time against the target for its ``priority_level`` and classify it
    breached / at-risk (>=80% of target, not yet met) / ok. SLA classification NEVER
    feeds ``decide()``. Returns ``enabled:false`` (untouched today) when the policy
    is off so the existing behaviour is byte-identical."""
    now = now or datetime.now(timezone.utc)
    enabled = bool(getattr(sla_policy, "enabled", False))
    targets = getattr(sla_policy, "targets", {}) or {}
    if not enabled or not targets:
        return {"enabled": False, "evaluated": 0, "reason": "SLA policy disabled or no targets"}

    AT_RISK_FRACTION = 0.8
    response_breached = response_at_risk = 0
    resolve_breached = resolve_at_risk = 0
    evaluated = 0
    breaching: list[dict[str, Any]] = []

    for c in cases:
        prio = c.priority_level or ""
        target = targets.get(prio)
        if target is None:
            continue  # no target for this (or no) priority → not SLA-scored
        evaluated += 1
        start = _created_dt(c)
        if start is None:
            continue

        # Response clock: created → first response (status_history / anchor), else now.
        resp_at = _as_dt(c.first_response_at) or _first_transition_at(c, _RESPONSE_STATUSES)
        resp_target = float(getattr(target, "response_minutes", 0) or 0)
        if resp_target > 0:
            elapsed = ((resp_at or now) - start).total_seconds() / 60.0
            if resp_at is None:  # still unresponded → live clock
                if elapsed > resp_target:
                    response_breached += 1
                    breaching.append(_breach_row(c, "response", elapsed, resp_target, "breached"))
                elif elapsed >= resp_target * AT_RISK_FRACTION:
                    response_at_risk += 1
                    breaching.append(_breach_row(c, "response", elapsed, resp_target, "at_risk"))
            elif elapsed > resp_target:  # responded, but late
                response_breached += 1
                breaching.append(_breach_row(c, "response", elapsed, resp_target, "breached"))

        # Resolution clock: created → terminal transition, else live to now.
        end = _first_transition_at(c, _TERMINAL)
        if end is None and (c.status.value if c.status else "") in _TERMINAL:
            end = _parse_iso(c.updated_at)
        resolve_target = float(getattr(target, "resolve_minutes", 0) or 0)
        if resolve_target > 0:
            elapsed = ((end or now) - start).total_seconds() / 60.0
            if end is None:  # still open → live clock
                if elapsed > resolve_target:
                    resolve_breached += 1
                    breaching.append(_breach_row(c, "resolution", elapsed, resolve_target, "breached"))
                elif elapsed >= resolve_target * AT_RISK_FRACTION:
                    resolve_at_risk += 1
                    breaching.append(_breach_row(c, "resolution", elapsed, resolve_target, "at_risk"))
            elif elapsed > resolve_target:  # resolved, but late
                resolve_breached += 1
                breaching.append(_breach_row(c, "resolution", elapsed, resolve_target, "breached"))

    met = evaluated - len({b["case_id"] for b in breaching if b["state"] == "breached"})
    return {
        "enabled": True,
        "evaluated": evaluated,
        "response_breached": response_breached,
        "response_at_risk": response_at_risk,
        "resolve_breached": resolve_breached,
        "resolve_at_risk": resolve_at_risk,
        "attainment_pct": round(100.0 * met / evaluated, 1) if evaluated else 0.0,
        "breaching": sorted(breaching, key=lambda b: -b["over_pct"])[:25],
    }


def _breach_row(case: Case, clock: str, elapsed: float, target: float, state: str) -> dict[str, Any]:
    return {
        "case_id": case.case_id,
        "case_number": case.case_number or case.case_id,
        "priority": case.priority_level or "",
        "clock": clock,
        "state": state,
        "elapsed_minutes": round(elapsed, 1),
        "target_minutes": round(target, 1),
        "over_pct": round(100.0 * (elapsed - target) / target, 1) if target else 0.0,
    }


def _window_filter(cases: list[Case], *, window_hours: int, now: datetime | None = None) -> list[Case]:
    """Cases created within the last ``window_hours`` (0/negative → no filter)."""
    if window_hours <= 0:
        return list(cases)
    now = now or datetime.now(timezone.utc)
    cutoff = now.timestamp() - window_hours * 3600.0
    out: list[Case] = []
    for c in cases:
        start = _created_dt(c)
        if start is None or start.timestamp() >= cutoff:
            out.append(c)
    return out


def _delta_pct(value: Any, prev: Any) -> Any:
    """Period-over-period delta% for two numeric metric values. DASH-safe: a DASH or
    non-numeric on either side yields a DASH (we can't compute a delta on a gap)."""
    if not isinstance(value, (int, float)) or not isinstance(prev, (int, float)):
        return DASH
    if prev == 0:
        return DASH if value == 0 else None  # None == "new / undefined growth"
    return round(100.0 * (value - prev) / prev, 1)


def _compare_block(curr: Any, prev: Any) -> dict[str, Any]:
    return {"value": curr, "prev": prev, "delta_pct": _delta_pct(curr, prev)}


def posture_metrics(
    cases: list[Case],
    *,
    sla_policy: Any = None,
    window_hours: int = 24,
    compare: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    """The rich security-posture rollup: lifecycle + quality + aging + SLA + a few
    period-over-period headline comparisons. Pure + deterministic; advisory only (#3).

    ``cases`` is the FULL (already store-bounded) set; this function time-bounds it to
    ``window_hours`` internally. When ``compare == 'prev'`` it also computes the
    immediately-preceding equal-length window for delta% on the headline numbers."""
    now = now or datetime.now(timezone.utc)
    window_hours = max(0, int(window_hours))

    current = _window_filter(cases, window_hours=window_hours, now=now)
    lifecycle = lifecycle_intervals(current)
    quality = quality_metrics(current)
    age = aging(current, now=now)
    sla = sla_metrics(current, sla_policy, now=now)

    rollup: dict[str, Any] = {
        "window_hours": window_hours,
        "generated_at": now.isoformat(),
        "case_count": len(current),
        "lifecycle": lifecycle,
        "quality": quality,
        "aging": age,
        "sla": sla,
    }

    if compare == "prev" and window_hours > 0:
        prev_end = now.timestamp() - window_hours * 3600.0
        prev_window = [
            c
            for c in cases
            if (s := _created_dt(c)) is not None
            and prev_end - window_hours * 3600.0 <= s.timestamp() < prev_end
        ]
        prev_quality = quality_metrics(prev_window)
        prev_life = lifecycle_intervals(prev_window)
        rollup["compare"] = {
            "mode": "prev",
            "case_count": _compare_block(len(current), len(prev_window)),
            "alert_to_incident_ratio": _compare_block(
                quality["alert_to_incident_ratio"], prev_quality["alert_to_incident_ratio"]
            ),
            "false_positive_rate": _compare_block(
                quality["false_positive_rate"], prev_quality["false_positive_rate"]
            ),
            "escalation_rate": _compare_block(
                quality["escalation_rate"], prev_quality["escalation_rate"]
            ),
            "automation_rate": _compare_block(
                quality["automation_rate"], prev_quality["automation_rate"]
            ),
            "mttr_p50": _compare_block(
                lifecycle["mttr_minutes"]["p50"], prev_life["mttr_minutes"]["p50"]
            ),
            "mtta_p50": _compare_block(
                lifecycle["mtta_minutes"]["p50"], prev_life["mtta_minutes"]["p50"]
            ),
        }

    return rollup
