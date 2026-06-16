"""Token price table (USD per 1,000,000 tokens).

Prices are approximate public list prices and are intentionally easy to edit —
the cost ledger's accuracy depends only on this one table. Unknown models fall
back to a conservative default so a call's cost is never silently zero.
"""

from __future__ import annotations

# model -> (input_usd_per_million, output_usd_per_million)
PRICES: dict[str, tuple[float, float]] = {
    # --- Anthropic ---
    "claude-opus-4-8": (15.0, 75.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5-20251001": (1.0, 5.0),
    # --- OpenAI ---
    "gpt-4o": (2.5, 10.0),
    "gpt-4o-mini": (0.15, 0.60),
    # operator-verifiable approximate USD/1M tokens — edit in pricing.py and rebuild
    "gpt-4.1": (2.0, 8.0),
    "gpt-4.1-mini": (0.40, 1.60),
    "gpt-4-turbo": (10.0, 30.0),
    "gpt-4": (30.0, 60.0),
    "o4-mini": (1.10, 4.40),
    "gpt-5": (1.25, 10.0),
    "gpt-5-mini": (0.25, 2.0),
    # --- Embeddings (input only) ---
    "text-embedding-3-small": (0.02, 0.0),
    "text-embedding-3-large": (0.13, 0.0),
    # --- Mock provider is free ---
    "mock": (0.0, 0.0),
}

_DEFAULT_PRICE = (1.0, 3.0)


def provider_for(model: str) -> str:
    """Group a price-table model id by its provider (Feature 4).

    ``claude-*`` -> anthropic; ``gpt-*`` / ``o1``/``o3``/``o4``-series /
    ``text-embedding-*`` -> openai; ``mock`` -> mock. Anything unrecognised is
    bucketed under ``other`` so a new model never disappears from the catalog."""
    if model.startswith("claude-"):
        return "anthropic"
    if (
        model.startswith("gpt-")
        or model.startswith("text-embedding-")
        or model.startswith(("o1", "o3", "o4"))
    ):
        return "openai"
    if model.startswith("mock"):
        return "mock"
    return "other"


def models_by_provider() -> dict[str, list[str]]:
    """The price-table models grouped by provider, each list sorted (Feature 4)."""
    grouped: dict[str, list[str]] = {"anthropic": [], "openai": [], "mock": []}
    for model in PRICES:
        grouped.setdefault(provider_for(model), []).append(model)
    return {provider: sorted(models) for provider, models in grouped.items()}


def cost_for(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    in_price, out_price = PRICES.get(model, _DEFAULT_PRICE)
    if model.startswith("mock"):
        return 0.0
    return round(
        (prompt_tokens / 1_000_000.0) * in_price
        + (completion_tokens / 1_000_000.0) * out_price,
        8,
    )
