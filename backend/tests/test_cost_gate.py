"""Tests for CaseBudget (cost gate — per-case caps and kill switch)."""

from __future__ import annotations

from app.config import CapsConfig
from app.engine.cost_gate import CaseBudget


def test_default_caps_allow_calls_and_tokens():
    budget = CaseBudget(CapsConfig())
    assert budget.kill_switch is False
    assert budget.can_call_tool() is True
    assert budget.capped_reason is None


def test_kill_switch_blocks_tool_and_exceeded():
    budget = CaseBudget(CapsConfig(kill_switch=True))
    assert budget.kill_switch is True
    assert budget.can_call_tool() is False
    assert "kill switch" in (budget.capped_reason or "")
    assert budget.exceeded() is True


def test_tool_call_limit():
    budget = CaseBudget(CapsConfig(max_tool_calls=2))
    assert budget.can_call_tool() is True
    budget.record_tool_call()
    assert budget.tool_calls == 1
    assert budget.can_call_tool() is True
    budget.record_tool_call()
    assert budget.tool_calls == 2
    assert budget.can_call_tool() is False
    assert "max_tool_calls" in (budget.capped_reason or "")


def test_add_tokens_accumulates():
    budget = CaseBudget(CapsConfig(max_tokens=100))
    budget.add_tokens(30, 20)
    assert budget.tokens == 50
    assert budget.exceeded() is False
    budget.add_tokens(40, 20)
    assert budget.tokens == 110
    assert budget.exceeded() is True
    assert "max_tokens" in (budget.capped_reason or "")


def test_zero_tool_calls_and_tokens_defaults():
    budget = CaseBudget(CapsConfig(max_tool_calls=0, max_tokens=0))
    assert budget.can_call_tool() is False
    assert "max_tool_calls" in (budget.capped_reason or "")
    budget2 = CaseBudget(CapsConfig(max_tool_calls=5, max_tokens=0))
    budget2.add_tokens(0, 0)
    assert budget2.exceeded() is True
    assert "max_tokens" in (budget2.capped_reason or "")


def test_record_tool_call_increments_from_zero():
    budget = CaseBudget(CapsConfig())
    assert budget.tool_calls == 0
    budget.record_tool_call()
    assert budget.tool_calls == 1
    budget.record_tool_call()
    budget.record_tool_call()
    assert budget.tool_calls == 3


def test_exceeded_reason_is_set_and_persisted():
    budget = CaseBudget(CapsConfig(max_tokens=50))
    budget.add_tokens(60, 0)
    assert budget.exceeded() is True
    reason = budget.capped_reason
    assert reason is not None and "max_tokens" in reason
    assert budget.exceeded() is True
    assert budget.capped_reason == reason


def test_initial_state():
    caps = CapsConfig(max_tool_calls=10, max_tokens=5000)
    budget = CaseBudget(caps)
    assert budget.tool_calls == 0
    assert budget.tokens == 0
    assert budget.capped_reason is None
    assert budget.can_call_tool() is True
    assert budget.exceeded() is False
