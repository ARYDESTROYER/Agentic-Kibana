"""Deterministic risk scoring (Section 6.2).

A weighted, normalised (0-100) function over volume, velocity, entity reputation,
rule-type diversity and asset criticality. Pure and reproducible — the model
later *interprets* the score but never computes it. Reputation is passed in
(already fetched from the Redis-cached enrichment tool) to keep this function
synchronous and trivially testable.
"""

from __future__ import annotations

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


def compute_risk(cluster: Cluster, prefs: Preferences, reputation: float = 0.0) -> RiskBreakdown:
    weights = prefs.risk_weights

    volume = _log_norm(cluster.count, _VOLUME_REF)

    window_minutes = max(cluster.window_seconds / 60.0, 1e-6)
    rate = cluster.count / window_minutes if cluster.count > 1 else 0.0
    velocity = min(100.0, 100.0 * rate / _VELOCITY_REF)

    reputation = max(0.0, min(100.0, reputation))

    diversity = min(100.0, 100.0 * len(cluster.rule_values) / _DIVERSITY_REF)

    asset = float(prefs.asset_criticality.get(cluster.entity.value, 0.0))
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
