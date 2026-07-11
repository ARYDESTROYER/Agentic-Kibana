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
3. **Blast-radius tiering.** A low-impact n/floor raise is AUTO-APPLIED with a
   before/after AUDIT (``ActionType.TUNING``) + a stored rollback token. ANY actual
   suppression DROP is NEVER auto-applied — it is routed to the existing HITL
   :class:`app.models.Proposal` queue (approve is the only live-write path).
4. **Shadow-eval.** Before auto-applying, the proposed threshold is REPLAYED over the
   same window; if it would have HIDDEN even ONE confirmed TRUE_POSITIVE, it is NOT
   auto-applied — it is forced to human review (a Proposal).
5. **Config-writer only.** Auto-apply mutates ``CorrelationRule.n`` /
   ``IndexPattern.severity_floor`` in ``Preferences`` through an injected writer
   callback. ``correlate()`` reads ``cfg.n`` live and the connector reads
   ``severity_floor`` live on the next poll — NO pipeline change.

HARD BOUNDARY (enforced structurally + by a source-text guard test): this module NEVER
imports the case-manager module / invokes the close-decision function; NEVER sets a case
status/disposition; NEVER reads or modifies risk weights; NEVER recomputes/alters the #4
cluster-signature idempotency key (it only moves detection-volume knobs). Defaults OFF
(``prefs.threshold_tuning.enabled`` False → :func:`run_once` is a no-op).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from ..config import Preferences
from ..constants import ActionType, Verdict
from ..models import Case, Proposal
from ..stores.tuning import TuningRecord, TuningStore
from ..utils import now_utc

logger = logging.getLogger("tlsoc.engine.threshold_tuner")

# The dispositions/verdicts that count as a "false positive / benign" close — the
# numerator of the per-rule FP rate. Verdict is the LLM output; disposition is the
# analyst-confirmable classification. We treat EITHER surface saying FP/benign as a
# false positive so an analyst-refined close still counts.
_FP_VERDICTS = {Verdict.FALSE_POSITIVE.value}
_FP_DISPOSITIONS = {"false_positive", "benign"}
# A confirmed TRUE_POSITIVE — the thing shadow-eval must never hide.
_TP_VERDICTS = {Verdict.TRUE_POSITIVE.value}
_TP_DISPOSITIONS = {"true_positive"}

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


def _is_fp(case: Case) -> bool:
    v = case.verdict.value if case.verdict else ""
    d = case.disposition.value if case.disposition else ""
    return v in _FP_VERDICTS or d in _FP_DISPOSITIONS


def _is_confirmed_tp(case: Case) -> bool:
    v = case.verdict.value if case.verdict else ""
    d = case.disposition.value if case.disposition else ""
    return v in _TP_VERDICTS or d in _TP_DISPOSITIONS


# --------------------------------------------------------------------------- #
# Per-rule statistics
# --------------------------------------------------------------------------- #
@dataclass
class RuleStat:
    """The observed close-quality of ONE detection rule over the window."""

    rule_id: str
    total: int = 0            # verdicted-closed cases keyed on this rule
    fp: int = 0               # of which FP/benign
    tp: int = 0               # of which confirmed TP
    fp_lower_bound: float = 0.0
    volume_ewma: float | None = None
    daily_counts: list[float] = field(default_factory=list)


def _accumulate_rule_stats(cases: list[Case], *, ewma_alpha: float, z: float) -> dict[str, RuleStat]:
    """Tally per-rule FP/TP over VERDICTED-closed cases keyed on ``Case.rule_ids``.

    A case with multiple rule ids contributes to EACH rule (a noisy rule shares blame
    with none other — attribution is per-rule). Only cases with a real verdict count
    (an unverdicted / errored close is neither FP nor TP evidence)."""
    stats: dict[str, RuleStat] = {}
    per_rule_days: dict[str, dict[str, int]] = {}
    for case in cases:
        if case.verdict is None:
            continue  # no LLM verdict → not FP/TP evidence
        is_fp = _is_fp(case)
        is_tp = _is_confirmed_tp(case)
        closed = _case_closed_at(case)
        day_key = closed.strftime("%Y-%m-%d") if closed else "unknown"
        for rid in (case.rule_ids or []):
            rid = str(rid)
            if not rid:
                continue
            st = stats.get(rid)
            if st is None:
                st = RuleStat(rule_id=rid)
                stats[rid] = st
                per_rule_days[rid] = {}
            st.total += 1
            if is_fp:
                st.fp += 1
            if is_tp:
                st.tp += 1
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
    ``correlation_n`` / ``severity_floor`` are AUTO-APPLY candidates (subject to
    shadow-eval); ``suppression`` is ALWAYS a HITL Proposal (never auto)."""

    rule_id: str
    kind: str                 # "correlation_n" | "severity_floor" | "suppression"
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


# The config-writer callback: given the current prefs + a proposal, RETURN a new
# Preferences with the single bounded change applied. Returning None means "the writer
# refused / could not apply" → the tuner falls back to a Proposal. It is injected so
# the tuner never reaches into AppState and stays trivially testable.
ConfigWriter = Callable[[Preferences, TuningProposal], "Preferences | None"]


def apply_correlation_n(prefs: Preferences, prop: TuningProposal) -> Preferences | None:
    """Default config-writer for a ``correlation_n`` raise. Sets
    ``correlation_rules[rule_id].n = after`` (materialising the rule from the effective
    correlation config when absent) and returns a NEW Preferences. Never mutates the
    passed-in prefs in place. Returns None if the rule id is empty."""
    rid = (prop.rule_id or "").strip()
    if not rid or prop.after <= prop.before:
        return None
    rules = dict(prefs.correlation_rules)
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
        if prop.rule_id not in [str(r) for r in (case.rule_ids or [])]:
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
) -> list[TuningProposal]:
    """For each genuinely-noisy rule (Wilson-LB FP-rate > target AND samples >= min),
    derive ONE bounded proposal. Pure — no side effects, no store/prefs writes.

    Preference order for the bounded change:
    1. Raise the matching ``CorrelationRule.n`` by ``max_n_step`` (a low-impact volume
       reduction) — the default auto-apply candidate.
    2. If ``max_n_step`` is 0 (n-tuning disabled) but a feed carries this rule, raise
       that feed's ``severity_floor`` by 1.
    ``already_tuned`` maps rule_id → the n we ALREADY auto-raised it to within this
    cadence window. Such a rule is SKIPPED entirely (not re-raised) — the FP-rate is
    computed over the same trailing window of already-closed cases, which does not change
    tick-to-tick, so re-bumping the same rule every tick would grow ``n`` unbounded
    (FINDING #14). One effective bump per rule per cadence; the next window's fresh
    closes decide whether it still needs relief."""
    cfg = prefs.threshold_tuning
    target = float(cfg.fp_rate_target)
    min_samples = int(cfg.min_samples)
    step = int(cfg.max_n_step)
    already_tuned = already_tuned or {}
    out: list[TuningProposal] = []

    for rid, st in sorted(stats.items()):
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
            new_floor = min(_SEVERITY_FLOOR_MAX, (cur_floor or _SEVERITY_FLOOR_MIN) + 1)
            if new_floor > (cur_floor or _SEVERITY_FLOOR_MIN):
                out.append(TuningProposal(
                    rule_id=rid, kind="severity_floor",
                    before=cur_floor or _SEVERITY_FLOOR_MIN, after=new_floor, stat=st,
                    source_id=source_id, feed_id=feed_id,
                    feed_key=f"{source_id}:{feed_id}",
                ))
    return out


def _find_feed_for_rule(prefs: Preferences, rule_id: str) -> tuple[str, str, int | None] | None:
    """Best-effort: the FIRST enabled, non-ignore feed whose per-feed ``query`` names
    the rule, else the first enabled non-ignore feed of any source. Returns
    ``(source_id, feed_id, current_floor)`` or None. Deterministic (sorted)."""
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
    # Fallback: no query names it — pick the first eligible feed deterministically.
    for src in sorted(prefs.sources, key=lambda s: s.id):
        try:
            feeds = src.feeds()
        except Exception:  # noqa: BLE001
            continue
        for feed in feeds:
            if feed.enabled and getattr(feed.role, "value", str(feed.role)) != "ignore":
                return (src.id, feed.id or _slug(feed.pattern), feed.severity_floor)
    return None


# --------------------------------------------------------------------------- #
# The observer entrypoint
# --------------------------------------------------------------------------- #
CaseReader = Callable[[int, int], Awaitable[list[Case]]]


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


async def _recently_tuned_ns(tuning_store: TuningStore, window_start: datetime) -> dict[str, int]:
    """The ``{rule_id -> after}`` map of ``correlation_n`` auto-raises that landed WITHIN
    the current cadence window and are still active (not rolled back). A rule in this set
    was already relieved this window, so ``derive_proposals`` skips re-raising it for the
    same noise (FINDING #14). Never raises — a store glitch yields an empty map."""
    out: dict[str, int] = {}
    try:
        records = await tuning_store.list(active_only=True)
    except Exception as exc:  # noqa: BLE001 — best-effort; degrade to "nothing tuned yet"
        logger.debug("recently-tuned read failed (%s); assuming none", exc)
        return out
    for rec in records:
        if getattr(rec, "target", None) != "correlation_n":
            continue
        applied = _parse_iso(getattr(rec, "applied_at", None))
        if applied is None or applied < window_start:
            continue
        rid = str(getattr(rec, "rule_id", "") or "")
        if not rid:
            continue
        # Keep the HIGHEST after we already raised this rule to this window.
        out[rid] = max(out.get(rid, 0), int(getattr(rec, "after", 0) or 0))
    return out


async def run_once(
    prefs: Preferences,
    cases: "list[Case] | CaseReader",
    proposals: Any,           # ProposalStore (duck-typed .add)
    audit: Any,               # AuditLogger (duck-typed .record) — may be None
    *,
    tuning_store: TuningStore,
    write_prefs: Callable[[Preferences], Awaitable[Preferences] | Preferences],
    config_writers: dict[str, ConfigWriter] | None = None,
    now: datetime | None = None,
    page_size: int = 500,
) -> TuningOutcome:
    """Run ONE deterministic tuning pass. Returns a :class:`TuningOutcome` (always).

    ``cases`` — a pre-fetched closed-case list OR an async ``read(limit, offset)`` pager
      (the caller passes ``cases.list(status=CLOSED, ...)`` paged; the tuner pages it,
      never a naive 200-cap).
    ``proposals`` — the ProposalStore (for suppression-drop + shadow-blocked reviews).
    ``audit`` — the AuditLogger (before/after ``ActionType.TUNING`` records). Optional.
    ``tuning_store`` — records auto-applied changes + rollback tokens.
    ``write_prefs`` — persists a new Preferences (``AppState.update_prefs``); may be
      sync or async. The ONLY live-write the tuner performs (config-writer only).
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
        window_days = _WINDOW_DAYS.get(cfg.cadence, 14)
        window_start = clock - timedelta(days=window_days)

        window_cases = await _read_window(cases, window_start=window_start, page_size=page_size)
        stats = _accumulate_rule_stats(window_cases, ewma_alpha=cfg.ewma_alpha, z=cfg.wilson_z)
        outcome.rule_stats = stats
        outcome.ran = True

        # Build the set of rules we ALREADY auto-raised within this cadence window so a
        # rule is not re-bumped repeatedly for the SAME (unchanging) trailing-window noise
        # (FINDING #14 — unbounded knob growth). Best-effort: a store glitch degrades to an
        # empty set (the derive/shadow rails still bound each single bump).
        already_tuned = await _recently_tuned_ns(tuning_store, window_start)

        proposals_to_make = derive_proposals(prefs, stats, already_tuned=already_tuned)
        if not proposals_to_make:
            outcome.reason = "no noisy rule cleared the bar"
            return outcome

        # Apply / queue each proposal against a RUNNING prefs so multiple auto-applies
        # in one pass compose (each writer returns a fresh Preferences). ``current_prefs``
        # is the single source of truth threaded through — no smuggling via the outcome.
        current_prefs = prefs
        for prop in proposals_to_make:
            try:
                current_prefs = await _handle_proposal(
                    prop, current_prefs, window_cases, cfg,
                    proposals=proposals, audit=audit, tuning_store=tuning_store,
                    writers=writers, outcome=outcome,
                )
            except Exception as exc:  # noqa: BLE001 — one bad rule never breaks the pass
                logger.warning("tuning proposal for %s failed: %s", prop.rule_id, exc)

        # Persist the accumulated prefs change ONCE (all auto-applies composed).
        if current_prefs is not prefs:
            try:
                result = write_prefs(current_prefs)
                if hasattr(result, "__await__"):
                    await result  # type: ignore[misc]
            except Exception as exc:  # noqa: BLE001
                logger.warning("tuning write_prefs failed: %s", exc)
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
) -> Preferences:
    """Route ONE proposal: auto-apply a bounded n/floor raise (after shadow-eval), OR
    open a HITL Proposal for a suppression drop / a shadow-blocked change.

    Returns the (possibly advanced) running Preferences — the caller threads it into the
    next proposal so multiple auto-applies in one pass compose. A queued/blocked proposal
    returns ``prefs`` unchanged (no live write)."""
    # A suppression DROP is NEVER auto-applied — always HITL.
    if prop.kind == "suppression":
        await _open_proposal(prop, proposals, audit, outcome, reason="suppression_drop")
        return prefs

    # SHADOW-EVAL: would the raise have hidden a confirmed TP? If so, force review.
    if cfg.shadow_eval and shadow_eval_hides_true_positive(prop, window_cases):
        outcome.shadow_blocked.append(prop.rule_id)
        await _open_proposal(prop, proposals, audit, outcome, reason="shadow_eval_would_hide_tp")
        return prefs

    # Auto-apply the bounded change via the config-writer (working off the running prefs).
    writer = writers.get(prop.kind)
    new_prefs = writer(prefs, prop) if writer is not None else None
    if new_prefs is None:
        # The writer refused (couldn't locate the target) → HITL fallback (never silent).
        await _open_proposal(prop, proposals, audit, outcome, reason="writer_could_not_apply")
        return prefs

    record = TuningRecord(
        rule_id=prop.feed_key or prop.rule_id,
        target=prop.kind,  # type: ignore[arg-type]
        before=prop.before,
        after=prop.after,
        fp_rate=prop.stat.fp_lower_bound,
        samples=prop.stat.total,
        rationale=(
            f"rule {prop.rule_id!r} FP-rate(Wilson-LB)={prop.stat.fp_lower_bound:.2f} "
            f"> target={cfg.fp_rate_target} over {prop.stat.total} closed cases; "
            f"{prop.kind} {prop.before}->{prop.after} (auto-applied, reversible)"
        ),
    )
    await tuning_store.add(record)
    outcome.auto_applied.append(record)
    await _audit_tuning(audit, prop, record)
    return new_prefs


async def _open_proposal(
    prop: TuningProposal, proposals: Any, audit: Any, outcome: TuningOutcome, *, reason: str,
) -> None:
    """Create a PENDING HITL Proposal for a change that must NOT auto-apply. Mirrors
    ``threshold_automation._create_proposal`` — the operator approves it through the
    existing ``/proposals/{id}/approve`` path (the only live-write route)."""
    expires = (now_utc() + timedelta(days=30)).isoformat()
    payload = {
        "tuning": True,
        "kind": prop.kind,
        "rule_id": prop.rule_id,
        "before": prop.before,
        "after": prop.after,
        "feed_key": prop.feed_key,
        "source_id": prop.source_id,
        "feed_id": prop.feed_id,
        "reason": reason,
        "fp_rate": round(prop.stat.fp_lower_bound, 4),
        "samples": prop.stat.total,
    }
    rationale = (
        f"Adaptive tuner suggests {prop.kind} {prop.before}->{prop.after} for rule "
        f"{prop.rule_id!r} (FP-rate(Wilson-LB)={prop.stat.fp_lower_bound:.2f} over "
        f"{prop.stat.total} closed cases). Held for review: {reason}."
    )
    prop_model = Proposal(
        kind="suppression",  # reuse the existing HITL proposal kind (tuning payload flagged)
        payload=payload,
        rationale=rationale,
        confidence=0.5,
        source_case_ids=[],
        created_by="tuner",
        expires_at=expires,
    )
    try:
        await proposals.add(prop_model)
        outcome.proposals.append(prop_model)
    except Exception as exc:  # noqa: BLE001 — a proposal glitch never breaks the pass
        logger.warning("tuner proposal add failed for %s: %s", prop.rule_id, exc)
        return
    if audit is not None:
        try:
            await audit.record(
                action_type=ActionType.PROPOSAL, surface="tuner", actor="tuner",
                result_summary=(
                    f"tuner drafted review proposal {prop_model.id} for rule "
                    f"{prop.rule_id} ({prop.kind} {prop.before}->{prop.after}, {reason})"
                ),
            )
        except Exception as exc:  # noqa: BLE001 — audit is best-effort
            logger.debug("tuner proposal audit failed: %s", exc)


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
    audit: Any = None,
    config_writers: dict[str, ConfigWriter] | None = None,
) -> bool:
    """Reverse ONE auto-applied tuning change: restore ``record.before`` for the rule,
    mark the record rolled-back, and persist. Returns True on success.

    Uses the SAME config-writers as apply (a rollback is just an apply back to
    ``before``); never touches a case / verdict / signature. Never raises."""
    try:
        record = await tuning_store.get(record_id)
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
        new_prefs = _apply_rollback(writer, prefs, reverse)
        if new_prefs is None:
            return False
        result = write_prefs(new_prefs)
        if hasattr(result, "__await__"):
            await result  # type: ignore[misc]
        await tuning_store.mark_rolled_back(record_id)
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
