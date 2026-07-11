"""ADVISORY triage derivation — severity / impact / urgency / priority bands.

These are PURE, side-effect-free, READ-TIME derivations used only for the case
PRESENTATION / aggregation surfaces (the "four honest chips" + the ITIL priority
grid). They turn already-recorded facts on a :class:`app.models.Case` into the
human-facing advisory bands the UI renders.

⛔ NON-NEGOTIABLE #3: NOTHING here ever feeds ``engine/case_manager.decide()``.
``decide()`` stays a pure function of ``(verdict, confidence, risk_score, policy)``;
the bands below are derived AFTER the fact, purely for display/reporting/ordering.
The accompanying test asserts ``decide()`` output is INVARIANT to any priority band.

Each derived value is honestly DISTINCT from ``risk_score`` (the 0-100 deterministic
risk number):

* ``severity`` — the SOURCE-asserted maximum member-event severity (what the SIEM/
  EDR claimed about the events), NOT our computed risk. Recorded on the case's
  ``trigger_reason.severity_max`` (falling back to the risk-breakdown only when a
  source never asserted a severity).
* ``impact`` — derived from ASSET CRITICALITY (how important the affected entity is),
  via :func:`app.engine.risk._asset_criticality`.
* ``urgency`` — derived from the deterministic ``risk_score`` (how pressing the
  situation is right now) blended with escalation.
* ``priority`` — the ITIL Impact×Urgency → P1..P4 lookup against the operator's
  :class:`app.config.PriorityMatrix`. ADVISORY ordering only.

All inputs are case-derived (some source/log-influenceable): the functions treat
them as plain DATA — they never interpolate anything into a prompt (#9 lives at the
prompt boundary; this module returns plain values the UI render-escapes).
"""

from __future__ import annotations

from typing import Any

from ..config import Preferences, PriorityMatrix
from ..constants import SourceType
from ..models import Case
from .risk import _asset_criticality

# Advisory band vocabulary. The SEVERITY axis uses the full 5-band ladder
# (critical/high/medium/low/info); the impact/urgency/risk axes project onto the
# 3-band {high, medium, low} subset. Operators tune the P-level grid via
# Preferences.priority_matrix; the band CUTS here are deliberately fixed + documented
# (advisory display), not a decision surface (#3).
_CRITICAL = "critical"
_HIGH = "high"
_MEDIUM = "medium"
_LOW = "low"
_INFO = "info"

# 0-100 magnitude cut points — THE single source of truth for the advisory ladder
# (``constants.SEVERITY_BANDS`` references these 74/48/22/8 cuts). They mirror the webui
# ``badges.tsx::severityBandFromNumber`` (palette ``scoreBand`` 74/48/22 + an <8 info
# floor) EXACTLY so the backend severity chip and the front-end badge never drift.
_BAND_CRIT_CUT = 74.0    # >=74 -> critical
_BAND_HIGH_CUT = 48.0    # >=48 -> high
_BAND_MED_CUT = 22.0     # >=22 -> medium
_BAND_INFO_CUT = 8.0     # >=8 -> low; <8 -> info (severity axis only)


def _severity_band_from_magnitude(mag: float) -> str:
    """Map a 0-100 magnitude onto the FULL 5-band SEVERITY ladder.

    Mirrors the webui ``badges.tsx::severityBandFromNumber`` EXACTLY (the ONE front-end
    severity authority): ``scoreBand`` gives critical>=74 / high>=48 / medium>=22 / low,
    then a sub-8 magnitude reads as ``info`` (a genuinely-nil score is informational, not
    a low alert). Advisory display only — never feeds ``decide()`` (#3)."""
    if mag >= _BAND_CRIT_CUT:
        return _CRITICAL
    if mag >= _BAND_HIGH_CUT:
        return _HIGH
    if mag >= _BAND_MED_CUT:
        return _MEDIUM
    if mag >= _BAND_INFO_CUT:
        return _LOW
    return _INFO


def _band_from_magnitude(magnitude: float) -> str:
    """Map a 0-100 magnitude onto the 3-band high/medium/low ladder (advisory display).

    Shares the severity ladder's 48/22 high/medium cuts so the impact/urgency/risk chips
    order-agree with severity; it has no critical/info band (impact/urgency are
    {high, medium, low} advisory chips). Never feeds ``decide()`` (#3)."""
    if magnitude >= _BAND_HIGH_CUT:
        return _HIGH
    if magnitude >= _BAND_MED_CUT:
        return _MEDIUM
    return _LOW


# Severity scales a connector can assert. Recorded as a string so it is contract-
# stable + render-safe. ``unknown`` keeps the legacy magnitude heuristic (back-compat
# for cases whose source scale cannot be resolved at read time).
_SCALE_OCSF_0_100 = "ocsf_0_100"   # OCSF severity_score (already 0-100; identity-clamp)
_SCALE_WAZUH_0_16 = "wazuh_0_16"   # Wazuh rule.level 0..16 -> level/16*100
_SCALE_0_10 = "0_10"               # the suite's own 0-10 rating (critical_severity=7.0)
_SCALE_UNKNOWN = "unknown"         # no resolvable scale -> legacy <=10?*10:raw heuristic

_DEMO_SOURCE_IDS = frozenset({
    "demo-splunk", "demo-qradar", "demo-wazuh", "demo-syslog",
})


def severity_scale_for_source(inst: Any) -> str:
    """Resolve the SEVERITY SCALE a configured source *instance* asserts severity on.

    Given a resolved :class:`app.config.SourceInstance` (or ``None`` when the source is
    unknown / unconfigured), returns the native scale id used to project a raw source
    severity onto 0-100 (see :func:`_normalise_severity`):

    * ``None`` → ``unknown`` (the legacy magnitude heuristic — back-compat).
    * Wazuh (``source_type == WAZUH``) → ``wazuh_0_16`` (``rule.level`` 0..16).
    * PUSH-mode (non-``pull`` ``ingest_mode``) → ``ocsf_0_100`` (OCSF ``severity_score``).
    * PULL Elastic/OpenSearch/generic → ``0_10`` (the suite's own 0-10 rating).

    Extracted verbatim from :func:`_scale_for_case`'s classifier (below) so the SAME
    resolution is reused by the Round-7 Noise-Reduction counters — which band raw ingest
    events by the source's declared scale (:mod:`app.engine.noise_counters`). Advisory
    display / accounting only — it never feeds ``case_manager.decide()`` (#3)."""
    if inst is None:
        return _SCALE_UNKNOWN
    stype = getattr(inst, "source_type", None)
    if stype == SourceType.WAZUH:
        return _SCALE_WAZUH_0_16
    # PUSH-mode sources flow through the OCSF normaliser (receivers/*) → 0-100.
    ingest = getattr(inst, "ingest_mode", None)
    mode_val = getattr(ingest, "value", ingest)
    if isinstance(mode_val, str) and mode_val != "pull":
        return _SCALE_OCSF_0_100
    # PULL Elastic/OpenSearch/generic: the suite default rating is 0-10.
    return _SCALE_0_10


def _scale_for_case(case: Case, prefs: Preferences | None) -> str:
    """Resolve the SEVERITY SCALE the case's source asserts ``severity_max`` on.

    The scale is unambiguous only with provenance: a bare magnitude can't tell a
    Wazuh ``rule.level`` of 12 (CRITICAL on a 0-16 ladder) from an OCSF score of 12
    (low on a 0-100 ladder). We look the case's ``source_id`` up against the operator's
    configured ``Preferences.sources`` to read the connector's declared scale:

    * Wazuh (``source_type == WAZUH``) asserts ``rule.level`` on a **0-16** ladder.
    * PUSH connectors (HTTP/syslog/socket/queue/object-store/stream receivers) normalise
      every record to OCSF, so ``severity_max`` is the OCSF ``severity_score`` — **0-100**.
    * Isolated **demo** sources emit a canonical **0-100 OCSF** severity.

    When ``prefs`` is None, or the case has no ``source_id``, or the source isn't
    configured, we return ``unknown`` so the legacy magnitude heuristic applies —
    keeping every pre-existing case + the no-prefs callers byte-identical."""
    if prefs is None:
        return _SCALE_UNKNOWN
    source_id = getattr(case, "source_id", None)
    if not source_id:
        return _SCALE_UNKNOWN
    # Every isolated demo adapter enters through the production OCSF receiver path,
    # so its persisted RawEvent severity is already the canonical 0-100 score.  The
    # adapters are intentionally read-time overlays (not Preferences.sources), hence
    # this namespace check must happen before the configured-source lookup.
    if (
        source_id in _DEMO_SOURCE_IDS
        and "demo" in (getattr(case, "tags", None) or [])
    ):
        return _SCALE_OCSF_0_100
    inst = None
    for s in (getattr(prefs, "sources", None) or []):
        if getattr(s, "id", None) == source_id:
            inst = s
            break
    return severity_scale_for_source(inst)


def _normalise_severity(raw: float, scale: str = _SCALE_UNKNOWN) -> float:
    """Project a source-asserted severity onto a 0-100 scale, scale-aware.

    The ``scale`` (resolved from the case's source provenance by :func:`_scale_for_case`)
    removes the old magnitude guess that mislabelled overlapping ranges — an OCSF
    ``Informational`` score of 10 was scaled to 100 (HIGH) and a Wazuh ``rule.level`` of
    12 (CRITICAL) was left at 12 (LOW). Each known scale projects deterministically:

    * ``ocsf_0_100`` — already 0-100, identity-clamp (10 stays 10 → LOW/INFO).
    * ``wazuh_0_16`` — ``level/16*100`` (12 → 75 → CRITICAL).
    * ``0_10`` — ``raw*10`` (the suite's own 0-10 rating).
    * ``unknown`` — the legacy heuristic (``raw<=10 ? raw*10 : raw``) for cases whose
      scale can't be resolved (no prefs / unconfigured source) — back-compat only.

    Clamped to 0..100. Never raises."""
    if raw <= 0:
        return 0.0
    if scale == _SCALE_OCSF_0_100:
        mag = raw
    elif scale == _SCALE_WAZUH_0_16:
        mag = raw / 16.0 * 100.0
    elif scale == _SCALE_0_10:
        mag = raw * 10.0
    else:  # _SCALE_UNKNOWN — legacy conservative heuristic.
        mag = raw * 10.0 if raw <= 10.0 else raw
    return max(0.0, min(100.0, mag))


def severity_band_from_events(case: Case, prefs: Preferences | None = None) -> dict[str, Any]:
    """SOURCE-asserted severity band for a case (NOT risk).

    Reads the maximum member-event severity the SOURCE asserted (recorded on
    ``trigger_reason.severity_max`` by correlation) and projects it onto 0-100 using the
    source's DECLARED severity scale (resolved from the case's ``source_id`` against
    ``prefs.sources`` — see :func:`_scale_for_case`). This makes the chip correct across
    overlapping native ladders: an OCSF ``Informational`` (score 10) reads LOW, and a
    Wazuh ``rule.level`` of 12 (CRITICAL) reads HIGH, instead of the old magnitude guess
    that inverted both. When ``prefs`` is None the legacy heuristic applies (back-compat).

    When no source severity was ever asserted (``severity_max`` is None) we DERIVE a band
    from the deterministic risk total as a last resort, and flag ``source`` accordingly so
    the UI can badge "(derived)" honestly.

    Returns ``{band, value (0-100), raw, source, scale}`` where ``source`` is
    ``"source_asserted"`` or ``"derived"`` and ``scale`` is the resolved native scale id
    (``"unknown"`` when no source provenance was available)."""
    tr = case.trigger_reason
    raw = None
    if tr is not None and tr.severity_max is not None:
        raw = float(tr.severity_max)
    if raw is not None:
        scale = _scale_for_case(case, prefs)
        mag = _normalise_severity(raw, scale)
        return {
            "band": _severity_band_from_magnitude(mag),
            "value": round(mag, 2),
            "raw": raw,
            "source": "source_asserted",
            "scale": scale,
        }
    # No source severity — fall back to the deterministic risk total (clearly flagged
    # as DERIVED, never claimed to be source-asserted).
    mag = max(0.0, min(100.0, float(case.risk_score)))
    return {
        "band": _severity_band_from_magnitude(mag),
        "value": round(mag, 2),
        "raw": None,
        "source": "derived",
        "scale": _SCALE_UNKNOWN,
    }


def impact_band(case: Case, prefs: Preferences) -> dict[str, Any]:
    """IMPACT band from the affected entity's ASSET CRITICALITY.

    Uses the SAME deterministic ``risk._asset_criticality`` the risk engine uses (so
    impact and the risk breakdown agree on what "critical asset" means), but surfaces
    it as a standalone advisory band rather than folding it into one risk number.
    Returns ``{band, value (0-100), criticality, entity}``."""
    entity_value = case.entity.value if case.entity else ""
    crit = _asset_criticality(entity_value, prefs) if entity_value else 0.0
    crit = max(0.0, min(100.0, float(crit)))
    return {
        "band": _band_from_magnitude(crit),
        "value": round(crit, 2),
        "criticality": round(crit, 2),
        "entity": entity_value,
    }


def urgency_band(case: Case, prefs: Preferences) -> dict[str, Any]:
    """URGENCY band — how pressing the situation is, from the deterministic risk score
    blended with the escalation flag.

    Urgency answers "how fast must someone act", which the deterministic ``risk_score``
    already captures (volume/velocity/reputation/diversity); an escalated case is
    treated as at least HIGH urgency. Returns ``{band, value (0-100), escalated}``.
    This is advisory: it never gates the decision."""
    mag = max(0.0, min(100.0, float(case.risk_score)))
    escalated = bool(case.escalation_level and case.escalation_level > 0)
    band = _band_from_magnitude(mag)
    if escalated and band != _HIGH:
        band = _HIGH
    return {"band": band, "value": round(mag, 2), "escalated": escalated}


def derive_priority(impact: str, urgency: str, matrix: PriorityMatrix) -> dict[str, Any]:
    """ITIL Impact×Urgency → P1..P4 lookup (ADVISORY ordering only) — THE ONE authority.

    Round 5 (bug #14): this is now the SINGLE source of truth for priority derivation.
    Both consumers — the triage chip (:func:`derive_triage`) and the shift report
    (:func:`app.engine.shift_report.derive_priority`, which delegates here) — call it,
    so they can never disagree on whether the matrix is enabled again.

    ``matrix.enabled`` gates the DERIVATION: when the operator has NOT enabled the ITIL
    priority grid, there is no effective priority (``level`` is ``None`` and
    ``enabled`` is ``False``) — the previous behaviour where the chip silently derived a
    P-level from a disabled matrix (while the shift report correctly showed none) was
    the bug. When enabled, ``"{impact}/{urgency}"`` is looked up in the operator's
    :class:`PriorityMatrix`, falling back to ``matrix.default_priority`` for any
    unmapped pair.

    Returns ``{level, enabled, impact, urgency, matched, default}`` where ``level`` is
    ``None`` when the matrix is disabled. Pure display/ordering — it MUST NEVER be
    passed to ``case_manager.decide()`` (a regression test pins decide()'s invariance)."""
    enabled = bool(getattr(matrix, "enabled", False))
    key = f"{impact}/{urgency}"
    raw = matrix.matrix.get(key)
    matched = raw is not None
    if not enabled:
        # Matrix disabled → NO effective priority (agreement with the shift report).
        level = None
    elif matched:
        level = raw
    else:
        level = matrix.default_priority
    return {
        "level": level,
        "enabled": enabled,
        "impact": impact,
        "urgency": urgency,
        "matched": matched,
        "default": matrix.default_priority,
    }


def derive_triage(case: Case, prefs: Preferences) -> dict[str, Any]:
    """Assemble the FOUR honestly-distinct advisory chips for a case in one shot.

    Returns a dict with ``risk`` (the existing 0-100 deterministic score + its
    breakdown — passed through, never recomputed here), ``severity`` (source),
    ``impact`` (asset criticality), and ``priority`` (the ITIL derivation), each with
    the inputs a UI HelpTip can show. Pure + defensive: a missing field degrades to a
    zero/low band, never raises. NONE of this is read by ``decide()`` (#3)."""
    severity = severity_band_from_events(case, prefs)
    impact = impact_band(case, prefs)
    urgency = urgency_band(case, prefs)
    priority = derive_priority(impact["band"], urgency["band"], prefs.priority_matrix)

    rb = case.risk_breakdown.model_dump(mode="json") if case.risk_breakdown else {}
    risk_chip = {
        "value": round(float(case.risk_score), 2),
        "band": _band_from_magnitude(max(0.0, min(100.0, float(case.risk_score)))),
        "breakdown": rb,
        "inputs": {
            "definition": (
                "Deterministic 0-100 risk score — a weighted blend of 5 factors: "
                "Volume (25%, how many events, log-normalised so it levels off ~50), "
                "Velocity (20%, events/min, full near 10/min, 0 below 3 events or a "
                "sub-second window), Reputation (30%, heaviest — worst threat-intel "
                "reputation among the cluster's IPs, 0 if no IP), Diversity (15%, "
                "distinct rule types, maxes at 5) and Asset criticality (10%, how "
                "important the targeted asset is; 0 if uncatalogued). The risk score "
                "only ranks what's investigated first — it never closes or escalates a "
                "case on its own."
            ),
        },
    }
    severity_chip = {
        **severity,
        "inputs": {
            "definition": (
                "The MAXIMUM severity the SOURCE asserted on the member events — the "
                "SIEM/EDR's own rating, not our computed risk."
            ),
            "severity_max": (case.trigger_reason.severity_max if case.trigger_reason else None),
            "severity_min": (case.trigger_reason.severity_min if case.trigger_reason else None),
        },
    }
    impact_chip = {
        **impact,
        "inputs": {
            "definition": (
                "How important the affected asset is, from the operator's asset-"
                "criticality map / internal-network policy."
            ),
            "entity_type": (case.entity.type.value if case.entity else ""),
            "entity_value": impact["entity"],
        },
    }
    priority_chip = {
        **priority,
        "urgency": urgency,
        "inputs": {
            "definition": (
                "ITIL priority = Impact × Urgency, looked up in the operator's priority "
                "matrix. ADVISORY ordering only — it never changes the verdict or the "
                "deterministic close/escalate decision."
            ),
            "impact_band": impact["band"],
            "urgency_band": urgency["band"],
            "matrix_enabled": prefs.priority_matrix.enabled,
        },
    }
    return {
        "risk": risk_chip,
        "severity": severity_chip,
        "impact": impact_chip,
        "priority": priority_chip,
    }


def advisory_bands(case: Case, prefs: Preferences | None = None) -> dict[str, Any]:
    """Read-time ADVISORY bands for the case PRESENTATION surfaces (list + detail).

    Returns the five FLAT presentation fields the case-list / case-detail render onto a
    :class:`app.models.Case`:

    * ``severity_band`` — 5-band {critical/high/medium/low/info} SOURCE-asserted severity.
    * ``severity_source`` — ``"source_asserted"`` or ``"derived"`` (honest provenance).
    * ``impact_band`` — 3-band {high/medium/low} asset-criticality impact.
    * ``urgency_band`` — 3-band {high/medium/low} risk-blended urgency.
    * ``priority_level`` — the ITIL ``"P1".."P4"`` (or ``None`` when the matrix is off).

    Pure + FAIL-OPEN: any missing/malformed field degrades to ``None`` instead of raising,
    so a bad case can NEVER 500 the ``GET /api/cases`` endpoints. When ``prefs`` is None
    only the (prefs-free) severity axis is resolved; impact/urgency/priority need the
    operator's asset map + ITIL grid. NONE of this is read by ``case_manager.decide()``
    (#3) — it is derived AFTER the fact, purely for display/ordering."""
    out: dict[str, Any] = {
        "severity_band": None,
        "severity_source": None,
        "impact_band": None,
        "urgency_band": None,
        "priority_level": None,
    }
    try:
        sev = severity_band_from_events(case, prefs)
        out["severity_band"] = sev.get("band")
        out["severity_source"] = sev.get("source")
    except Exception:  # noqa: BLE001 — advisory only; never raise on a bad case
        pass
    if prefs is None:
        return out
    imp_band: str | None = None
    urg_band: str | None = None
    try:
        imp_band = impact_band(case, prefs).get("band")
        out["impact_band"] = imp_band
    except Exception:  # noqa: BLE001
        pass
    try:
        urg_band = urgency_band(case, prefs).get("band")
        out["urgency_band"] = urg_band
    except Exception:  # noqa: BLE001
        pass
    try:
        matrix = getattr(prefs, "priority_matrix", None)
        if matrix is not None and imp_band and urg_band:
            out["priority_level"] = derive_priority(imp_band, urg_band, matrix).get("level")
    except Exception:  # noqa: BLE001
        pass
    return out
