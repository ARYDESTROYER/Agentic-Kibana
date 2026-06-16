"""LLM gateway layer.

Every model call in the suite passes through ``LLMGateway`` (Section 7.3 /
Non-negotiable #6), which is the single place the token/cost ledger is written
and the single seam where a future LiteLLM/vLLM gateway can be swapped in by
config alone (Section 3.3).
"""
