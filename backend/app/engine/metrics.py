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

from ..constants import CaseStatus, Verdict
from ..models import Case


def _parse_iso(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        s = ts.replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return None


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
