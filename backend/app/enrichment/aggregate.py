"""Reputation fusion + #9 fencing for enrichment provider results.

Two concerns live here:

1. :func:`fuse` collapses a list of :class:`app.models.ProviderResult` into one
   normalised :class:`FusedReputation`. The DEFAULT path is **byte-identical to the
   legacy ``EnrichTool``**: ``reputation_score = max(score over ok providers)``,
   clamped to 0..100, ``is_malicious = score >= 50``. This is what the legacy
   ``enrich_ip`` returns and what the deterministic risk scorer consumes, so #3 is
   untouched. A confidence-weighted fusion is implemented but GATED behind
   ``EnrichmentConfig.fusion_enabled`` (default False) — operators opt in.

2. :func:`fence_provider_result` neutralises every attacker-influenceable string a
   provider returned (tags, raw blob values, PTR/banner/category text) as labelled
   UNTRUSTED data BEFORE it can reach a prompt or be trusted by the UI (#9). It
   delegates to the canonical :func:`app.agents.prompts.fence` so the exact same
   forged-marker neutralisation + provenance tagging applies.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from pydantic import BaseModel, Field

from ..models import ProviderResult

if TYPE_CHECKING:
    from ..config import EnrichmentConfig

logger = logging.getLogger("tlsoc.enrichment.aggregate")


class FusedReputation(BaseModel):
    """The fused reputation across all providers for one indicator.

    ``reputation_score`` (0..100) + ``is_malicious`` are what downstream consumers
    (risk scorer, threat-context panel, the legacy ``EnrichmentResult``) read.
    ``method`` records which fusion path produced it (``"max"`` is the legacy
    default; ``"weighted"`` is the opt-in confidence-weighted blend). ``country`` is
    the first provider-reported country. ``per_provider`` keeps each provider's score
    keyed by name (the legacy ``EnrichmentResult.sources`` shape), and ``providers``
    keeps the raw results for the UI panel."""

    indicator: str = ""
    indicator_kind: str = ""
    reputation_score: float = 0.0
    is_malicious: bool = False
    country: str | None = None
    method: str = "max"
    per_provider: dict[str, Any] = Field(default_factory=dict)
    providers: list[ProviderResult] = Field(default_factory=list)
    errors: dict[str, str] = Field(default_factory=dict)


def _ok_scores(results: list[ProviderResult]) -> list[tuple[ProviderResult, float]]:
    """The (result, score) pairs for providers that returned a usable score."""
    pairs: list[tuple[ProviderResult, float]] = []
    for r in results:
        if not r.ok or r.score is None:
            continue
        try:
            pairs.append((r, float(r.score)))
        except (TypeError, ValueError):  # defensive — a bad score is ignored
            continue
    return pairs


def fuse(
    results: list[ProviderResult],
    cfg: "EnrichmentConfig | None" = None,
    *,
    malicious_threshold: float = 50.0,
) -> FusedReputation:
    """Fuse provider results into one reputation.

    DEFAULT (``cfg is None`` or ``cfg.fusion_enabled`` falsey): legacy ``max(score)``
    — byte-identical to ``EnrichTool``. When ``cfg.fusion_enabled`` is True, a
    confidence-weighted average is used instead (still clamped to 0..100). FAIL-SAFE:
    any internal error falls back to the legacy ``max`` so enrichment never breaks."""
    fused = FusedReputation()
    country: str | None = None
    for r in results:
        if r.score is not None:
            fused.per_provider[r.provider] = r.score
        if r.error:
            fused.errors[r.provider] = r.error
        c = (r.raw or {}).get("country") or (r.raw or {}).get("countryCode")
        if c and country is None:
            country = str(c)
        if r.indicator and not fused.indicator:
            fused.indicator = r.indicator
        if r.indicator_kind and not fused.indicator_kind:
            fused.indicator_kind = r.indicator_kind
    fused.providers = list(results)
    fused.country = country

    pairs = _ok_scores(results)
    if not pairs:
        fused.reputation_score = 0.0
        fused.is_malicious = False
        fused.method = "max"
        return fused

    use_weighted = bool(cfg is not None and getattr(cfg, "fusion_enabled", False))
    if use_weighted:
        try:
            score = _weighted_score(pairs)
            fused.method = "weighted"
        except Exception as exc:  # noqa: BLE001 — fail safe to legacy max()
            logger.warning("weighted fusion failed (%s); falling back to max()", exc)
            score = max(s for _, s in pairs)
            fused.method = "max"
    else:
        # LEGACY, byte-identical: the maximum provider score.
        score = max(s for _, s in pairs)
        fused.method = "max"

    score = max(0.0, min(100.0, float(score)))
    fused.reputation_score = score
    fused.is_malicious = score >= malicious_threshold
    return fused


def _weighted_score(pairs: list[tuple[ProviderResult, float]]) -> float:
    """Confidence-weighted average of provider scores (opt-in fusion).

    Each provider's score is weighted by its self-reported ``confidence`` (defaulting
    to 0.5 when a provider gives none) so a high-confidence verdict dominates a
    low-confidence one. Reduces to a plain average when all confidences are equal."""
    total_w = 0.0
    acc = 0.0
    for r, s in pairs:
        w = r.confidence if (r.confidence is not None) else 0.5
        try:
            w = float(w)
        except (TypeError, ValueError):
            w = 0.5
        w = max(0.0, min(1.0, w))
        if w <= 0.0:
            w = 0.01  # never fully discard a provider that returned a score
        total_w += w
        acc += w * s
    if total_w <= 0.0:
        return max(s for _, s in pairs)
    return acc / total_w


# --------------------------------------------------------------------------- #
# #9 — fence every provider-returned string before a prompt / the UI
# --------------------------------------------------------------------------- #
def fence_provider_value(value: Any, *, provider: str = "") -> str:
    """Fence ONE provider-returned string as labelled UNTRUSTED data (#9).

    Delegates to the canonical :func:`app.agents.prompts.fence` so the exact same
    forged-marker neutralisation + provenance tagging applies. ``source="enrichment"``
    + the ``tool=<provider>`` tag record where the (attacker-influenceable) value came
    from. Import is local to avoid an import cycle (prompts imports models)."""
    from ..agents.prompts import fence  # local import: avoid models<->prompts cycle

    return fence(value, source="enrichment", tool=provider or None)


def fence_provider_result(result: ProviderResult) -> dict[str, Any]:
    """Render a provider result for a prompt/UI with every untrusted string fenced (#9).

    Tags + the raw-blob string values + the indicator itself are all source/provider-
    influenceable, so each is wrapped with :func:`fence_provider_value`. Numeric /
    boolean fields (score, malicious, confidence, ok) are trusted control values and
    pass through. The returned dict is safe to interpolate into a prompt or hand to
    the UI as plain (already-escaped) text."""
    p = result.provider or ""

    def _fence_scalar(v: Any) -> Any:
        # Only strings are attacker-influenceable; numbers/bools/None pass through.
        if isinstance(v, str):
            return fence_provider_value(v, provider=p)
        return v

    fenced_raw: dict[str, Any] = {}
    for k, v in (result.raw or {}).items():
        if isinstance(v, str):
            fenced_raw[k] = fence_provider_value(v, provider=p)
        elif isinstance(v, list):
            fenced_raw[k] = [_fence_scalar(item) for item in v]
        elif isinstance(v, dict):
            fenced_raw[k] = {kk: _fence_scalar(vv) for kk, vv in v.items()}
        else:
            fenced_raw[k] = v

    return {
        "provider": p,  # provider id is our own constant, not attacker text
        "indicator": fence_provider_value(result.indicator, provider=p),
        "indicator_kind": result.indicator_kind,
        "score": result.score,
        "malicious": result.malicious,
        "confidence": result.confidence,
        "tags": [fence_provider_value(t, provider=p) for t in (result.tags or [])],
        "raw": fenced_raw,
        "ok": result.ok,
        "error": fence_provider_value(result.error, provider=p) if result.error else None,
    }


__all__ = [
    "FusedReputation",
    "fuse",
    "fence_provider_value",
    "fence_provider_result",
]
