"""Deterministic playbook selection + an atomic, hot-reloadable registry.

``select_playbook`` is a PURE function: given a cluster and a list of playbooks it
returns the single best match and a short, explainable reason. A playbook matches
iff ALL of its PRESENT (non-empty) criteria are satisfied; absent criteria do not
constrain. Among matches we pick deterministically by:
``priority`` (desc) → ``version`` (desc) → ``id`` (asc).

``PlaybookRegistry`` wraps a directory and reloads atomically: it loads into a temp
list and only swaps the live set on success, so a broken file can never replace a
good live set (validate-then-swap).
"""

from __future__ import annotations

import logging
from pathlib import Path

from ..models import Cluster
from .loader import load_playbooks
from .manifest import Playbook

logger = logging.getLogger("tlsoc.playbooks.registry")

_NO_MATCH = "no_playbook_matched"


def _cluster_rule_set(cluster: Cluster) -> set[str]:
    """The cluster's rule identifiers: declared rule values + the primary rule."""
    rules: set[str] = {r for r in (cluster.rule_values or []) if r}
    primary = cluster.primary_rule()
    if primary:
        rules.add(primary)
    return rules


def select_playbook(cluster: Cluster, playbooks: list[Playbook]) -> tuple[Playbook | None, str]:
    """Pick the best-matching playbook for ``cluster``, or ``(None, reason)``.

    DETERMINISTIC. A criterion that is empty / ``None`` does not constrain:

    * ``rule_ids`` (any-of): intersect with the cluster rule set
      (``set(cluster.rule_values) | {cluster.primary_rule()}``, dropping ``None``).
    * ``entity_types`` (any-of): must contain ``cluster.entity.type.value``.
    * ``min_event_count``: ``cluster.count >= min_event_count``.
    * ``mitre`` / ``any_tags`` (any-of): clusters carry no MITRE/tags before
      investigation, so these match OPPORTUNISTICALLY against the (lowercased)
      cluster rule set — i.e. a rule named like a technique/tag still matches.

    Ties resolve by ``priority`` desc, then ``version`` desc, then ``id`` asc.
    """
    rule_set = _cluster_rule_set(cluster)
    rule_set_l = {r.lower() for r in rule_set}
    entity_type = cluster.entity.type.value
    count = cluster.count

    candidates: list[tuple[Playbook, str]] = []
    for pb in playbooks:
        m = pb.manifest.match
        reasons: list[str] = []

        if m.rule_ids:
            inter = {r for r in m.rule_ids if r in rule_set}
            if not inter:
                continue
            reasons.append("rule_ids∩{" + ",".join(sorted(inter)) + "}")

        if m.entity_types:
            if entity_type not in m.entity_types:
                continue
            reasons.append(f"entity_type={entity_type}")

        if m.min_event_count is not None:
            if count < m.min_event_count:
                continue
            reasons.append(f"count{count}>={m.min_event_count}")

        # mitre / any_tags are ADVISORY signals, NOT hard constraints: clusters carry
        # no MITRE techniques or tags at selection time (those come from the verdict,
        # AFTER investigation), so requiring them would make every technique-tagged
        # playbook unmatchable. They opportunistically BOOST the reason when a rule
        # name happens to carry the signal, but never exclude a rule/entity/count
        # match. (Deviation from the brief's "all-of" wording, forced by the real
        # pre-investigation cluster shape — documented in the module docstring.)
        if m.mitre:
            inter = {t for t in m.mitre if t.lower() in rule_set_l}
            if inter:
                reasons.append("mitre~{" + ",".join(sorted(inter)) + "}")

        if m.any_tags:
            inter = {t for t in m.any_tags if t.lower() in rule_set_l}
            if inter:
                reasons.append("tags~{" + ",".join(sorted(inter)) + "}")

        # A playbook whose ONLY declared criteria are the soft mitre/tags signals,
        # with no opportunistic hit, must not match everything by default — exclude
        # it. (A FULLY-unconstrained playbook with NO criteria at all still matches
        # everything, per the "absent criteria don't constrain" rule.)
        no_hard = not (m.rule_ids or m.entity_types or m.min_event_count is not None)
        declared_soft = bool(m.mitre or m.any_tags)
        if no_hard and declared_soft and not reasons:
            continue

        reason = "matched " + ("; ".join(reasons) if reasons else "unconstrained")
        reason += f"; priority={pb.manifest.priority}"
        candidates.append((pb, reason))

    if not candidates:
        return None, _NO_MATCH

    # priority desc, version desc, id asc — fully deterministic.
    candidates.sort(key=lambda pr: (-pr[0].manifest.priority, -pr[0].manifest.version, pr[0].manifest.id))
    return candidates[0]


class PlaybookRegistry:
    """A directory-backed registry of playbooks with atomic hot reload."""

    def __init__(self, directory: Path) -> None:
        self._directory = Path(directory)
        self._playbooks: list[Playbook] = []

    def reload(self) -> dict:
        """Reload from disk ATOMICALLY (validate-then-swap).

        Loads into a temp list; only swaps the live set if loading succeeded. A
        broken file is skipped (and reported in ``skipped``) but never replaces a
        good live set. Returns a summary
        ``{"loaded": int, "skipped": [{"file","reason"}], "ids": [...]}``.
        """
        skipped: list[dict[str, str]] = []
        try:
            base = self._directory
            md_files = sorted(base.glob("*.md")) if base.is_dir() else []
            loaded = load_playbooks(base)
            loaded_paths = {pb.source_path for pb in loaded}
            for path in md_files:
                if str(path) not in loaded_paths:
                    skipped.append({"file": str(path), "reason": "invalid_or_unparseable"})
        except Exception as exc:  # noqa: BLE001 — never let a reload crash the caller
            logger.warning("Playbook reload failed for %s: %s", self._directory, exc)
            return {
                "loaded": len(self._playbooks),
                "skipped": [{"file": str(self._directory), "reason": str(exc)}],
                "ids": [pb.id for pb in self._playbooks],
            }

        # Validate-then-swap: the live set only changes after a clean load.
        self._playbooks = loaded
        return {
            "loaded": len(loaded),
            "skipped": skipped,
            "ids": [pb.id for pb in loaded],
        }

    def load(self) -> dict:
        """Alias for ``reload`` (initial load)."""
        return self.reload()

    def all(self) -> list[Playbook]:
        return list(self._playbooks)

    def get(self, id: str) -> Playbook | None:
        for pb in self._playbooks:
            if pb.id == id:
                return pb
        return None

    def select(self, cluster: Cluster) -> tuple[Playbook | None, str]:
        return select_playbook(cluster, self.all())

    async def run(
        self, pipeline, cluster, source_surface, prefs, playbook_id: str, *, query_source=...
    ):
        """Manually RUN a specific playbook on a case (F10) — CONTEXT-ONLY.

        Re-investigates ``cluster`` through the SHARED pipeline with ``playbook_id``
        FORCED as the injected TRUSTED operator procedure (reusing the reinvestigate
        + playbook-injection path). It does NOT bypass the decision: the forced
        playbook can still only RECOMMEND, and ``case_manager.decide()`` makes the
        close/escalate call exactly as for an auto-selected playbook (#3).

        Raises ``KeyError`` when ``playbook_id`` is unknown so the caller can 404.
        Returns the updated :class:`app.models.Case`."""
        if self.get(playbook_id) is None:
            raise KeyError(playbook_id)
        kwargs = {"force": True, "force_playbook_id": playbook_id}
        if query_source is not ...:
            kwargs["query_source"] = query_source
        return await pipeline.investigate_cluster(
            cluster, source_surface, prefs, **kwargs
        )
