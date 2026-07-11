"""Deterministic correlation (Section 6.2).

Pure functions, no LLM. Per-rule config decides which entities cross a trigger
(``every`` / ``threshold`` / ``never``); a triggered entity then gathers ALL its
in-scope events in the batch (across rules) into one entity-centric cluster, so
"diversity of rule types hit" is a meaningful, auditable risk input.

It also records a deterministic ``TriggerReason`` (Feature 3) explaining WHY each
cluster fired (the primary triggering rule + matched window), surfaced in the UI.
"""

from __future__ import annotations

from collections import defaultdict
from typing import NamedTuple

from ..config import CorrelationRule, Preferences
from ..constants import CorrelationMode, EntityStrategy, EntityType
from ..models import Cluster, Entity, RawEvent, TriggerReason
from .signatures import cluster_signature, cross_source_signature


class _WindowDetail(NamedTuple):
    observed_count: int
    window_start: int
    window_end: int


# The entity-agnostic fallback ladder for the ``auto`` strategy: when an event's
# primary entity is missing we walk this so a case STILL forms (RULE is always
# last + always resolvable, so an in-scope event is never silently dropped).
_AUTO_LADDER = (EntityType.IP, EntityType.HOST, EntityType.USER, EntityType.RULE)
# Pinned strategies resolve their entity first, then fall through to RULE (so a
# pinned source whose event lacks that entity still clusters, never drops).
_PINNED_LADDER = {
    EntityStrategy.IP: (EntityType.IP, EntityType.RULE),
    EntityStrategy.HOST: (EntityType.HOST, EntityType.RULE),
    EntityStrategy.USER: (EntityType.USER, EntityType.RULE),
    EntityStrategy.RULE: (EntityType.RULE,),
}


def resolve_entity(
    ev: RawEvent, group_by: EntityType, strategy: EntityStrategy
) -> tuple[EntityType, str] | None:
    """Resolve the grouping (entity_type, value) for one event — entity-agnostic.

    Back-compat guarantee: with strategy ``auto`` the per-rule ``group_by`` entity
    is tried FIRST, so an event that HAS that entity groups EXACTLY as before. Only
    when the primary entity is missing do we walk the fallback ladder
    (IP → HOST → USER → RULE), so an in-scope event whose primary field is null is
    never silently dropped — a case STILL forms (grouped by host/user/rule).

    A pinned strategy (``ip``/``host``/``user``/``rule``) resolves that entity first
    (then RULE), giving the operator full control while keeping the never-drop
    guarantee. RULE is always resolvable (rule name + coarse time bucket)."""
    if strategy == EntityStrategy.AUTO:
        primary = ev.entity_value(group_by)
        if primary is not None:
            return group_by, primary
        ladder = _AUTO_LADDER
    else:
        ladder = _PINNED_LADDER.get(strategy, _AUTO_LADDER)
    for et in ladder:
        val = ev.entity_value(et)
        if val is not None:
            return et, val
    return None


def correlate(
    events: list[RawEvent],
    prefs: Preferences,
    *,
    entity_strategy: EntityStrategy | None = None,
    role: str | None = None,
) -> list[Cluster]:
    """Group a polled batch into candidate investigations (clusters).

    Entity-agnostic (NO-SOURCE-IP fix): each event's grouping entity is resolved by
    :func:`resolve_entity` under ``entity_strategy`` (defaults to
    ``prefs.entity_strategy``), so an event that lacks the primary entity still
    clusters (host/user/rule) instead of being silently dropped. With strategy
    ``auto`` and events that HAVE the per-rule ``group_by`` entity, grouping is
    byte-identical to before.

    Comprehensive ingestion (Autopilot overhaul, #1): the correlation MODE is derived
    from the FEED ROLE so every SIEM ALERT becomes exactly one case. An event carrying
    the ``alerts`` feed role (``ev.index_role == "alerts"``, stamped by the connector
    per its feed / by the push ingest for an alerts source) correlates with mode
    ``EVERY`` (n=1) — a lone detection forms a cluster instead of being hidden below the
    per-rule THRESHOLD. Same-signature bursts still COALESCE onto ONE open case downstream
    (``find_open_by_signature`` → attach, #4), so one alert type = one case that events
    attach to, never one-per-event. ``role`` is an OPTIONAL whole-batch role hint for a
    caller that KNOWS every event shares one role (e.g. the push path for a source declared
    wholesale ``alerts``); when ``"alerts"`` it forces the EVERY override for the whole
    batch even if a connector forgot to stamp ``index_role``. Default ``None`` + events-role
    (``index_role == "events"``) is byte-identical to before. This changes cluster FORMATION
    only; it NEVER touches ``decide()`` (#3)."""
    strategy = entity_strategy or prefs.entity_strategy
    batch_is_alerts = str(role or "").lower() == "alerts"
    # (entity_type, value) -> the PRIMARY triggering rule's metadata.
    triggers: dict[tuple[EntityType, str], dict] = {}

    by_rule: dict[str, list[RawEvent]] = defaultdict(list)
    for ev in events:
        by_rule[ev.rule or "unknown"].append(ev)

    # Resolve each bucket's rule name to its RuleDefinition (C3-1) so per-rule
    # correlation honours an inline/named override. When the bucket name has no
    # matching RuleDefinition (e.g. the catalog is empty, or a rule arrives that
    # is only configured via ``correlation_rules``) we keep the legacy
    # ``correlation_for(rule)`` lookup-by-name so behaviour is byte-identical.
    rule_defs = {rd.name: rd for rd in prefs.rule_catalog}
    for rule, rule_events in by_rule.items():
        rd = rule_defs.get(rule)
        cfg = prefs.correlation_for_def(rd) if rd is not None else prefs.correlation_for(rule)
        if cfg.mode == CorrelationMode.NEVER:
            continue
        group_by = cfg.group_by
        # Resolve each event to its (entity_type, value) — entity-agnostic, so an
        # event missing the primary entity still groups (never dropped).
        by_entity: dict[tuple[EntityType, str], list[RawEvent]] = defaultdict(list)
        for ev in rule_events:
            resolved = resolve_entity(ev, group_by, strategy)
            if resolved is not None:
                by_entity[resolved].append(ev)
        for (entity_type, value), group in by_entity.items():
            # ALERTS-role override (#1): a group carrying an alerts-role member (or a
            # whole batch declared ``alerts`` by the caller) correlates with mode EVERY
            # (n=1) so every SIEM detection forms EXACTLY one cluster — a lone alert is
            # never hidden below the THRESHOLD. Events-role groups keep ``cfg`` verbatim,
            # so the default correlate path is byte-identical. An explicit ``NEVER`` rule
            # is still respected (handled above) — that is the operator's suppression
            # escape hatch and wins even for alerts feeds.
            eff_cfg = cfg
            if batch_is_alerts or any(ev.index_role == "alerts" for ev in group):
                eff_cfg = cfg.model_copy(update={"mode": CorrelationMode.EVERY, "n": 1})
            detail = _window_detail(group, eff_cfg)
            if detail is None:
                continue
            sev = [g.severity for g in group if g.severity is not None]
            meta = {
                "rule_value": rule,
                "mode": eff_cfg.mode.value,
                "n": eff_cfg.n,
                "window_seconds": eff_cfg.window_seconds,
                "group_by": entity_type.value,
                "observed_count": detail.observed_count,
                "window_start": detail.window_start,
                "window_end": detail.window_end,
                "severity_min": min(sev) if sev else None,
                "severity_max": max(sev) if sev else None,
            }
            key = (entity_type, value)
            # Keep the PRIMARY rule (highest observed_count) for multi-rule entities.
            if key not in triggers or detail.observed_count > triggers[key]["observed_count"]:
                triggers[key] = meta

    clusters: list[Cluster] = []
    for (entity_type, value), meta in sorted(triggers.items(), key=lambda t: (t[0][0].value, t[0][1])):
        members = [ev for ev in events if ev.entity_value(entity_type) == value]
        if members:
            clusters.append(_build_cluster(entity_type, value, members, meta))
    return clusters


def _window_detail(events: list[RawEvent], cfg: CorrelationRule) -> _WindowDetail | None:
    """Return the matched-window detail if the rule triggers, else None.

    For ``every`` (or n<=1) any occurrence triggers; the window is the span of the
    entity's events for that rule. For ``threshold`` it is the densest window with
    >= n events.
    """
    if not events:
        return None
    times = sorted(ev.timestamp_millis for ev in events)
    if cfg.mode == CorrelationMode.EVERY or cfg.n <= 1:
        return _WindowDetail(len(events), times[0], times[-1])
    if len(events) < cfg.n:
        return None
    span = cfg.window_seconds * 1000
    best: _WindowDetail | None = None
    left = 0
    for right in range(len(times)):
        while times[right] - times[left] > span:
            left += 1
        count = right - left + 1
        if count >= cfg.n and (best is None or count > best.observed_count):
            best = _WindowDetail(count, times[left], times[right])
    return best


def _window_breach(events: list[RawEvent], n: int, window_seconds: int) -> bool:
    """Backwards-compatible bool wrapper over ``_window_detail``."""
    cfg = CorrelationRule(mode=CorrelationMode.THRESHOLD, n=max(1, n),
                          window_seconds=max(1, window_seconds))
    if n <= 1:
        return len(events) >= 1
    return _window_detail(events, cfg) is not None


def cluster_from_events(entity_type: EntityType, value: str, members: list[RawEvent]) -> Cluster:
    """Public builder for ad-hoc clusters (Surface 2 manual investigate)."""
    return _build_cluster(entity_type, value, members, None)


def _build_cluster(
    entity_type: EntityType,
    value: str,
    members: list[RawEvent],
    trigger_meta: dict | None,
) -> Cluster:
    members_sorted = sorted(members, key=lambda e: e.timestamp_millis)
    rule_values = sorted({ev.rule for ev in members if ev.rule})
    # For a RULE-grouped cluster ``value`` is the bucketed key "<rule>|<bucket>":
    # keep the bucket in the SIGNATURE (so distinct windows are distinct cases,
    # idempotent per bucket) but show the clean rule name as the entity value.
    display_value = value.rsplit("|", 1)[0] if entity_type == EntityType.RULE else value
    trigger_reason = _build_trigger_reason(entity_type, display_value, rule_values, trigger_meta)
    # Source provenance + alerts-role flag, derived from the member events. The
    # first member with a source_id wins; ``is_alert`` is true when ANY member
    # came from an alerts-role index pattern (→ auto-forward, bypassing allowlist).
    source_id = next((ev.source_id for ev in members_sorted if ev.source_id), None)
    source_name = next((ev.source_name for ev in members_sorted if ev.source_name), None)
    is_alert = any(ev.index_role == "alerts" for ev in members_sorted)
    # Distinct source ids that contributed members (Wave 5 multi-source provenance;
    # today a cluster is single-source, so this is usually 0/1 ids).
    source_ids = sorted({ev.source_id for ev in members_sorted if ev.source_id})
    # Per-feed severity_floor gate (Wave 6, #4): the cluster is auto-investigate-
    # eligible when ANY member is at/above its feed floor (or has no floor). Only an
    # ALL-below-floor cluster is blocked from auto-forward — and it is STILL a
    # candidate (never dropped). ``feed_ids`` records the contributing feeds.
    auto_investigate_eligible = any(ev.auto_investigate_eligible for ev in members_sorted)
    feed_ids = sorted({ev.feed_id for ev in members_sorted if ev.feed_id})
    return Cluster(
        signature=cluster_signature(entity_type, value, source_id=source_id),
        legacy_signature=(
            cluster_signature(entity_type, value) if source_id else None
        ),
        entity=Entity(type=entity_type, value=display_value),
        group_by=entity_type,
        rule_values=rule_values,
        member_event_ids=[ev.id for ev in members_sorted],
        member_event_keys=[ev.event_key() for ev in members_sorted],
        member_events=members_sorted,
        first_seen_millis=members_sorted[0].timestamp_millis,
        last_seen_millis=members_sorted[-1].timestamp_millis,
        count=len(members_sorted),
        trigger_reason=trigger_reason,
        source_id=source_id,
        source_name=source_name,
        is_alert=is_alert,
        source_ids=source_ids,
        auto_investigate_eligible=auto_investigate_eligible,
        feed_ids=feed_ids,
    )


def _build_trigger_reason(
    entity_type: EntityType, value: str, rule_values: list[str], meta: dict | None
) -> TriggerReason | None:
    if not meta:
        return None
    mode = meta["mode"]
    n = meta["n"]
    window_s = meta["window_seconds"]
    count = meta["observed_count"]
    rule = meta["rule_value"]
    smin, smax = meta.get("severity_min"), meta.get("severity_max")

    if mode == CorrelationMode.THRESHOLD.value:
        sentence = (
            f"{count} '{rule}' events from {entity_type.value} {value} within {window_s}s "
            f"(threshold N={n}, grouped by {meta['group_by']})"
        )
    elif mode == CorrelationMode.EVERY.value:
        sentence = (
            f"'{rule}' event from {entity_type.value} {value} "
            f"(rule configured to investigate every occurrence)"
        )
    else:
        sentence = f"{count} '{rule}' events from {entity_type.value} {value}"
    if smin is not None and smax is not None and (smin or smax):
        sentence += f"; severity {smin:g}–{smax:g}"

    return TriggerReason(
        rule_value=rule,
        mode=mode,
        n=n,
        window_seconds=window_s,
        group_by=meta["group_by"],
        observed_count=count,
        window_start=meta["window_start"],
        window_end=meta["window_end"],
        entity=f"{entity_type.value}:{value}",
        rule_values=rule_values,
        severity_min=smin,
        severity_max=smax,
        sentence=sentence,
    )


# --------------------------------------------------------------------------- #
# Cross-source correlation (Wave 5 / F6) — OPT-IN second pass, NEVER merges.
#
# The per-source pass above keeps the 1:1 cluster→case signature intact (#4). This
# pass takes the OPEN cases/clusters that share an entity within a time window and,
# when at least ``min_sources`` DISTINCT sources are involved, returns a stable,
# source-agnostic group id + its members — purely as RELATED metadata. It writes
# nothing: ``engine/ingest`` is the single place that applies the links onto cases.
# --------------------------------------------------------------------------- #
class CrossSourceItem(NamedTuple):
    """A normalised view of an open case/cluster the cross-source pass groups on.

    ``id`` is the case id (the link target); ``source_id`` is the originating source
    (distinct sources are what the ``min_sources`` floor counts); ``ts`` is a
    representative epoch-millis time (used for the window bucket); ``entities`` is the
    set of ``(EntityType, value)`` cross-source keys this item exposes."""

    id: str
    source_id: str
    ts: int
    entities: frozenset[tuple[EntityType, str]]


class CrossSourceComponentSeed(NamedTuple):
    """A previously persisted, bounded cross-source component.

    Seeds are advisory continuity edges supplied by the ingest layer.  The pure
    correlator intersects them with the current candidate ids, re-validates the
    distinct-source floor, and only emits a seeded component when it also contains
    a current eligible entity match.  Thus a dangling/stale id cannot enlarge the
    candidate pool or resurrect an unrelated component.
    """

    cross_source_cluster_id: str
    members: frozenset[str]


def _entity_keys(prefs: Preferences) -> list[EntityType]:
    """The configured cross-source entity types (lenient: unknown names dropped)."""
    out: list[EntityType] = []
    for key in prefs.cross_source_correlation.entity_keys:
        try:
            out.append(EntityType(str(key)))
        except ValueError:
            continue
    return out


def cluster_cross_source_entities(
    cluster: Cluster, entity_keys: list[EntityType]
) -> frozenset[tuple[EntityType, str]]:
    """The set of ``(entity_type, value)`` cross-source keys a cluster exposes.

    The cluster's PRIMARY entity is always included (when it is a cross-source key);
    additionally, every member event is scanned for the configured keys so a cluster
    grouped by IP still contributes its file_hash/domain to the cross-source pass."""
    found: set[tuple[EntityType, str]] = set()
    if cluster.entity.type in entity_keys and cluster.entity.value:
        found.add((cluster.entity.type, cluster.entity.value))
    for ev in cluster.member_events:
        for et in entity_keys:
            val = ev.cross_source_value(et)
            if val:
                found.add((et, val))
    return frozenset(found)


def cross_source_correlate(
    items: list[CrossSourceItem],
    prefs: Preferences,
    *,
    component_seeds: list[CrossSourceComponentSeed] | None = None,
) -> list[dict]:
    """Group open cases/clusters that share an entity across >= ``min_sources``
    DISTINCT sources within the configured window. Returns a list of groups
    ``{cross_source_cluster_id, entity_type, entity_value, members}`` and MERGES
    NOTHING — the caller applies the links as RELATED metadata.

    Behaviour:
      * Disabled (the default) → returns ``[]`` (no-op; single-source path unchanged).
      * Items are grouped by ``(entity_type, value, time-bucket)``; the bucket is the
        SAME source-agnostic floor used by :func:`cross_source_signature`, so the
        group id is stable + idempotent.
      * An entity group is eligible ONLY when its members span ``>= min_sources``
        distinct ``source_id`` values (so a single source never self-links).
      * Eligible groups that overlap by a case id are collapsed into ONE connected
        component before metadata is applied.  Optional persisted component seeds
        can extend such a current component, but cannot create one by themselves.
    """
    cfg = prefs.cross_source_correlation
    if not cfg.enabled or not items:
        return []
    window = max(1, int(cfg.time_window_seconds))
    min_sources = max(2, int(cfg.min_sources))

    # Bucket key -> {member case ids} and the distinct sources behind them.
    buckets: dict[tuple[str, str, int], dict[str, object]] = {}
    window_ms = window * 1000
    for item in items:
        bucket = (int(item.ts) // window_ms) if item.ts else 0
        for (et, value) in item.entities:
            if not value:
                continue
            key = (et.value, value, bucket)
            slot = buckets.setdefault(
                key, {"ids": [], "sources": set(), "entity_type": et, "value": value}
            )
            if item.id not in slot["ids"]:  # type: ignore[operator]
                slot["ids"].append(item.id)  # type: ignore[union-attr]
            slot["sources"].add(item.source_id)  # type: ignore[union-attr]

    groups: list[dict] = []
    for (_et_value, value, _bucket), slot in sorted(buckets.items()):
        sources = slot["sources"]  # type: ignore[index]
        if len(sources) < min_sources:
            continue
        et: EntityType = slot["entity_type"]  # type: ignore[assignment]
        ts_for_sig = _bucket * window_ms
        xid = cross_source_signature(et, value, ts_for_sig, window)
        groups.append({
            "cross_source_cluster_id": xid,
            "entity_type": et.value,
            "entity_value": value,
            "members": sorted(slot["ids"]),  # type: ignore[arg-type]
        })
    return _collapse_cross_source_components(
        groups,
        items,
        min_sources=min_sources,
        component_seeds=component_seeds or [],
    )


def _collapse_cross_source_components(
    groups: list[dict],
    items: list[CrossSourceItem],
    *,
    min_sources: int,
    component_seeds: list[CrossSourceComponentSeed],
) -> list[dict]:
    """Collapse overlapping eligible groups into deterministic components.

    The union-find is bounded by the ids already present in ``items``; seeds are
    intersected with that set and source-floor checked before they become edges.
    Output is restricted to components containing at least one freshly eligible
    entity group.  A single group keeps its historical entity-derived id.  When
    several brand-new ids overlap, the lexicographically smallest raw id is the
    canonical component id.  If a persisted component expands, its smallest valid
    seed id wins so adding a new entity edge does not rename an existing component.
    """
    if not groups:
        return []

    source_by_id = {item.id: item.source_id for item in items}
    known_ids = set(source_by_id)
    parent: dict[str, str] = {case_id: case_id for case_id in known_ids}

    def find(case_id: str) -> str:
        root = case_id
        while parent[root] != root:
            root = parent[root]
        while parent[case_id] != case_id:
            next_id = parent[case_id]
            parent[case_id] = root
            case_id = next_id
        return root

    def union(members: list[str]) -> None:
        if len(members) < 2:
            return
        # Always choose the lexical root; the partition is therefore deterministic
        # even before the final explicit sort (and requires no unbounded rank state).
        root = find(members[0])
        for member in members[1:]:
            other = find(member)
            if root == other:
                continue
            low, high = sorted((root, other))
            parent[high] = low
            root = low

    for group in groups:
        union(sorted(set(group["members"]) & known_ids))

    valid_seeds: list[CrossSourceComponentSeed] = []
    for seed in component_seeds:
        members = sorted(set(seed.members) & known_ids)
        if len(members) < 2:
            continue
        if len({source_by_id[case_id] for case_id in members}) < min_sources:
            continue
        valid_seed = CrossSourceComponentSeed(
            seed.cross_source_cluster_id if _valid_cross_source_cluster_id(
                seed.cross_source_cluster_id
            ) else "",
            frozenset(members),
        )
        valid_seeds.append(valid_seed)
        union(members)

    # Roots can change while later seed edges are unioned, so index metadata only
    # after the complete partition exists.
    raw_by_root: dict[str, list[dict]] = defaultdict(list)
    seed_ids_by_root: dict[str, set[str]] = defaultdict(set)
    for group in groups:
        members = sorted(set(group["members"]) & known_ids)
        if members:
            raw_by_root[find(members[0])].append(group)
    for seed in valid_seeds:
        members = sorted(seed.members)
        if members and seed.cross_source_cluster_id:
            seed_ids_by_root[find(members[0])].add(seed.cross_source_cluster_id)

    members_by_root: dict[str, list[str]] = defaultdict(list)
    for case_id in known_ids:
        members_by_root[find(case_id)].append(case_id)

    collapsed: list[dict] = []
    for root, raw_groups in raw_by_root.items():
        members = sorted(members_by_root[root])
        canonical_group = min(
            raw_groups,
            key=lambda group: (
                group["entity_type"],
                group["entity_value"],
                group["cross_source_cluster_id"],
                tuple(group["members"]),
            ),
        )
        raw_ids = {
            group["cross_source_cluster_id"]
            for group in raw_groups
            if _valid_cross_source_cluster_id(group["cross_source_cluster_id"])
        }
        persisted_ids = seed_ids_by_root.get(root, set())
        # Every raw group id is generated locally and valid.  Keep a defensive
        # fallback so malformed persisted metadata can never remove a component.
        # Existing canonical ids take precedence over newly observed entity hashes;
        # when two old components merge, lexical min is deterministic.
        if persisted_ids:
            canonical_id = min(persisted_ids)
        elif raw_ids:
            canonical_id = min(raw_ids)
        else:
            canonical_id = canonical_group["cross_source_cluster_id"]
        collapsed.append({
            "cross_source_cluster_id": canonical_id,
            "entity_type": canonical_group["entity_type"],
            "entity_value": canonical_group["entity_value"],
            "members": members,
        })

    return sorted(
        collapsed,
        key=lambda group: (
            group["cross_source_cluster_id"],
            tuple(group["members"]),
        ),
    )


def _valid_cross_source_cluster_id(value: object) -> bool:
    """Return whether ``value`` has the locally generated 128-bit hex-id shape."""
    text = str(value or "")
    return len(text) == 32 and all(char in "0123456789abcdef" for char in text)
