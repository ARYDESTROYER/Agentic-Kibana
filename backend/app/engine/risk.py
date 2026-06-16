"""Deterministic risk scoring (Section 6.2).

A weighted, normalised (0-100) function over volume, velocity, entity reputation,
rule-type diversity and asset criticality. Pure and reproducible — the model
later *interprets* the score but never computes it. Reputation is passed in
(already fetched from the Redis-cached enrichment tool) to keep this function
synchronous and trivially testable.
"""

from __future__ import annotations

import ipaddress
import math

from ..config import Preferences
from ..models import Cluster, RiskBreakdown

# Reference points at which a factor reaches ~full score.
_VOLUME_REF = 50          # events
_VELOCITY_REF = 10.0      # events per minute
_DIVERSITY_REF = 5        # distinct rule types


def _log_norm(value: float, ref: float) -> float:
    if value <= 0:
        return 0.0
    return min(100.0, 100.0 * math.log1p(value) / math.log1p(ref))


def _asset_criticality(entity_value: str, prefs: Preferences) -> float:
    """Internal-asset policy (P2): if the entity is an IP inside any configured
    ``asset_networks`` CIDR, use that criticality (the MAX if several match);
    otherwise fall back to the exact-value ``asset_criticality`` map."""
    network_crit: float | None = None
    if prefs.asset_networks:
        try:
            addr = ipaddress.ip_address(entity_value)
        except ValueError:
            addr = None
        if addr is not None:
            for net in prefs.asset_networks:
                try:
                    cidr = ipaddress.ip_network(net.cidr, strict=False)
                except ValueError:
                    continue
                if addr in cidr:
                    network_crit = max(network_crit or 0.0, float(net.criticality))
    if network_crit is not None:
        return network_crit
    return float(prefs.asset_criticality.get(entity_value, 0.0))


def compute_risk(cluster: Cluster, prefs: Preferences, reputation: float = 0.0) -> RiskBreakdown:
    weights = prefs.risk_weights

    volume = _log_norm(cluster.count, _VOLUME_REF)

    # Velocity edge (P2): a tiny same-millisecond burst must NOT saturate velocity
    # to 100. Require count >= 3 AND an effective window floor of >= 1s before
    # velocity contributes; otherwise velocity = 0. (Two same-ms events would
    # otherwise divide by a ~0 window and pin velocity at 100.)
    if cluster.count >= 3:
        window_minutes = max(cluster.window_seconds, 1.0) / 60.0
        rate = cluster.count / window_minutes
        velocity = min(100.0, 100.0 * rate / _VELOCITY_REF)
    else:
        velocity = 0.0

    reputation = max(0.0, min(100.0, reputation))

    diversity = min(100.0, 100.0 * len(cluster.rule_values) / _DIVERSITY_REF)

    asset = _asset_criticality(cluster.entity.value, prefs)
    asset = max(0.0, min(100.0, asset))

    total_weight = (
        weights.volume + weights.velocity + weights.reputation
        + weights.diversity + weights.asset_criticality
    ) or 1.0
    total = (
        weights.volume * volume
        + weights.velocity * velocity
        + weights.reputation * reputation
        + weights.diversity * diversity
        + weights.asset_criticality * asset
    ) / total_weight

    return RiskBreakdown(
        volume=round(volume, 2),
        velocity=round(velocity, 2),
        reputation=round(reputation, 2),
        diversity=round(diversity, 2),
        asset_criticality=round(asset, 2),
        total=round(total, 2),
    )
