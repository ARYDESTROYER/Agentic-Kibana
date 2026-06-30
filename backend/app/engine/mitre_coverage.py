"""Deterministic MITRE ATT&CK coverage analytics over the suite's own cases.

Pure aggregation: it tallies every ``Case.mitre`` technique id our cases have
actually been labelled with against the bundled ATT&CK corpus
(``engine/mitre``/``threat/mitre_techniques.json``) to answer "which tactics /
techniques are we *seeing* in our case load, and how much of the framework does
that cover?". It produces both a human rollup (per-tactic covered%) and a
machine-consumable **ATT&CK Navigator v4.5 layer** dict the UI can hand straight to
the Navigator.

Non-negotiables honoured:

* **#9 (untrusted data).** Technique ids come from case data which is ultimately
  log/source-influenced. Every id is VALIDATED against the strict
  ``T####[.###]`` shape and dropped if it doesn't resolve to a known technique in
  the bundle — a forged / malformed id can never inject an arbitrary string into
  the layer or the rollup. The values we emit are framework-derived (the bundle's
  own ``name``/``tactic`` strings), never raw case text.
* **#3 (deterministic decision).** This is read-time reporting only; nothing here
  is ever consulted by ``case_manager.decide()``.

Fail-open: a missing / unparseable bundle degrades to empty coverage (no tactics,
no techniques) rather than raising, so a metrics request never fails because the
corpus is absent or stale.
"""

from __future__ import annotations

from collections import Counter
from typing import Any

from ..models import Case
from . import mitre as mitre_engine

# The bundled corpus version we stamp onto every coverage payload so a dashboard /
# Navigator export records WHICH ATT&CK release it was scored against. The compact
# bundle is generated from enterprise-attack @ master (≈ ATT&CK v17, mid-2026); see
# ``app/threat/SOURCE.md``. This is metadata only.
CORPUS_VERSION = "ATT&CK v17 (enterprise, compact)"
NAVIGATOR_VERSION = "4.5"
ATTACK_DOMAIN = "enterprise-attack"


def _corpus() -> dict[str, dict[str, Any]]:
    """Return the loaded compact technique map ({TID: meta}); {} when absent."""
    try:
        return mitre_engine._load()  # process-cached; never raises
    except Exception:  # noqa: BLE001 — corpus must never break a metrics request
        return {}


def _resolve(technique_id: str | None) -> tuple[str, dict[str, Any]] | None:
    """Validate + resolve a (possibly source-influenced) technique id against the
    bundle (#9). Returns ``(resolved_id, meta)`` or ``None`` for an invalid/unknown
    id. A valid sub-technique that isn't itself bundled falls back to its PARENT
    (delegated to ``mitre.technique``, which carries the resolved ``id``)."""
    meta = mitre_engine.technique(technique_id)
    if not isinstance(meta, dict):
        return None
    tid = str(meta.get("id") or "").strip().upper()
    if not tid:
        return None
    return tid, meta


def _tactics_of(meta: dict[str, Any]) -> list[str]:
    out: list[str] = []
    for t in meta.get("tactics") or []:
        if isinstance(t, str) and t.strip():
            out.append(t.strip())
    return out


def compute_mitre_coverage(cases: list[Case]) -> dict[str, Any]:
    """Tally ``Case.mitre`` across ``cases`` against the bundled corpus.

    Pure + deterministic. Output:

    * ``corpus_version`` — the stamped ATT&CK release label.
    * ``total_techniques`` — distinct VALID techniques in the bundle.
    * ``covered_techniques`` — distinct valid techniques our cases reference.
    * ``coverage_pct`` — covered / total of the whole framework (0-100).
    * ``invalid_dropped`` — count of technique strings dropped as invalid/unknown
      (#9 visibility — a non-zero value flags malformed/forged ids).
    * ``by_tactic`` — per-tactic ``{covered, total, coverage_pct, techniques[]}``
      where ``techniques`` are the COVERED ones (id/name/case_count), sorted by
      case_count desc then id.
    * ``top_techniques`` — the most-seen covered techniques across all tactics.
    """
    corpus = _corpus()

    # Framework denominator: distinct valid technique ids in the bundle, and a
    # per-tactic total so each tactic's coverage% has an honest denominator.
    tactic_total: Counter[str] = Counter()
    for tid, meta in corpus.items():
        if not isinstance(meta, dict):
            continue
        for tac in _tactics_of(meta):
            tactic_total[tac] += 1
    total_techniques = len(corpus)

    # Numerator: count how many cases reference each VALID resolved technique.
    technique_case_counts: Counter[str] = Counter()
    technique_name: dict[str, str] = {}
    technique_tactics: dict[str, list[str]] = {}
    invalid_dropped = 0

    for case in cases:
        # De-dupe per case so one case labelled with the same technique twice counts
        # once toward that technique's case_count.
        seen_in_case: set[str] = set()
        for raw in case.mitre or []:
            resolved = _resolve(raw)
            if resolved is None:
                invalid_dropped += 1
                continue
            tid, meta = resolved
            if tid in seen_in_case:
                continue
            seen_in_case.add(tid)
            technique_case_counts[tid] += 1
            technique_name[tid] = str(meta.get("name") or tid)
            technique_tactics[tid] = _tactics_of(meta)

    covered_techniques = len(technique_case_counts)
    coverage_pct = round(100.0 * covered_techniques / total_techniques, 1) if total_techniques else 0.0

    # Per-tactic rollup. A covered technique contributes to EACH of its tactics.
    by_tactic: dict[str, dict[str, Any]] = {}
    all_tactics = set(tactic_total) | {
        tac for tid in technique_case_counts for tac in technique_tactics.get(tid, [])
    }
    for tac in sorted(all_tactics):
        members = [
            {"id": tid, "name": technique_name.get(tid, tid), "case_count": technique_case_counts[tid]}
            for tid in technique_case_counts
            if tac in technique_tactics.get(tid, [])
        ]
        members.sort(key=lambda m: (-m["case_count"], m["id"]))
        tot = tactic_total.get(tac, 0)
        cov = len(members)
        by_tactic[tac] = {
            "tactic": tac,
            "covered": cov,
            "total": tot,
            "coverage_pct": round(100.0 * cov / tot, 1) if tot else 0.0,
            "techniques": members,
        }

    top = sorted(
        (
            {"id": tid, "name": technique_name.get(tid, tid), "case_count": cnt}
            for tid, cnt in technique_case_counts.items()
        ),
        key=lambda m: (-m["case_count"], m["id"]),
    )

    return {
        "corpus_version": CORPUS_VERSION,
        "total_techniques": total_techniques,
        "covered_techniques": covered_techniques,
        "coverage_pct": coverage_pct,
        "invalid_dropped": invalid_dropped,
        "by_tactic": by_tactic,
        "top_techniques": top[:25],
    }


def _heat_color(count: int, max_count: int) -> str:
    """Map a case-count to a Navigator heat colour (light→deep). Deterministic; only
    used for visual scoring (the score field carries the real number)."""
    if count <= 0 or max_count <= 0:
        return ""
    ratio = count / max_count
    # Three-band green→amber→red heat, matching common Navigator gradients.
    if ratio >= 0.66:
        return "#c0392b"  # heavy
    if ratio >= 0.33:
        return "#e67e22"  # moderate
    return "#f1c40f"  # light


def navigator_layer(
    cases: list[Case], *, name: str = "TLSOC case coverage", window_hours: int | None = None
) -> dict[str, Any]:
    """Build an ATT&CK Navigator **v4.5** layer dict from our case load.

    Each covered, VALID technique becomes a layer ``technique`` entry scored by the
    number of cases that referenced it, with a heat colour + a comment naming the
    case count. The layer is pure JSON the UI can hand to the Navigator unchanged.
    Invalid/forged ids never appear (#9 — dropped by ``compute_mitre_coverage``)."""
    coverage = compute_mitre_coverage(cases)
    by_tactic = coverage["by_tactic"]

    # Flatten to per-technique max case_count (a technique may surface under several
    # tactics; Navigator keys by techniqueID so we collapse to one entry).
    counts: dict[str, dict[str, Any]] = {}
    for tac in by_tactic.values():
        for tech in tac["techniques"]:
            counts.setdefault(tech["id"], {"name": tech["name"], "case_count": tech["case_count"]})

    max_count = max((t["case_count"] for t in counts.values()), default=0)

    techniques: list[dict[str, Any]] = []
    for tid, info in sorted(counts.items()):
        cnt = int(info["case_count"])
        techniques.append(
            {
                "techniqueID": tid,
                "score": cnt,
                "color": _heat_color(cnt, max_count),
                "comment": f"{cnt} case(s)",
                "enabled": True,
                "metadata": [],
            }
        )

    desc = (
        f"TLSOC agentic-triage case coverage ({coverage['covered_techniques']}/"
        f"{coverage['total_techniques']} techniques)"
    )
    if window_hours:
        desc += f" over the last {int(window_hours)}h"

    return {
        "name": name,
        "versions": {"layer": NAVIGATOR_VERSION, "navigator": NAVIGATOR_VERSION, "attack": ""},
        "domain": ATTACK_DOMAIN,
        "description": desc,
        "filters": {"platforms": []},
        "sorting": 3,  # descending by score
        "layout": {"layout": "side", "showName": True, "showID": True},
        "hideDisabled": False,
        "techniques": techniques,
        "gradient": {
            "colors": ["#f1c40f", "#e67e22", "#c0392b"],
            "minValue": 0,
            "maxValue": max_count,
        },
        "legendItems": [],
        "showTacticRowBackground": False,
        "selectTechniquesAcrossTactics": True,
        "selectSubtechniquesWithParent": False,
        "metadata": [
            {"name": "corpus", "value": coverage["corpus_version"]},
            {"name": "covered_techniques", "value": str(coverage["covered_techniques"])},
            {"name": "total_techniques", "value": str(coverage["total_techniques"])},
        ],
    }
