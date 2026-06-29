"""Provider implementations behind a uniform interface.

The gateway is the only caller. Providers never touch Elasticsearch, never write
the usage ledger, and never make policy decisions — they only turn a request into
text + token counts. This keeps the swap-in seam (LiteLLM/vLLM) trivial.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger("tlsoc.llm.providers")


@dataclass
class CompletionResult:
    text: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    model: str = ""
    cost: float = 0.0  # populated by the gateway after metering (per-case cost rollup)


@dataclass
class EmbeddingResult:
    vectors: list[list[float]]
    tokens: int = 0


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def _is_reasoning_or_gpt5(model: str) -> bool:
    """True for OpenAI models that reject ``temperature`` and require
    ``max_completion_tokens`` instead of ``max_tokens``.

    Covers the GPT-5 family (``gpt-5``, ``gpt-5-mini``, ...) and the o-series
    reasoning models (``o1``/``o3``/``o4`` prefixes, e.g. ``o4-mini``). All other
    OpenAI chat models (gpt-4*, gpt-4o*, gpt-3.5*) keep the classic params."""
    return model.startswith("gpt-5") or model.startswith(("o1", "o3", "o4"))


class BaseProvider:
    async def complete(
        self,
        role: str,
        messages: list[dict[str, str]],
        model: str,
        temperature: float,
        max_tokens: int,
    ) -> CompletionResult:
        raise NotImplementedError

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        raise NotImplementedError(f"{type(self).__name__} does not support embeddings")

    async def aclose(self) -> None:
        return None


# --------------------------------------------------------------------------- #
# Anthropic
# --------------------------------------------------------------------------- #
class AnthropicProvider(BaseProvider):
    def __init__(self, api_key: str, base_url: str = "https://api.anthropic.com") -> None:
        self._key = api_key
        self._client = httpx.AsyncClient(base_url=base_url, timeout=60.0)

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        system_parts = [m["content"] for m in messages if m.get("role") == "system"]
        convo = [
            {"role": ("assistant" if m["role"] == "assistant" else "user"), "content": m["content"]}
            for m in messages
            if m.get("role") in ("user", "assistant")
        ]
        if not convo:
            convo = [{"role": "user", "content": "\n".join(system_parts) or ""}]
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": convo,
        }
        if system_parts:
            payload["system"] = "\n\n".join(system_parts)
        resp = await self._client.post(
            "/v1/messages",
            headers={
                "x-api-key": self._key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        text = "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")
        usage = data.get("usage", {})
        return CompletionResult(
            text=text,
            prompt_tokens=int(usage.get("input_tokens", _estimate_tokens(str(messages)))),
            completion_tokens=int(usage.get("output_tokens", _estimate_tokens(text))),
            model=model,
        )

    async def aclose(self) -> None:
        await self._client.aclose()


# --------------------------------------------------------------------------- #
# OpenAI (chat + embeddings)
# --------------------------------------------------------------------------- #
class OpenAIProvider(BaseProvider):
    def __init__(self, api_key: str, base_url: str = "https://api.openai.com") -> None:
        self._key = api_key
        self._client = httpx.AsyncClient(base_url=base_url, timeout=60.0)

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        if _is_reasoning_or_gpt5(model):
            # GPT-5 family + o-series reasoning models reject ``temperature`` and
            # use ``max_completion_tokens`` rather than ``max_tokens``.
            payload["max_completion_tokens"] = max_tokens
        else:
            payload["temperature"] = temperature
            payload["max_tokens"] = max_tokens
        resp = await self._client.post(
            "/v1/chat/completions",
            headers={"Authorization": f"Bearer {self._key}", "content-type": "application/json"},
            json=payload,
        )
        resp.raise_for_status()
        data = resp.json()
        text = data["choices"][0]["message"]["content"] or ""
        usage = data.get("usage", {})
        return CompletionResult(
            text=text,
            prompt_tokens=int(usage.get("prompt_tokens", _estimate_tokens(str(messages)))),
            completion_tokens=int(usage.get("completion_tokens", _estimate_tokens(text))),
            model=model,
        )

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        resp = await self._client.post(
            "/v1/embeddings",
            headers={"Authorization": f"Bearer {self._key}", "content-type": "application/json"},
            json={"model": model, "input": texts},
        )
        resp.raise_for_status()
        data = resp.json()
        vectors = [item["embedding"] for item in data["data"]]
        tokens = int(data.get("usage", {}).get("prompt_tokens", sum(_estimate_tokens(t) for t in texts)))
        return EmbeddingResult(vectors=vectors, tokens=tokens)

    async def aclose(self) -> None:
        await self._client.aclose()


# --------------------------------------------------------------------------- #
# Mock — deterministic, free, no network. Powers tests and key-less demos.
# --------------------------------------------------------------------------- #
class MockProvider(BaseProvider):
    """Returns scripted or role-appropriate canned responses.

    Tests push exact responses per role via ``push``; absent a script it returns
    a safe default (router -> uncertain so the pipeline proceeds; investigator/
    formatter -> NEEDS_HUMAN so nothing is ever auto-closed by accident).
    """

    def __init__(self) -> None:
        self.scripts: dict[str, list[str]] = {}
        self.calls: list[dict[str, Any]] = []

    def push(self, role: str, text: str) -> None:
        self.scripts.setdefault(role, []).append(text)

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        self.calls.append({"role": role, "messages": messages, "model": model})
        queue = self.scripts.get(role)
        text = queue.pop(0) if queue else self._default(role, messages)
        return CompletionResult(
            text=text,
            prompt_tokens=_estimate_tokens(json.dumps(messages)),
            completion_tokens=_estimate_tokens(text),
            model=model,
        )

    async def embed(self, texts: list[str], model: str) -> EmbeddingResult:
        # Deterministic hashing embedding so RAG works offline.
        return EmbeddingResult(vectors=[_hash_embed(t) for t in texts], tokens=sum(_estimate_tokens(t) for t in texts))

    @staticmethod
    def _default(role: str, messages: list[dict[str, str]]) -> str:
        if role == "router":
            return json.dumps({"bucket": "uncertain", "reason": "mock: routed to investigator"})
        if role == "investigator":
            return json.dumps({
                "action": "final",
                "reasoning": "Mock investigator: no live model configured.",
                "verdict": {
                    "verdict": "NEEDS_HUMAN",
                    "confidence": 0.0,
                    "evidence": [{"summary": "Mock mode — manual review required.", "event_ids": []}],
                    "mitre": [],
                    "recommended_action": "Configure an LLM provider key and re-run; routed to human.",
                    "reproduce_query": "",
                },
            })
        if role == "formatter":
            return json.dumps({
                "verdict": "NEEDS_HUMAN",
                "confidence": 0.0,
                "evidence": [{"summary": "Mock formatter — manual review required.", "event_ids": []}],
                "mitre": [],
                "recommended_action": "Configure an LLM provider key.",
                "reproduce_query": "",
            })
        if role == "standup":
            return "Mock daily standup: the deterministic aggregate is available; configure an LLM key for prose."
        if role == "chat":
            return json.dumps({
                "answer": "Mock chat response — configure an LLM provider key for live answers.",
                "needs_query": False,
                "query": None,
            })
        return "mock response"


# --------------------------------------------------------------------------- #
# Demo — deterministic, $0, scenario-keyed. Powers Demo Mode investigations.
# --------------------------------------------------------------------------- #
class DemoMockProvider(MockProvider):
    """A deterministic provider whose verdict is KEYED to the storyline a cluster
    belongs to, so the SAME synthetic storyline always yields the SAME verdict /
    confidence (Wave 5). The benign baseline resolves to a confident FALSE_POSITIVE
    (which flows through the REAL ``decide()`` against a sandboxed policy, proving
    the deterministic gate); a NEEDS_HUMAN storyline stays OPEN for the HITL
    showcase. It never makes a network call and never spends a token.

    It inspects the role + the prompt text (which carries the fenced synthetic event
    summaries) to resolve the scenario by the distinctive synthetic rule names —
    no RNG, no clock — so a run is byte-reproducible."""

    async def complete(self, role, messages, model, temperature, max_tokens) -> CompletionResult:
        self.calls.append({"role": role, "messages": messages, "model": model})
        # A pushed script (tests) still wins, mirroring MockProvider.
        queue = self.scripts.get(role)
        if queue:
            text = queue.pop(0)
        else:
            text = self._demo_default(role, messages)
        return CompletionResult(
            text=text,
            prompt_tokens=_estimate_tokens(json.dumps(messages)),
            completion_tokens=_estimate_tokens(text),
            model=model,
        )

    @staticmethod
    def _resolve(messages: list[dict[str, str]]):
        """Resolve the storyline a prompt belongs to by scanning for the distinctive
        synthetic rule UID/name. Returns the Storyline or None (benign baseline)."""
        from ..engine.demo_generator import _RULE_TO_STORY, _STORYLINE_BY_ID

        blob = "\n".join(str(m.get("content", "")) for m in messages)
        for marker, sid in _RULE_TO_STORY.items():
            if marker in blob:
                return _STORYLINE_BY_ID[sid]
        return None

    def _demo_default(self, role: str, messages: list[dict[str, str]]) -> str:
        story = self._resolve(messages)
        if role == "router":
            # Route every demo cluster to the strong investigator so the showcase
            # exercises the full pipeline.
            return json.dumps({"bucket": "needs_strong_model", "reason": "demo: investigate"})
        if story is not None:
            verdict = story.expected_verdict.value
            confidence = story.expected_confidence
            mitre = list(story.techniques)
            action = ("Contain affected hosts and rotate credentials."
                      if verdict == "TRUE_POSITIVE"
                      else "Analyst review required (impossible to auto-close)."
                      if verdict == "NEEDS_HUMAN" else "No action required.")
            summary = f"Demo storyline '{story.name}' — {verdict}."
        else:
            # Benign baseline → a CONFIDENT false positive so it flows through the
            # REAL decide() against the sandboxed policy.
            verdict, confidence, mitre = "FALSE_POSITIVE", 0.97, []
            action = "Benign baseline activity; no action required."
            summary = "Demo benign baseline — false positive."
        payload = {
            "verdict": verdict,
            "confidence": confidence,
            "evidence": [{"summary": summary, "event_ids": []}],
            "mitre": mitre,
            "recommended_action": action,
            "reproduce_query": "",
        }
        if role == "investigator":
            return json.dumps({"action": "final", "reasoning": summary, "verdict": payload})
        if role in ("formatter", "overview"):
            return json.dumps(payload)
        if role == "standup":
            return "Demo standup: synthetic activity summarised (no live model)."
        if role == "chat":
            return json.dumps({"answer": "Demo chat response (synthetic).", "needs_query": False, "query": None})
        return json.dumps(payload)


def _hash_embed(text: str, dim: int = 256) -> list[float]:
    import hashlib
    import math

    vec = [0.0] * dim
    for token in text.lower().split():
        h = int(hashlib.md5(token.encode()).hexdigest(), 16)
        vec[h % dim] += 1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]
