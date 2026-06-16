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
    # --- Embeddings (input only) ---
    "text-embedding-3-small": (0.02, 0.0),
    "text-embedding-3-large": (0.13, 0.0),
    # --- Mock provider is free ---
    "mock": (0.0, 0.0),
}

_DEFAULT_PRICE = (1.0, 3.0)


def cost_for(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    in_price, out_price = PRICES.get(model, _DEFAULT_PRICE)
    if model.startswith("mock"):
        return 0.0
    return round(
        (prompt_tokens / 1_000_000.0) * in_price
        + (completion_tokens / 1_000_000.0) * out_price,
        8,
    )
