"""Adaptive-threshold AUTO-TUNING observer — Round 4 / Wave 3, built SAFE.

A DETERMINISTIC, no-LLM, out-of-the-live-path nightly observer. It reads recently
CLOSED cases, computes a PER-RULE false-positive rate, and — when a rule is
*genuinely* noisy — proposes a SMALL, BOUNDED threshold change so tomorrow's poll
produces less noise. It NEVER decides a case: it only moves detection *volume* knobs
that the pipeline already reads live.

WHY THIS IS SAFE (the five rails):

1. **Statistics, not a fluke.** Per-rule FP rate uses a WILSON LOWER-BOUND
   (z=1.96) gated by a MIN-SAMPLES floor, so a 3-of-3 coincidence can never trip a
   change. An EWMA volume trend is computed for context (surfaced, never gating).
2. **Bounded knobs only.** The only two changes it can make are: raise a
   ``CorrelationRule.n`` by ≤ ``max_n_step`` (default 1), or raise a feed's
   ``severity_floor`` by 1 (max 6). Both merely REDUCE future auto-forward volume;
   neither drops an event (#4 never-drop) and neither is a cluster-signature input (#4
   idempotency key stays byte-identical — the tuner never recomputes it).
3. **Independent labels.** Model verdicts and automatic dispositions never train the
   tuner. The denominator is built only from the latest valid analyst feedback or an
   explicit analyst classification action, so the system cannot grade itself.
4. **Review-first blast radius.** Bounded n/floor raises enter the existing HITL
   :class:`app.models.Proposal` queue by default. A tenant may explicitly opt into
   automatic application, but only after the independent-label floor is met, with a
   before/after AUDIT (``ActionType.TUNING``) and stored rollback token. A suppression
   DROP is never applied automatically.
5. **Shadow-eval.** Before either approval routing or an explicitly enabled automatic
   application, the proposed threshold is replayed over the same window. If it would
   have hidden even one analyst-confirmed TRUE_POSITIVE, it is forced to human review.
6. **Config-writer only.** An approved or explicitly permitted change mutates ``CorrelationRule.n`` /
   ``IndexPattern.severity_floor`` in ``Preferences`` through an injected writer
   callback. ``correlate()`` reads ``cfg.n`` live and the connector reads
   ``severity_floor`` live on the next poll — NO pipeline change.

HARD BOUNDARY (enforced structurally + by a source-text guard test): this module NEVER
imports the case-manager module / invokes the close-decision function; NEVER sets a case
status/disposition; NEVER reads or modifies risk weights; NEVER recomputes/alters the #4
cluster-signature idempotency key (it only moves detection-volume knobs). Observation
is enabled by the smart-autopilot defaults; automatic application remains disabled
unless ``prefs.threshold_tuning.auto_apply_confirmed`` is explicitly enabled.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from ..config import Preferences
from ..constants import ActionType, TERMINAL_CASE_STATUSES
from ..models import Case, Proposal
from ..stores.tuning import TuningRecord, TuningStore
from ..utils import now_utc
from .analyst_outcomes import analyst_confirmed_outcome as _analyst_outcome

logger = logging.getLogger("tlsoc.engine.threshold_tuner")

# The cadences that make :func:`run_once` actually run when called by a scheduler.
# ``manual`` also runs (an operator explicitly triggered it); the caller owns the
# schedule — this is only a sanity gate so an unknown cadence never silently no-ops.
_RUN_CADENCES = {"hourly", "nightly", "weekly", "manual"}

# How many days of closed cases the window covers per cadence (the trailing read
# window). Deliberately generous so min-samples is reachable; the caller may override.
_WINDOW_DAYS = {"hourly": 7, "nightly": 14, "weekly": 30, "manual": 14}

# The absolute ceiling for a feed severity_floor (OCSF severity_id 1..6).
_SEVERITY_FLOOR_MAX = 6
_SEVERITY_FLOOR_MIN = 1


def tuning_window_start(cadence: str, *, now: datetime | None = None) -> datetime:
    """Return the evidence/guard window shared by every tuning entry point.

    The background worker, read-only preview, and explicit per-rule apply must all
    agree on whether a threshold was already changed for the current evidence
    window.  Keeping the calculation here prevents the API from recommending a
    second bump that :func:`run_once` would correctly suppress.
    """
    clock = now or now_utc()
    return clock - timedelta(days=_WINDOW_DAYS.get(str(cadence or "nightly"), 14))


# --------------------------------------------------------------------------- #
# Pure statistics
# --------------------------------------------------------------------------- #
def wilson_lower_bound(successes: int, n: int, *, z: float = 1.96) -> float:
    """Wilson score interval LOWER bound for a binomial proportion.

    ``successes`` FP closes out of ``n`` verdicted closes. The lower bound is the
    conservative FP-rate estimate: with few samples it is pulled well below the naive
    ``successes/n`` so a 3-of-3 (naive 1.0) fluke yields a modest lower bound and does
    NOT clear a target. Returns 0.0 for ``n <= 0``. Pure + deterministic."""
    if n <= 0:
        return 0.0
    phat = successes / n
    z2 = z * z
    denom = 1.0 + z2 / n
    centre = phat + z2 / (2 * n)
    margin = z * math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)
    lb = (centre - margin) / denom
    return max(0.0, min(1.0, lb))


def ewma(values: list[float], alpha: float) -> float | None:
    """Exponentially-weighted moving average (most-recent-last). Returns None for an
    empty list. Used only as an advisory volume-trend signal (never gates a change)."""
    if not values:
        return None
    acc = values[0]
    for v in values[1:]:
        acc = alpha * v + (1 - alpha) * acc
    return acc


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
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        return _parse_iso(value)
    return None


def _case_closed_at(case: Case) -> datetime | None:
    """Best-effort close instant: the resolved/closed anchor, else last status-history
    entry, else updated_at. Read-only coercion (mirrors metrics._as_dt)."""
    for attr in ("resolved_at", "closed_at"):
        dt = _as_dt(getattr(case, attr, None))
        if dt is not None:
            return dt
    history = getattr(case, "status_history", None) or []
    if history:
        last = history[-1]
        dt = _as_dt(getattr(last, "at", None) or (last.get("at") if isinstance(last, dict) else None))
        if dt is not None:
            return dt
    return _as_dt(getattr(case, "updated_at", None))


def normalize_rule_id(value: Any) -> str:
    """Canonical rule key used by statistics, proposals, ledgers and config writes."""
    return str(value or "").strip()


def _is_fp(case: Case) -> bool:
    return _analyst_outcome(case)[0] == "false_positive"


def _is_confirmed_tp(case: Case) -> bool:
    return _analyst_outcome(case)[0] == "true_positive"


# --------------------------------------------------------------------------- #
# Per-rule statistics
# --------------------------------------------------------------------------- #
@dataclass
class RuleStat:
    """The observed close-quality of ONE detection rule over the window."""

    rule_id: str
    observed: int = 0         # terminal cases keyed on this rule
    total: int = 0            # independently analyst-labelled cases
    fp: int = 0               # confirmed benign / false-positive outcomes
    tp: int = 0               # confirmed malicious / true-positive outcomes
    unconfirmed: int = 0      # observed cases excluded from training
    feedback_labels: int = 0
    disposition_labels: int = 0
    fp_lower_bound: float = 0.0
    volume_ewma: float | None = None
    daily_counts: list[float] = field(default_factory=list)


def _accumulate_rule_stats(cases: list[Case], *, ewma_alpha: float, z: float) -> dict[str, RuleStat]:
    """Tally per-rule outcomes using independent analyst evidence only.

    Every terminal case contributes to observed volume. A case contributes to the
    FP/TP denominator only when ``_analyst_outcome`` finds usable human evidence.
    This keeps unlabeled/model-only cases visible without using them to train the
    same automation that produced their verdict or disposition.
    """
    stats: dict[str, RuleStat] = {}
    per_rule_days: dict[str, dict[str, int]] = {}
    for case in cases:
        outcome, evidence_source = _analyst_outcome(case)
        closed = _case_closed_at(case)
        day_key = closed.strftime("%Y-%m-%d") if closed else "unknown"
        canonical_rule_ids = dict.fromkeys(
            normalize_rule_id(raw) for raw in (case.rule_ids or [])
        )
        for rid in canonical_rule_ids:
            if not rid:
                continue
            st = stats.get(rid)
            if st is None:
                st = RuleStat(rule_id=rid)
                stats[rid] = st
                per_rule_days[rid] = {}
            st.observed += 1
            if outcome is None:
                st.unconfirmed += 1
            else:
                st.total += 1
            if outcome == "false_positive":
                st.fp += 1
            if outcome == "true_positive":
                st.tp += 1
            if evidence_source == "analyst_feedback":
                st.feedback_labels += 1
            elif evidence_source == "explicit_analyst_disposition":
                st.disposition_labels += 1
            per_rule_days[rid][day_key] = per_rule_days[rid].get(day_key, 0) + 1
    # Finalise the Wilson LB + EWMA volume trend per rule.
    for rid, st in stats.items():
        st.fp_lower_bound = wilson_lower_bound(st.fp, st.total, z=z)
        days = per_rule_days.get(rid, {})
        ordered = [float(days[k]) for k in sorted(days) if k != "unknown"]
        st.daily_counts = ordered
        st.volume_ewma = ewma(ordered, ewma_alpha)
    return stats


# --------------------------------------------------------------------------- #
# The tuning proposals (pure) → applied/queued by run_once
# --------------------------------------------------------------------------- #
@dataclass
class TuningProposal:
    """A pure, pre-flight proposed change for one rule. ``kind`` decides the route:
    ``correlation_n`` / ``severity_floor`` are bounded review candidates (automatic
    application requires explicit policy plus shadow evaluation); ``evidence_collection``
    and ``suppression`` are always human-review proposals and never mutate a threshold."""

    rule_id: str
    kind: str  # correlation_n | severity_floor | evidence_collection | suppression
    before: int
    after: int
    stat: RuleStat
    feed_key: str | None = None      # for severity_floor: "<source_id>:<feed_id>"
    source_id: str | None = None
    feed_id: str | None = None


@dataclass
class TuningOutcome:
    """The result of a :func:`run_once` pass (all deterministic, for the UI/tests)."""

    ran: bool = False
    reason: str = ""
    rule_stats: dict[str, RuleStat] = field(default_factory=dict)
    auto_applied: list[TuningRecord] = field(default_factory=list)
    proposals: list[Proposal] = field(default_factory=list)
    shadow_blocked: list[str] = field(default_factory=list)   # rule_ids forced to review
    persistence_errors: list[str] = field(default_factory=list)


# The config-writer callback: given the current prefs + a proposal, RETURN a new
# Preferences with the single bounded change applied. Returning None means "the writer
# refused / could not apply" → the tuner falls back to a Proposal. It is injected so
# the tuner never reaches into AppState and stays trivially testable.
ConfigWriter = Callable[[Preferences, TuningProposal], "Preferences | None"]
PrefsMutator = Callable[
    [Callable[[Preferences], Preferences]],
    Awaitable[Preferences] | Preferences,
]


def apply_correlation_n(prefs: Preferences, prop: TuningProposal) -> Preferences | None:
    """Default config-writer for a ``correlation_n`` raise. Sets
    ``correlation_rules[rule_id].n = after`` (materialising the rule from the effective
    correlation config when absent) and returns a NEW Preferences. Never mutates the
    passed-in prefs in place. Returns None if the rule id is empty."""
    rid = normalize_rule_id(prop.rule_id)
    if not rid or prop.after <= prop.before:
        return None
    # Collapse cosmetically different persisted keys onto the same canonical id so
    # ``rule`` and `` rule `` can never become separately tuned configuration rows.
    rules = {
        normalize_rule_id(key): value
        for key, value in prefs.correlation_rules.items()
        if normalize_rule_id(key)
    }
    base = rules.get(rid) or prefs.correlation_for(rid)
    rules[rid] = base.model_copy(update={"n": int(prop.after)})
    return prefs.model_copy(update={"correlation_rules": rules})


def apply_severity_floor(prefs: Preferences, prop: TuningProposal) -> Preferences | None:
    """Default config-writer for a feed ``severity_floor`` raise. Finds the source +
    feed by id and rewrites that feed's ``severity_floor`` inside
    ``source.config['index_patterns']``, returning a NEW Preferences. Returns None if
    the source/feed can't be located (→ the tuner falls back to a Proposal)."""
    if not prop.source_id or prop.after <= prop.before:
        return None
    sources = list(prefs.sources)
    for si_idx, src in enumerate(sources):
        if src.id != prop.source_id:
            continue
        raw_patterns = src.config.get("index_patterns")
        if not isinstance(raw_patterns, list):
            return None
        new_patterns: list[Any] = []
        found = False
        for item in raw_patterns:
            if isinstance(item, dict):
                # Match by explicit feed id, else the slug of the pattern (feeds()
                # derive their id lazily as slug(pattern)).
                item_id = str(item.get("id") or "")
                pat = str(item.get("pattern") or "")
                if item_id == prop.feed_id or (not item_id and _slug(pat) == prop.feed_id) or pat == prop.feed_id:
                    updated = dict(item)
                    updated["severity_floor"] = int(prop.after)
                    new_patterns.append(updated)
                    found = True
                    continue
            new_patterns.append(item)
        if not found:
            return None
        new_config = dict(src.config)
        new_config["index_patterns"] = new_patterns
        sources[si_idx] = src.model_copy(update={"config": new_config})
        return prefs.model_copy(update={"sources": sources})
    return None


def _current_feed_floor(
    prefs: Preferences,
    source_id: str | None,
    feed_id: str | None,
) -> int | None:
    """Return the exact live feed floor used by an approval staleness check."""
    if not source_id or not feed_id:
        return None
    for src in prefs.sources:
        if src.id != source_id:
            continue
        try:
            for feed in src.feeds():
                if (feed.id or _slug(feed.pattern)) == feed_id or feed.pattern == feed_id:
                    return int(feed.severity_floor or _SEVERITY_FLOOR_MIN)
        except Exception:  # noqa: BLE001 — malformed source is an unresolved target
            return None
    return None


def _apply_pending_auto_changes(
    prefs: Preferences,
    pending: list[tuple[TuningProposal, TuningRecord]],
    writers: dict[str, ConfigWriter],
) -> Preferences:
    """Apply a pass's bounded auto-changes to the freshest Preferences document.

    The scheduler may have derived its recommendations from an older snapshot while an
    operator changed another settings block. Replaying only the pending tuning deltas
    inside :meth:`AppState.mutate_prefs` preserves unrelated edits. The live tuning
    policy and exact target value are revalidated under that same lock; a concurrent
    edit to the tuned knob aborts instead of being overwritten.
    """
    cfg = getattr(prefs, "threshold_tuning", None)
    if (
        cfg is None
        or not cfg.enabled
        or not bool(cfg.auto_apply_confirmed)
        or not bool(cfg.shadow_eval)
    ):
        raise ValueError("automatic tuning policy changed before persistence")

    current = prefs
    for prop, _record in pending:
        if prop.kind == "correlation_n":
            rid = normalize_rule_id(prop.rule_id)
            live_before = int(current.correlation_for(rid).n)
            max_step = int(cfg.max_n_step)
            if max_step <= 0 or prop.after - prop.before > max_step:
                raise ValueError("automatic tuning step exceeds current policy")
        elif prop.kind == "severity_floor":
            exact = _current_feed_floor(current, prop.source_id, prop.feed_id)
            live_before = exact if exact is not None else -1
            if prop.after - prop.before != 1 or prop.after > _SEVERITY_FLOOR_MAX:
                raise ValueError("automatic severity-floor step exceeds current policy")
        else:
            raise ValueError(f"unsupported automatic tuning target {prop.kind!r}")
        if live_before != prop.before:
            raise ValueError("automatic tuning recommendation became stale")
        writer = writers.get(prop.kind)
        updated = writer(current, prop) if writer is not None else None
        if updated is None:
            raise ValueError("automatic tuning target no longer exists")
        current = updated
    return current


def _restore_pending_auto_changes(
    prefs: Preferences,
    pending: list[tuple[TuningProposal, TuningRecord]],
    writers: dict[str, ConfigWriter],
) -> Preferences:
    """Compensate a just-written automatic pass without clobbering other settings.

    This is used only when the strict rollback-ledger append could not be confirmed.
    Every exact target must still equal the value this pass wrote; an operator edit to
    the same knob makes compensation fail closed instead of being overwritten.
    """
    current = prefs
    for prop, record in reversed(pending):
        if prop.kind == "correlation_n":
            rid = normalize_rule_id(prop.rule_id)
            live = int(current.correlation_for(rid).n)
        elif prop.kind == "severity_floor":
            exact = _current_feed_floor(current, prop.source_id, prop.feed_id)
            live = exact if exact is not None else -1
        else:  # pragma: no cover - pending only carries supported bounded targets
            raise ValueError(f"unsupported automatic tuning target {prop.kind!r}")
        if live == record.before:
            continue  # an earlier retry already compensated this exact change
        if live != record.after:
            raise ValueError("automatic tuning compensation target became stale")
        reverse = TuningProposal(
            rule_id=prop.rule_id,
            kind=prop.kind,
            before=record.after,
            after=record.before,
            stat=prop.stat,
            feed_key=prop.feed_key,
            source_id=prop.source_id,
            feed_id=prop.feed_id,
        )
        restored = _apply_rollback(writers.get(prop.kind), current, reverse)  # type: ignore[arg-type]
        if restored is None:
            raise ValueError("automatic tuning compensation target no longer exists")
        current = restored
    return current


async def _commit_pending_auto_changes(
    *,
    pending: list[tuple[TuningProposal, TuningRecord]],
    current_prefs: Preferences,
    tuning_store: TuningStore,
    write_prefs: Callable[[Preferences], Awaitable[Preferences] | Preferences],
    mutate_prefs: PrefsMutator | None,
    writers: dict[str, ConfigWriter],
) -> None:
    """Write automatic changes only with durable rollback provenance.

    Preferences and the tuning ledger live in separate backend-agnostic KV documents,
    so there is no cross-document transaction. This small saga applies the exact
    bounded deltas, appends every ledger row in one strict CAS write, and compensates
    the exact deltas if that append cannot be confirmed. It never reports success for
    an untracked threshold.
    """
    if not pending:
        return
    if mutate_prefs is not None:
        result = mutate_prefs(
            lambda latest: _apply_pending_auto_changes(latest, pending, writers)
        )
    else:
        result = write_prefs(current_prefs)
    if hasattr(result, "__await__"):
        await result  # type: ignore[misc]

    try:
        await tuning_store.add_many_strict([record for _prop, record in pending])
    except Exception as ledger_exc:
        try:
            if mutate_prefs is not None:
                compensation = mutate_prefs(
                    lambda latest: _restore_pending_auto_changes(
                        latest, pending, writers
                    )
                )
            else:
                compensation = write_prefs(
                    _restore_pending_auto_changes(current_prefs, pending, writers)
                )
            if hasattr(compensation, "__await__"):
                await compensation  # type: ignore[misc]
        except Exception as compensation_exc:
            raise RuntimeError(
                "automatic tuning ledger persistence failed after the config write, "
                "and exact compensation could not be confirmed; operator review required"
            ) from compensation_exc
        raise RuntimeError(
            "automatic tuning ledger persistence failed; the threshold change was reverted"
        ) from ledger_exc


def _slug(text: str) -> str:
    """Deterministic slug matching IndexPattern's lazy id derivation (lowercase,
    non-alphanumerics → '-'). Kept local so we don't import config internals."""
    out = []
    for ch in text.lower():
        out.append(ch if ch.isalnum() else "-")
    slug = "".join(out).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug or "feed"


# --------------------------------------------------------------------------- #
# Shadow-eval — would the proposed threshold have hidden a confirmed TP?
# --------------------------------------------------------------------------- #
def shadow_eval_hides_true_positive(prop: TuningProposal, cases: list[Case]) -> bool:
    """Replay the proposed threshold over the window's cases for this rule and return
    True if it would have HIDDEN even one confirmed TRUE_POSITIVE.

    We can't perfectly re-cluster historical raw events (they may be gone), so we use
    a CONSERVATIVE proxy that ERRS TOWARD BLOCKING an auto-apply:

    * ``correlation_n`` — a raise means a cluster now needs MORE members to fire.
      A confirmed-TP case whose observed member count (``count`` / len(member_event_ids))
      is BELOW the new ``n`` would no longer auto-form → treat as hidden. Missing count
      info → treat as hidden (conservative).
    * ``severity_floor`` — a raise means events at/below the new floor no longer
      auto-forward. A confirmed-TP case whose asserted severity is BELOW the new floor
      would no longer forward → treat as hidden. Missing severity → treat as hidden.

    Pure + deterministic; consults ONLY the case's own fields (never risk / the close
    decision)."""
    for case in cases:
        if not _is_confirmed_tp(case):
            continue
        if normalize_rule_id(prop.rule_id) not in [normalize_rule_id(r) for r in (case.rule_ids or [])]:
            continue
        if prop.kind == "correlation_n":
            observed = _observed_count(case)
            if observed is None or observed < prop.after:
                return True  # would no longer reach the raised threshold
        elif prop.kind == "severity_floor":
            sev = _asserted_severity(case)
            if sev is None or sev < prop.after:
                return True  # would drop below the raised floor
    return False


def _observed_count(case: Case) -> int | None:
    """The member count a cluster fired with, best-effort. Prefer the explicit member
    id list, else a trigger-reason observed_count, else None (unknown → conservative)."""
    ids = getattr(case, "member_event_keys", None) or getattr(case, "member_event_ids", None)
    if ids:
        return len(ids)
    tr = getattr(case, "trigger_reason", None)
    oc = getattr(tr, "observed_count", None) if tr is not None else None
    if isinstance(oc, int) and oc > 0:
        return oc
    return None


def _asserted_severity(case: Case) -> int | None:
    """The OCSF severity_id (1..6) the source asserted for this case, best-effort from
    the trigger reason's severity_max. None when unknown (→ conservative block)."""
    tr = getattr(case, "trigger_reason", None)
    if tr is None:
        return None
    sev = getattr(tr, "severity_max", None)
    try:
        return int(sev) if sev is not None else None
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# Deriving proposals from stats (pure)
# --------------------------------------------------------------------------- #
def derive_proposals(
    prefs: Preferences,
    stats: dict[str, RuleStat],
    *,
    already_tuned: dict[str, int] | None = None,
    already_tuned_floors: set[str] | None = None,
) -> list[TuningProposal]:
    """For each genuinely-noisy rule (Wilson-LB FP-rate > target AND samples >= min),
    derive ONE bounded proposal. Pure — no side effects, no store/prefs writes.

    Preference order for the bounded change:
    1. Raise the matching ``CorrelationRule.n`` by ``max_n_step`` (a low-impact volume
       reduction) — the preferred bounded candidate.
    2. If ``max_n_step`` is 0 (n-tuning disabled) but a feed carries this rule, raise
       that feed's ``severity_floor`` by 1.
    ``already_tuned`` maps rule_id → the n already applied within this
    cadence window. Such a rule is SKIPPED entirely (not re-raised) — the FP-rate is
    computed over the same trailing window of already-closed cases, which does not change
    tick-to-tick, so re-bumping the same rule every tick would grow ``n`` unbounded
    (FINDING #14). One effective bump per rule per cadence; the next window's fresh
    closes decide whether it still needs relief."""
    cfg = prefs.threshold_tuning
    target = float(cfg.fp_rate_target)
    min_samples = int(cfg.min_samples)
    step = int(cfg.max_n_step)
    already_tuned = {
        normalize_rule_id(key): int(value)
        for key, value in (already_tuned or {}).items()
        if normalize_rule_id(key)
    }
    already_tuned_floors = already_tuned_floors or set()
    out: list[TuningProposal] = []

    for rid, st in sorted(stats.items()):
        rid = normalize_rule_id(rid)
        if not rid:
            continue
        # Enough cases exist to investigate the rule, but not enough independent
        # analyst labels exist to estimate quality. Surface an approval work item
        # asking operators to grade cases; do not infer noise from model labels.
        if st.observed >= min_samples and st.total < min_samples:
            current_n = int(prefs.correlation_for(rid).n)
            out.append(TuningProposal(
                rule_id=rid,
                kind="evidence_collection",
                before=current_n,
                after=current_n,
                stat=st,
            ))
            continue
        if st.total < min_samples:
            continue
        if st.fp_lower_bound <= target:
            continue
        # Already auto-tuned this rule within the cadence window → do NOT re-raise it
        # for the SAME noise (bounded to one effective bump per rule per cadence, #14).
        if rid in already_tuned:
            continue
        # Genuinely noisy. Prefer a bounded n raise (off the CURRENT live n, which the
        # prior cycle already persisted — so ``before`` is always the live value).
        if step > 0:
            current_n = prefs.correlation_for(rid).n
            new_n = current_n + step
            out.append(TuningProposal(
                rule_id=rid, kind="correlation_n",
                before=current_n, after=new_n, stat=st,
            ))
            continue
        # n-tuning off → try a feed severity_floor raise for a feed carrying this rule.
        feed = _find_feed_for_rule(prefs, rid)
        if feed is not None:
            source_id, feed_id, cur_floor = feed
            feed_key = f"{source_id}:{feed_id}"
            # Already raised THIS feed's floor this cadence window → do NOT re-raise it
            # for the SAME unchanging noise, else it climbs +1 every run to the max
            # (audit #23). Keyed by feed_key, mirroring the correlation_n guard.
            if feed_key in already_tuned_floors:
                continue
            new_floor = min(_SEVERITY_FLOOR_MAX, (cur_floor or _SEVERITY_FLOOR_MIN) + 1)
            if new_floor > (cur_floor or _SEVERITY_FLOOR_MIN):
                out.append(TuningProposal(
                    rule_id=rid, kind="severity_floor",
                    before=cur_floor or _SEVERITY_FLOOR_MIN, after=new_floor, stat=st,
                    source_id=source_id, feed_id=feed_id,
                    feed_key=feed_key,
                ))
    return out


def _find_feed_for_rule(prefs: Preferences, rule_id: str) -> tuple[str, str, int | None] | None:
    """Find an enabled, non-ignore feed whose query explicitly names ``rule_id``.

    There is deliberately no "first feed" fallback.  A noisy rule without a
    trustworthy rule-to-feed mapping is not authority to raise an unrelated feed's
    severity floor.  The caller may surface the missing mapping for operator repair,
    but it must not manufacture a mutation target.
    """
    for src in sorted(prefs.sources, key=lambda s: s.id):
        try:
            feeds = src.feeds()
        except Exception:  # noqa: BLE001 — a malformed source never breaks tuning
            continue
        for feed in feeds:
            if not feed.enabled:
                continue
            role = getattr(feed.role, "value", str(feed.role))
            if role == "ignore":
                continue
            q = feed.query or ""
            if rule_id and rule_id in q:
                return (src.id, feed.id or _slug(feed.pattern), feed.severity_floor)
    return None


# --------------------------------------------------------------------------- #
# The observer entrypoint
# --------------------------------------------------------------------------- #
CaseReader = Callable[[int, int], Awaitable[list[Case]]]


def terminal_case_reader(case_store: Any) -> CaseReader:
    """Build one logical ``(limit, offset)`` pager across both terminal statuses.

    Each status remains a separate repository query, but the caller observes one
    concatenated sequence.  The offset is consumed across status totals and every
    returned page is capped at ``limit``; this prevents the former 500+500 first page
    from advancing the tuner by 1,000 and skipping the remaining rows in both sets.
    """

    async def _read(limit: int, offset: int) -> list[Case]:
        remaining = max(1, int(limit or 1))
        logical_offset = max(0, int(offset or 0))
        collected: list[Case] = []
        for status in TERMINAL_CASE_STATUSES:
            status_offset = logical_offset
            while remaining > 0:
                try:
                    page, total = await case_store.list(
                        status=status,
                        limit=remaining,
                        offset=status_offset,
                        sort_field="updated_at",
                        sort_order="desc",
                    )
                except Exception as exc:  # noqa: BLE001 — incomplete evidence must abort
                    # A partial CLOSED/RESOLVED window can bias the FP denominator and
                    # shadow-evaluation. Fail this pass explicitly so the scheduler
                    # reports the outage and retries; never reinterpret unavailable
                    # terminal rows as an empty status partition.
                    raise RuntimeError(
                        f"terminal case read failed for status {status}"
                    ) from exc
                total = max(0, int(total or 0))
                if status_offset >= total:
                    logical_offset = max(0, logical_offset - total)
                    break
                logical_offset = 0
                if not page:
                    break
                accepted = list(page[:remaining])
                collected.extend(accepted)
                consumed = len(accepted)
                remaining -= consumed
                status_offset += consumed
                if consumed == 0 or status_offset >= total:
                    break
            if remaining <= 0:
                break
        return collected

    return _read


async def _read_window(
    cases: "list[Case] | CaseReader",
    *,
    window_start: datetime,
    page_size: int,
) -> list[Case]:
    """Materialise the trailing-window closed cases.

    ``cases`` may be a pre-fetched list (tests / small tenants) OR an async paging
    reader ``read(limit, offset) -> list[Case]`` we page until a short/empty page — so
    a busy tenant is NOT capped at a naive 200 (a whole point of the assignment). We
    filter to the window here (belt-and-braces even if the reader already scopes)."""
    if callable(cases):
        collected: list[Case] = []
        offset = 0
        # Hard upper bound on pages so a misbehaving reader can't loop forever, but
        # generous enough (200 pages × page_size) to far exceed the 200-cap.
        for _ in range(200):
            page = await cases(page_size, offset)
            if not page:
                break
            collected.extend(page)
            offset += len(page)
            if len(page) < page_size:
                break
        raw = collected
    else:
        raw = list(cases)
    out: list[Case] = []
    for c in raw:
        closed = _case_closed_at(c)
        if closed is None or closed >= window_start:
            out.append(c)
    return out


def tuning_guards_from_records(
    records: list[TuningRecord], window_start: datetime,
) -> tuple[dict[str, int], set[str]]:
    """Project the once-per-window guards from one confirmed ledger snapshot.

    This pure projection is shared by the scheduler and both API entry points.  The
    caller owns persistence semantics: mutation/preview boundaries use
    :meth:`TuningStore.list_strict` so an outage can never masquerade as "nothing has
    been tuned yet".
    """
    out: dict[str, int] = {}
    floors: set[str] = set()
    for rec in records:
        if bool(getattr(rec, "rolled_back", False)):
            continue
        applied = _parse_iso(getattr(rec, "applied_at", None))
        if applied is None or applied < window_start:
            continue
        if getattr(rec, "target", None) != "correlation_n":
            if getattr(rec, "target", None) == "severity_floor":
                # feed_key is stored as rule_id for severity-floor records.
                feed_key = str(getattr(rec, "rule_id", "") or "").strip()
                if feed_key:
                    floors.add(feed_key)
            continue
        rid = normalize_rule_id(getattr(rec, "rule_id", ""))
        if rid:
            # Keep the highest threshold already reached in this window.
            out[rid] = max(out.get(rid, 0), int(getattr(rec, "after", 0) or 0))
    return out, floors


async def run_once(
    prefs: Preferences,
    cases: "list[Case] | CaseReader",
    proposals: Any,           # ProposalStore (duck-typed .add)
    audit: Any,               # AuditLogger (duck-typed .record) — may be None
    *,
    tuning_store: TuningStore,
    write_prefs: Callable[[Preferences], Awaitable[Preferences] | Preferences],
    mutate_prefs: PrefsMutator | None = None,
    config_writers: dict[str, ConfigWriter] | None = None,
    now: datetime | None = None,
    page_size: int = 500,
) -> TuningOutcome:
    """Run ONE deterministic tuning pass. Returns a :class:`TuningOutcome` (always).

    ``cases`` — a pre-fetched closed-case list OR an async ``read(limit, offset)`` pager
      (the caller passes ``cases.list(status=CLOSED, ...)`` paged; the tuner pages it,
      never a naive 200-cap).
    ``proposals`` — the ProposalStore for evidence, threshold, suppression, and
      shadow-blocked review work.
    ``audit`` — the AuditLogger (before/after ``ActionType.TUNING`` records). Optional.
    ``tuning_store`` — records applied changes + provenance and rollback tokens.
    ``write_prefs`` — compatibility writer used by isolated/unit callers.
    ``mutate_prefs`` — preferred atomic read/transform/write seam. Production binds
      ``AppState.mutate_execution_prefs`` so unrelated concurrent preference edits
      survive and the tuned target is revalidated under the same lock.
    ``config_writers`` — kind→writer overrides (defaults apply n / severity_floor).

    NEVER raises into the caller — any failure degrades to "no tuning" (fail-safe).
    Disabled config → an immediate no-op outcome (today's behaviour byte-identical)."""
    outcome = TuningOutcome()
    try:
        cfg = getattr(prefs, "threshold_tuning", None)
        if cfg is None or not cfg.enabled:
            outcome.reason = "disabled"
            return outcome
        if cfg.cadence not in _RUN_CADENCES:
            outcome.reason = f"unknown cadence {cfg.cadence!r}"
            return outcome

        writers = {
            "correlation_n": apply_correlation_n,
            "severity_floor": apply_severity_floor,
            **(config_writers or {}),
        }
        clock = now or now_utc()
        window_start = tuning_window_start(cfg.cadence, now=clock)

        window_cases = await _read_window(cases, window_start=window_start, page_size=page_size)
        stats = _accumulate_rule_stats(window_cases, ewma_alpha=cfg.ewma_alpha, z=cfg.wilson_z)
        outcome.rule_stats = stats
        outcome.ran = True

        # Records created before outcome provenance existed remain visible in the
        # ledger and are also surfaced once in Approvals for operator acknowledgement.
        # This never rolls them back or rewrites live configuration automatically.
        await _queue_historical_reviews(tuning_store, proposals, audit, outcome)
        if outcome.persistence_errors:
            outcome.reason = "proposal persistence failed; scheduler retry required"
            return outcome

        # Build both guards from one strict, coherent ledger snapshot.  If the ledger
        # cannot prove what already changed, fail this pass rather than risk a second
        # bump over the same evidence window.
        guard_records = await tuning_store.list_strict(active_only=True)
        already_tuned, already_tuned_floors = tuning_guards_from_records(
            guard_records, window_start
        )

        proposals_to_make = derive_proposals(
            prefs, stats, already_tuned=already_tuned,
            already_tuned_floors=already_tuned_floors,
        )
        if not proposals_to_make:
            outcome.reason = (
                "historical tuning changes awaiting review"
                if outcome.proposals
                else "no noisy rule cleared the bar"
            )
            return outcome

        # Apply / queue each proposal against a RUNNING prefs so multiple auto-applies
        # in one pass compose (each writer returns a fresh Preferences). ``current_prefs``
        # is the single source of truth threaded through — no smuggling via the outcome.
        # The ledger + audit for each auto-apply are DEFERRED (collected in ``pending``)
        # and only recorded AFTER ``write_prefs`` is confirmed, so a swallowed write
        # failure never leaves a false 'applied/reversible' ledger+audit and never blocks
        # re-tuning the still-noisy rule (audit #24).
        current_prefs = prefs
        pending: list[tuple[TuningProposal, TuningRecord]] = []
        for prop in proposals_to_make:
            try:
                current_prefs, rec = await _handle_proposal(
                    prop, current_prefs, window_cases, cfg,
                    proposals=proposals, audit=audit, tuning_store=tuning_store,
                    writers=writers, outcome=outcome,
                )
                if rec is not None:
                    pending.append((prop, rec))
            except Exception as exc:  # noqa: BLE001 — one bad rule never breaks the pass
                logger.warning("tuning proposal for %s failed: %s", prop.rule_id, exc)

        # A review item is part of the pass's durable result. If its store did not
        # confirm the write, do not continue to an unrelated config mutation or stamp
        # scheduler success; the next tick will retry and add_unique will deduplicate
        # any rows that did land.
        if outcome.persistence_errors:
            outcome.reason = "proposal persistence failed; scheduler retry required"
            return outcome

        # Persist the accumulated prefs change and its rollback provenance as one
        # recoverable saga. A strict ledger failure compensates the exact config deltas
        # and makes the scheduler unhealthy/retryable; it can never be reported as a
        # successful but untracked threshold change.
        if pending:
            try:
                await _commit_pending_auto_changes(
                    pending=pending,
                    current_prefs=current_prefs,
                    tuning_store=tuning_store,
                    write_prefs=write_prefs,
                    mutate_prefs=mutate_prefs,
                    writers=writers,
                )
            except Exception as exc:  # noqa: BLE001 — no untracked success is allowed
                logger.warning(
                    "tuning automatic commit failed for %d change(s): %s",
                    len(pending), exc,
                )
                outcome.persistence_errors.append(
                    "automatic tuning config and rollback ledger were not both confirmed"
                )
                outcome.reason = f"automatic tuning commit failed: {exc}"
                return outcome
            for prop, rec in pending:
                outcome.auto_applied.append(rec)
                await _audit_tuning(audit, prop, rec)
        return outcome
    except Exception as exc:  # noqa: BLE001 — the observer must NEVER break a caller
        logger.warning("threshold_tuner.run_once failed: %s", exc)
        outcome.reason = f"error: {exc}"
        return outcome


async def _handle_proposal(
    prop: TuningProposal,
    prefs: Preferences,
    window_cases: list[Case],
    cfg: Any,
    *,
    proposals: Any,
    audit: Any,
    tuning_store: TuningStore,
    writers: dict[str, ConfigWriter],
    outcome: TuningOutcome,
) -> tuple[Preferences, TuningRecord | None]:
    """Route ONE proposal: open review work by default, or apply a bounded n/floor
    raise only when explicit policy and shadow evaluation permit it.

    Returns ``(running_prefs, pending_record)``. The caller threads the prefs into the
    next proposal so multiple auto-applies in one pass compose; ``pending_record`` is the
    ledger record for an auto-apply that must be persisted ONLY AFTER ``write_prefs``
    succeeds (audit #24) — it is ``None`` for a queued/blocked proposal (which does its own
    HITL Proposal write and makes no 'applied' claim)."""
    if prop.kind == "evidence_collection":
        await _open_proposal(prop, proposals, audit, outcome, reason="insufficient_analyst_evidence")
        return prefs, None

    # A suppression DROP is NEVER auto-applied — always HITL.
    if prop.kind == "suppression":
        await _open_proposal(prop, proposals, audit, outcome, reason="suppression_drop")
        return prefs, None

    # ``model_copy(update=...)`` can bypass Pydantic validation. Repeat the critical
    # policy invariant here so even a programmatic/stale config cannot auto-write a
    # threshold without the retrospective true-positive replay.
    if bool(getattr(cfg, "auto_apply_confirmed", False)) and not bool(
        getattr(cfg, "shadow_eval", False)
    ):
        await _open_proposal(
            prop, proposals, audit, outcome, reason="shadow_eval_required"
        )
        return prefs, None

    # SHADOW-EVAL: would the raise have hidden a confirmed TP? If so, force review.
    if cfg.shadow_eval and shadow_eval_hides_true_positive(prop, window_cases):
        outcome.shadow_blocked.append(prop.rule_id)
        await _open_proposal(
            prop, proposals, audit, outcome,
            reason="shadow_eval_would_hide_confirmed_tp",
        )
        return prefs, None

    # Even with enough independent evidence, automatic writes are an explicit
    # tenant policy. The safe default sends the bounded change to Approvals.
    if not bool(getattr(cfg, "auto_apply_confirmed", False)):
        await _open_proposal(prop, proposals, audit, outcome, reason="policy_requires_approval")
        return prefs, None

    # Auto-apply the bounded change via the config-writer (working off the running prefs).
    writer = writers.get(prop.kind)
    new_prefs = writer(prefs, prop) if writer is not None else None
    if new_prefs is None:
        # The writer refused (couldn't locate the target) → HITL fallback (never silent).
        await _open_proposal(prop, proposals, audit, outcome, reason="writer_could_not_apply")
        return prefs, None

    record = TuningRecord(
        rule_id=prop.feed_key or prop.rule_id,
        target=prop.kind,  # type: ignore[arg-type]
        before=prop.before,
        after=prop.after,
        fp_rate=prop.stat.fp_lower_bound,
        samples=prop.stat.total,
        evidence_source="analyst_confirmed",
        rationale=(
            f"rule {prop.rule_id!r} FP-rate(Wilson-LB)={prop.stat.fp_lower_bound:.2f} "
            f"> target={cfg.fp_rate_target} over {prop.stat.total} closed cases; "
            f"{prop.kind} {prop.before}->{prop.after} (auto-applied, reversible)"
        ),
    )
    # NB: the ledger add + outcome append + audit are deferred to run_once, AFTER the
    # prefs write is confirmed — so they never claim an apply that didn't land.
    return new_prefs, record


async def _open_proposal(
    prop: TuningProposal, proposals: Any, audit: Any, outcome: TuningOutcome, *, reason: str,
) -> None:
    """Create a PENDING HITL Proposal for a change that must NOT auto-apply. Mirrors
    ``threshold_automation._create_proposal`` — the operator approves it through the
    existing ``/proposals/{id}/approve`` path (the only live-write route)."""
    expires = (now_utc() + timedelta(days=30)).isoformat()
    rid = normalize_rule_id(prop.rule_id)
    action = "collect_evidence" if prop.kind == "evidence_collection" else "apply_change"
    copy: dict[str, tuple[str, str]] = {
        "insufficient_analyst_evidence": (
            "The rule has enough case volume to inspect, but too few independently "
            "confirmed analyst outcomes to estimate its false-positive rate safely.",
            "Grade or explicitly classify more recent cases for this rule, then run tuning again.",
        ),
        "shadow_eval_would_hide_confirmed_tp": (
            "The proposed threshold would have hidden at least one analyst-confirmed true positive.",
            "Inspect the confirmed case and adjust the rule manually only if the missed detection is acceptable.",
        ),
        "shadow_eval_required": (
            "Automatic threshold writes are enabled, but the required true-positive replay is disabled.",
            "Enable shadow evaluation or keep changes review-only, then run tuning again.",
        ),
        "policy_requires_approval": (
            "Analyst evidence supports a bounded threshold change, but automatic apply is disabled by policy.",
            "Review the evidence and approve this proposal to apply the bounded change.",
        ),
        "writer_could_not_apply": (
            "The target could not be resolved against the current live configuration.",
            "Review the rule or feed mapping, correct it, and regenerate the recommendation.",
        ),
        "suppression_drop": (
            "A suppression-style change always requires explicit human review.",
            "Review the affected scope and approve only if the loss of future signal is acceptable.",
        ),
    }
    reason_text, recommended_action = copy.get(
        reason,
        ("The adaptive tuning recommendation requires human review.", "Review the evidence before applying any change."),
    )
    dedupe_key = (
        f"tuning:v2:{action}:{reason}:{prop.kind}:{rid}:{prop.before}:{prop.after}:"
        f"{prop.stat.observed}:{prop.stat.total}:{prop.stat.fp}:{prop.stat.tp}"
    )
    payload = {
        "tuning": True,
        "action": action,
        "reason_code": reason,
        "reason": reason_text,
        "recommended_action": recommended_action,
        "target": prop.kind,
        "rule_id": rid,
        "before": prop.before,
        "after": prop.after,
        "feed_key": prop.feed_key,
        "source_id": prop.source_id,
        "feed_id": prop.feed_id,
        "fp_rate": round(prop.stat.fp_lower_bound, 4),
        "analyst_samples": prop.stat.total,
        "observed_cases": prop.stat.observed,
        "unconfirmed_cases": prop.stat.unconfirmed,
        "confirmed_false_positives": prop.stat.fp,
        "confirmed_true_positives": prop.stat.tp,
        "evidence_basis": (
            "Latest analyst feedback actual_outcome or explicit analyst disposition action. "
            "Model verdicts and automatic dispositions are excluded."
        ),
        "dedupe_key": dedupe_key,
    }
    if action == "collect_evidence":
        rationale = f"More analyst evidence is required before tuning rule {rid!r}. {reason_text}"
    else:
        rationale = (
            f"Adaptive tuner suggests {prop.kind} {prop.before}->{prop.after} for rule "
            f"{rid!r} using {prop.stat.total} analyst-confirmed outcomes. {reason_text}"
        )
    prop_model = Proposal(
        kind="tuning",
        payload=payload,
        rationale=rationale,
        confidence=0.5,
        source_case_ids=[],
        created_by="tuner",
        expires_at=expires,
    )
    try:
        stored, created = await _persist_proposal_verified(
            proposals, prop_model, dedupe_key
        )
        outcome.proposals.append(stored)
    except Exception as exc:  # noqa: BLE001 — caller reports failure and retries
        logger.warning("tuner proposal add failed for %s: %s", prop.rule_id, exc)
        outcome.persistence_errors.append(
            f"rule {rid or '?'} proposal was not confirmed"
        )
        return
    if created and audit is not None:
        try:
            await audit.record(
                action_type=ActionType.PROPOSAL, surface="tuner", actor="tuner",
                result_summary=(
                    f"tuner drafted review proposal {stored.id} for rule "
                    f"{rid} ({prop.kind} {prop.before}->{prop.after}, {reason})"
                ),
            )
        except Exception as exc:  # noqa: BLE001 — audit is best-effort
            logger.debug("tuner proposal audit failed: %s", exc)


async def _persist_proposal_verified(
    proposals: Any,
    proposal: Proposal,
    dedupe_key: str,
) -> tuple[Proposal, bool]:
    """Persist one proposal and confirm the exact row through a read-back.

    Ordinary ProposalStore drafting is intentionally fail-soft. The tuner cannot use
    its returned object alone as proof because a swallowed KV error would otherwise
    make the scheduler and UI claim review work exists when nothing reached Approvals.
    """
    if hasattr(proposals, "add_unique"):
        stored, created = await proposals.add_unique(proposal, dedupe_key)
    else:
        stored = await proposals.add(proposal)
        created = True
    reader = getattr(proposals, "get", None)
    if not callable(reader):
        raise RuntimeError("proposal store does not support verified read-back")
    confirmed = await reader(stored.id)
    if confirmed is None or confirmed.id != stored.id:
        raise RuntimeError("proposal write was not visible on read-back")
    confirmed_key = str((confirmed.payload or {}).get("dedupe_key") or "")
    if dedupe_key and confirmed_key != dedupe_key:
        raise RuntimeError("proposal read-back did not match the requested dedupe key")
    return confirmed, bool(created)


async def _queue_historical_reviews(
    tuning_store: TuningStore,
    proposals: Any,
    audit: Any,
    outcome: TuningOutcome,
) -> None:
    """Expose active legacy applies in Approvals without changing their state."""
    try:
        strict_reader = getattr(tuning_store, "list_strict", None)
        records = await (
            strict_reader(active_only=True)
            if callable(strict_reader)
            else tuning_store.list(active_only=True)
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("historical tuning review load failed: %s", exc)
        outcome.persistence_errors.append("legacy tuning history could not be loaded")
        return
    for record in records:
        if str(getattr(record, "evidence_source", "") or "") != "legacy_unverified":
            continue
        dedupe_key = f"tuning-history:v1:{record.id}"
        payload = {
            "tuning": True,
            "action": "review_history",
            "reason_code": "historical_auto_apply_review",
            "reason": (
                "This threshold change predates independent analyst-outcome provenance "
                "and needs an operator review."
            ),
            "recommended_action": (
                "Compare the historical change with recent analyst-confirmed outcomes; "
                "keep it or use the explicit rollback control."
            ),
            "rule_id": normalize_rule_id(record.rule_id),
            "target": record.target,
            "before": record.before,
            "after": record.after,
            "fp_rate": round(record.fp_rate, 4),
            "analyst_samples": 0,
            "observed_cases": int(record.samples),
            "unconfirmed_cases": int(record.samples),
            "confirmed_false_positives": 0,
            "confirmed_true_positives": 0,
            "evidence_basis": "Legacy tuning ledger; independent analyst evidence was not recorded.",
            "record_id": record.id,
            "dedupe_key": dedupe_key,
        }
        proposal = Proposal(
            kind="tuning",
            payload=payload,
            rationale=(
                f"Review historical {record.target} change {record.before}->{record.after} "
                f"for {normalize_rule_id(record.rule_id)!r}. No automatic rollback occurs."
            ),
            confidence=0.0,
            created_by="tuner",
        )
        try:
            stored, created = await _persist_proposal_verified(
                proposals, proposal, dedupe_key
            )
            outcome.proposals.append(stored)
        except Exception as exc:  # noqa: BLE001
            logger.warning("historical tuning review add failed for %s: %s", record.id, exc)
            outcome.persistence_errors.append(
                f"historical tuning record {record.id} review was not confirmed"
            )
            continue
        if created and audit is not None:
            try:
                await audit.record(
                    action_type=ActionType.PROPOSAL,
                    surface="tuner",
                    actor="tuner",
                    result_summary=(
                        f"tuner drafted historical review proposal {stored.id} "
                        f"for tuning record {record.id}"
                    ),
                )
            except Exception:  # noqa: BLE001 — audit remains best-effort
                pass


async def queue_legacy_tuning_reviews(
    tuning_store: TuningStore,
    proposals: Any,
    audit: Any = None,
) -> TuningOutcome:
    """Reconcile active pre-provenance tuning records into Approvals immediately.

    This startup-safe helper ONLY drafts deduplicated review-history proposals. It
    never mutates preferences, rolls back a record, or stamps the tuning cadence, so
    an upgrade does not have to wait for the next eligible scheduler pass before the
    historical review work becomes visible.
    """
    outcome = TuningOutcome(ran=True)
    await _queue_historical_reviews(tuning_store, proposals, audit, outcome)
    outcome.reason = (
        "legacy tuning review reconciliation failed"
        if outcome.persistence_errors
        else (
            "legacy tuning review proposals reconciled"
            if outcome.proposals
            else "no legacy tuning reviews required"
        )
    )
    return outcome


def materialize_approved_tuning(
    prefs: Preferences,
    payload: dict[str, Any],
    *,
    proposal_id: str,
    allow_idempotent_replay: bool = False,
) -> tuple[Preferences, TuningRecord | None, bool]:
    """Validate and materialise one approved tuning payload.

    ``review_history`` and ``collect_evidence`` acknowledge work without mutating a
    threshold. ``apply_change`` validates that the recommendation is still current
    and remains within the configured bound before returning a fresh Preferences.
    """
    action = str(payload.get("action") or "")
    if action in {"review_history", "collect_evidence"}:
        return prefs, None, False
    if action != "apply_change":
        raise ValueError("unknown tuning approval action")

    rid = normalize_rule_id(payload.get("rule_id"))
    target = str(payload.get("target") or "")
    if not rid or target not in {"correlation_n", "severity_floor"}:
        raise ValueError("invalid tuning target")
    try:
        before = int(payload.get("before"))
        after = int(payload.get("after"))
    except (TypeError, ValueError) as exc:
        raise ValueError("invalid tuning threshold") from exc
    if after <= before:
        raise ValueError("tuning threshold must increase")
    if target == "correlation_n":
        max_step = int(prefs.threshold_tuning.max_n_step)
        if max_step <= 0 or after - before > max_step:
            raise ValueError("tuning step exceeds current policy")
        live_before = int(prefs.correlation_for(rid).n)
    else:
        if after - before != 1 or after > _SEVERITY_FLOOR_MAX:
            raise ValueError("severity-floor step exceeds current policy")
        exact_floor = _current_feed_floor(
            prefs,
            str(payload.get("source_id") or "") or None,
            str(payload.get("feed_id") or "") or None,
        )
        live_before = exact_floor if exact_floor is not None else -1
    already_applied = bool(allow_idempotent_replay and live_before == after)
    if live_before != before and not already_applied:
        raise ValueError("tuning proposal is stale; live threshold changed")

    stat = RuleStat(
        rule_id=rid,
        observed=int(payload.get("observed_cases") or 0),
        total=int(payload.get("analyst_samples") or 0),
        fp=int(payload.get("confirmed_false_positives") or 0),
        tp=int(payload.get("confirmed_true_positives") or 0),
        unconfirmed=int(payload.get("unconfirmed_cases") or 0),
        fp_lower_bound=float(payload.get("fp_rate") or 0.0),
    )
    prop = TuningProposal(
        rule_id=rid,
        kind=target,
        before=before,
        after=after,
        stat=stat,
        feed_key=(str(payload.get("feed_key") or "") or None),
        source_id=(str(payload.get("source_id") or "") or None),
        feed_id=(str(payload.get("feed_id") or "") or None),
    )
    if already_applied:
        new_prefs = prefs
    else:
        writer = apply_correlation_n if target == "correlation_n" else apply_severity_floor
        new_prefs = writer(prefs, prop)
        if new_prefs is None:
            raise ValueError("tuning target no longer exists")
    record = TuningRecord(
        rule_id=prop.feed_key or rid,
        target=target,  # type: ignore[arg-type]
        before=before,
        after=after,
        fp_rate=stat.fp_lower_bound,
        samples=stat.total,
        evidence_source="analyst_confirmed_approved",
        review_proposal_id=proposal_id,
        rationale=(
            f"Approved proposal {proposal_id}; {stat.total} independently confirmed "
            f"analyst outcomes; {target} {before}->{after}."
        ),
    )
    return new_prefs, record, not already_applied


async def commit_approved_tuning(
    prefs: Preferences,
    payload: dict[str, Any],
    *,
    proposal_id: str,
    tuning_store: TuningStore,
    write_prefs: Callable[[Preferences], Awaitable[Preferences] | Preferences],
    mutate_prefs: PrefsMutator | None = None,
) -> tuple[TuningRecord | None, bool]:
    """Commit one approved tuning effect with durable rollback provenance.

    Approval effects and the ledger are separate KV documents.  Apply against the
    freshest preferences, append by stable ``proposal_id``, and compensate the exact
    threshold delta if the ledger transition cannot be confirmed.  A retry after a
    prior ambiguous finalisation recognises an already-applied threshold and merely
    completes the idempotent ledger append.

    Returns ``(record, created)``; acknowledgement-only tuning work returns
    ``(None, False)`` and never writes preferences.
    """
    preview, preview_record, preview_changed = materialize_approved_tuning(
        prefs,
        payload,
        proposal_id=proposal_id,
        allow_idempotent_replay=True,
    )
    if preview_record is None:
        return None, False

    materialized: dict[str, Any] = {
        "prefs": preview,
        "record": preview_record,
        "changed": preview_changed,
    }

    if mutate_prefs is not None:
        def _apply(latest: Preferences) -> Preferences:
            updated, record, changed = materialize_approved_tuning(
                latest,
                payload,
                proposal_id=proposal_id,
                allow_idempotent_replay=True,
            )
            if record is None:
                raise ValueError("approved tuning change has no rollback record")
            materialized.update({
                "prefs": updated,
                "record": record,
                "changed": changed,
            })
            return updated

        result = mutate_prefs(_apply)
    else:
        result = write_prefs(preview)
    if hasattr(result, "__await__"):
        await result  # type: ignore[misc]

    record = materialized["record"]
    changed = bool(materialized["changed"])
    try:
        persisted, created = await tuning_store.add_approved_proposal_strict(record)
    except Exception as ledger_exc:
        if changed:
            stat = RuleStat(
                rule_id=normalize_rule_id(payload.get("rule_id")),
                observed=int(payload.get("observed_cases") or 0),
                total=int(payload.get("analyst_samples") or 0),
                fp=int(payload.get("confirmed_false_positives") or 0),
                tp=int(payload.get("confirmed_true_positives") or 0),
                unconfirmed=int(payload.get("unconfirmed_cases") or 0),
                fp_lower_bound=float(payload.get("fp_rate") or 0.0),
            )
            prop = TuningProposal(
                rule_id=stat.rule_id,
                kind=record.target,
                before=record.before,
                after=record.after,
                stat=stat,
                feed_key=(str(payload.get("feed_key") or "") or None),
                source_id=(str(payload.get("source_id") or "") or None),
                feed_id=(str(payload.get("feed_id") or "") or None),
            )
            pending = [(prop, record)]
            writers = {
                "correlation_n": apply_correlation_n,
                "severity_floor": apply_severity_floor,
            }
            try:
                if mutate_prefs is not None:
                    compensation = mutate_prefs(
                        lambda latest: _restore_pending_auto_changes(
                            latest, pending, writers
                        )
                    )
                else:
                    compensation = write_prefs(
                        _restore_pending_auto_changes(
                            materialized["prefs"], pending, writers
                        )
                    )
                if hasattr(compensation, "__await__"):
                    await compensation  # type: ignore[misc]
            except Exception as compensation_exc:
                raise RuntimeError(
                    "approved tuning ledger persistence failed after the config write, "
                    "and exact compensation could not be confirmed; operator review required"
                ) from compensation_exc
        raise RuntimeError(
            "approved tuning ledger persistence failed; the threshold change was reverted"
        ) from ledger_exc
    return persisted, created


async def _audit_tuning(audit: Any, prop: TuningProposal, record: TuningRecord) -> None:
    """Write the before/after ``ActionType.TUNING`` audit record for an auto-apply."""
    if audit is None:
        return
    try:
        await audit.record(
            action_type=ActionType.TUNING, surface="tuner", actor="tuner",
            result_summary=(
                f"auto-applied {prop.kind} for rule {prop.rule_id}: "
                f"{prop.before}->{prop.after} (record={record.id}, "
                f"fp_rate={record.fp_rate:.2f}, n={record.samples}); reversible"
            ),
        )
    except Exception as exc:  # noqa: BLE001 — audit is best-effort
        logger.debug("tuning audit failed for %s: %s", prop.rule_id, exc)


# --------------------------------------------------------------------------- #
# Rollback — restore a rule's prior threshold (one-click)
# --------------------------------------------------------------------------- #
async def rollback(
    record_id: str,
    prefs: Preferences,
    *,
    tuning_store: TuningStore,
    write_prefs: Callable[[Preferences], Awaitable[Preferences] | Preferences],
    mutate_prefs: PrefsMutator | None = None,
    audit: Any = None,
    config_writers: dict[str, ConfigWriter] | None = None,
) -> bool:
    """Reverse ONE auto-applied tuning change: restore ``record.before`` for the rule,
    mark the record rolled-back, and persist. Returns True on success.

    Uses the SAME field paths as apply; never touches a case / verdict / signature.
    A rollback is reported successful only after its ledger row is durably finalised.
    If the config restore succeeded but ledger finalisation did not, a retry detects
    the already-restored value and completes the ledger transition. Never raises."""
    try:
        record = await tuning_store.get_strict(record_id)
        if record is None or record.rolled_back:
            return False
        writers = {
            "correlation_n": apply_correlation_n,
            "severity_floor": apply_severity_floor,
            **(config_writers or {}),
        }
        writer = writers.get(record.target)
        if writer is None:
            return False
        # Build a reverse proposal (after<-before) reusing the record's identity.
        source_id = None
        feed_id = None
        if record.target == "severity_floor" and ":" in record.rule_id:
            source_id, _, feed_id = record.rule_id.partition(":")
        reverse = TuningProposal(
            rule_id=record.rule_id if record.target != "severity_floor" else (feed_id or record.rule_id),
            kind=record.target,
            before=record.after,   # current live value
            after=record.before,   # restore to
            stat=RuleStat(rule_id=record.rule_id),
            feed_key=record.rule_id if record.target == "severity_floor" else None,
            source_id=source_id,
            feed_id=feed_id,
        )
        # apply_* refuse when after<=before; a rollback lowers the value, so bypass that
        # guard by writing directly with a synthesised prop whose after<before is allowed.
        def _restore(latest: Preferences) -> Preferences:
            if record.target == "correlation_n":
                live = int(latest.correlation_for(reverse.rule_id).n)
            else:
                exact = _current_feed_floor(latest, reverse.source_id, reverse.feed_id)
                live = exact if exact is not None else -1
            # Retry seam: a prior attempt may have restored the preference and then
            # lost the ledger write.  Treat that exact ``before`` value as the
            # compensating action already complete, but reject any third value.
            if live == record.before:
                return latest
            if live != record.after:
                raise ValueError("rollback target is stale; live threshold changed")
            restored = _apply_rollback(writer, latest, reverse)
            if restored is None:
                raise ValueError("rollback target no longer exists")
            return restored

        if mutate_prefs is not None:
            result = mutate_prefs(_restore)
        else:
            new_prefs = _restore(prefs)
            result = write_prefs(new_prefs)
        if hasattr(result, "__await__"):
            await result  # type: ignore[misc]
        rolled_back = await tuning_store.mark_rolled_back_strict(record_id)
        if rolled_back is None:
            # A concurrent retry may have completed the same transition between the
            # strict read and CAS.  Confirm that state before reporting success.
            confirmed = await tuning_store.get_strict(record_id)
            if confirmed is None or not confirmed.rolled_back:
                return False
        if audit is not None:
            try:
                await audit.record(
                    action_type=ActionType.TUNING, surface="tuner", actor="tuner",
                    result_summary=(
                        f"rolled back {record.target} for {record.rule_id}: "
                        f"{record.after}->{record.before} (record={record.id})"
                    ),
                )
            except Exception:  # noqa: BLE001
                pass
        return True
    except Exception as exc:  # noqa: BLE001 — rollback must never break a caller
        logger.warning("tuning rollback %s failed: %s", record_id, exc)
        return False


def _apply_rollback(writer: ConfigWriter, prefs: Preferences, prop: TuningProposal) -> Preferences | None:
    """Apply a rollback (a LOWER-ing write) directly, bypassing the apply-guard's
    ``after > before`` requirement. The two default writers guard on ``after<=before``;
    for a rollback we synthesise the write via the same field paths."""
    if prop.kind == "correlation_n":
        rid = (prop.rule_id or "").strip()
        if not rid:
            return None
        rules = dict(prefs.correlation_rules)
        base = rules.get(rid) or prefs.correlation_for(rid)
        rules[rid] = base.model_copy(update={"n": int(prop.after)})
        return prefs.model_copy(update={"correlation_rules": rules})
    if prop.kind == "severity_floor":
        if not prop.source_id:
            return None
        sources = list(prefs.sources)
        for idx, src in enumerate(sources):
            if src.id != prop.source_id:
                continue
            raw_patterns = src.config.get("index_patterns")
            if not isinstance(raw_patterns, list):
                return None
            new_patterns: list[Any] = []
            found = False
            for item in raw_patterns:
                if isinstance(item, dict):
                    item_id = str(item.get("id") or "")
                    pat = str(item.get("pattern") or "")
                    if item_id == prop.feed_id or (not item_id and _slug(pat) == prop.feed_id) or pat == prop.feed_id:
                        updated = dict(item)
                        updated["severity_floor"] = int(prop.after)
                        new_patterns.append(updated)
                        found = True
                        continue
                new_patterns.append(item)
            if not found:
                return None
            new_config = dict(src.config)
            new_config["index_patterns"] = new_patterns
            sources[idx] = src.model_copy(update={"config": new_config})
            return prefs.model_copy(update={"sources": sources})
    return None
