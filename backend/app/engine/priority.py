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

# Default three-band ladder (mirrors PriorityMatrix.levels). The thresholds below
# map a 0-100 magnitude onto one of these bands. Operators tune the P-level grid via
# Preferences.priority_matrix; the band CUTS here are deliberately fixed + documented
# (advisory display), not a decision surface.
_HIGH = "high"
_MEDIUM = "medium"
_LOW = "low"

# 0-100 magnitude cut points for the three bands. >=70 high, >=40 medium, else low.
_BAND_HIGH_CUT = 70.0
_BAND_MEDIUM_CUT = 40.0


def _band_from_magnitude(magnitude: float) -> str:
    """Map a 0-100 magnitude onto the high/medium/low ladder (advisory display)."""
    if magnitude >= _BAND_HIGH_CUT:
        return _HIGH
    if magnitude >= _BAND_MEDIUM_CUT:
        return _MEDIUM
    return _LOW


# Severity scales a connector can assert. Recorded as a string so it is contract-
# stable + render-safe. ``unknown`` keeps the legacy magnitude heuristic (back-compat
# for cases whose source scale cannot be resolved at read time).
_SCALE_OCSF_0_100 = "ocsf_0_100"   # OCSF severity_score (already 0-100; identity-clamp)
_SCALE_WAZUH_0_15 = "wazuh_0_15"   # Wazuh rule.level 0..15 -> level/15*100
_SCALE_0_10 = "0_10"               # the suite's own 0-10 rating (critical_severity=7.0)
_SCALE_UNKNOWN = "unknown"         # no resolvable scale -> legacy <=10?*10:raw heuristic


def _scale_for_case(case: Case, prefs: Preferences | None) -> str:
    """Resolve the SEVERITY SCALE the case's source asserts ``severity_max`` on.

    The scale is unambiguous only with provenance: a bare magnitude can't tell a
    Wazuh ``rule.level`` of 12 (CRITICAL on a 0-15 ladder) from an OCSF score of 12
    (low on a 0-100 ladder). We look the case's ``source_id`` up against the operator's
    configured ``Preferences.sources`` to read the connector's declared scale:

    * Wazuh (``source_type == WAZUH``) asserts ``rule.level`` on a **0-15** ladder.
    * PUSH connectors (HTTP/syslog/socket/queue/object-store/stream receivers) normalise
      every record to OCSF, so ``severity_max`` is the OCSF ``severity_score`` — **0-100**.
    * The seeded **demo** source emits a **0-100** severity (diurnal pyramid).

    When ``prefs`` is None, or the case has no ``source_id``, or the source isn't
    configured, we return ``unknown`` so the legacy magnitude heuristic applies —
    keeping every pre-existing case + the no-prefs callers byte-identical."""
    if prefs is None:
        return _SCALE_UNKNOWN
    source_id = getattr(case, "source_id", None)
    if not source_id:
        return _SCALE_UNKNOWN
    # The seeded demo source emits a 0-100 severity regardless of its connector type.
    if source_id == "demo":
        return _SCALE_OCSF_0_100
    inst = None
    for s in (getattr(prefs, "sources", None) or []):
        if getattr(s, "id", None) == source_id:
            inst = s
            break
    if inst is None:
        return _SCALE_UNKNOWN
    stype = getattr(inst, "source_type", None)
    if stype == SourceType.WAZUH:
        return _SCALE_WAZUH_0_15
    # PUSH-mode sources flow through the OCSF normaliser (receivers/*) → 0-100.
    ingest = getattr(inst, "ingest_mode", None)
    mode_val = getattr(ingest, "value", ingest)
    if isinstance(mode_val, str) and mode_val != "pull":
        return _SCALE_OCSF_0_100
    # PULL Elastic/OpenSearch/generic: the suite default rating is 0-10.
    return _SCALE_0_10


def _normalise_severity(raw: float, scale: str = _SCALE_UNKNOWN) -> float:
    """Project a source-asserted severity onto a 0-100 scale, scale-aware.

    The ``scale`` (resolved from the case's source provenance by :func:`_scale_for_case`)
    removes the old magnitude guess that mislabelled overlapping ranges — an OCSF
    ``Informational`` score of 10 was scaled to 100 (HIGH) and a Wazuh ``rule.level`` of
    12 (CRITICAL) was left at 12 (LOW). Each known scale projects deterministically:

    * ``ocsf_0_100`` — already 0-100, identity-clamp (10 stays 10 → LOW/INFO).
    * ``wazuh_0_15`` — ``level/15*100`` (12 → 80 → HIGH).
    * ``0_10`` — ``raw*10`` (the suite's own 0-10 rating).
    * ``unknown`` — the legacy heuristic (``raw<=10 ? raw*10 : raw``) for cases whose
      scale can't be resolved (no prefs / unconfigured source) — back-compat only.

    Clamped to 0..100. Never raises."""
    if raw <= 0:
        return 0.0
    if scale == _SCALE_OCSF_0_100:
        mag = raw
    elif scale == _SCALE_WAZUH_0_15:
        mag = raw / 15.0 * 100.0
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
            "band": _band_from_magnitude(mag),
            "value": round(mag, 2),
            "raw": raw,
            "source": "source_asserted",
            "scale": scale,
        }
    # No source severity — fall back to the deterministic risk total (clearly flagged
    # as DERIVED, never claimed to be source-asserted).
    mag = max(0.0, min(100.0, float(case.risk_score)))
    return {
        "band": _band_from_magnitude(mag),
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
    """ITIL Impact×Urgency → P1..P4 lookup (ADVISORY ordering only).

    Looks up ``"{impact}/{urgency}"`` in the operator's :class:`PriorityMatrix`,
    falling back to ``matrix.default_priority`` for any unmapped pair. Returns
    ``{level, impact, urgency, matched, default}``. This is pure display/ordering —
    it MUST NEVER be passed to ``case_manager.decide()`` (a regression test pins
    decide()'s invariance to it)."""
    key = f"{impact}/{urgency}"
    level = matrix.matrix.get(key)
    matched = level is not None
    if not matched:
        level = matrix.default_priority
    return {
        "level": level,
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
                "Deterministic 0-100 risk: a weighted blend of event volume, velocity, "
                "entity reputation, rule diversity and asset criticality."
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
