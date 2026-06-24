"""Cost gate helpers (Section 6.3).

Layered filtering keeps the expensive model away from most volume:
  1. query-time severity/scope filtering  -> ``es/querybuilder.scope_filters`` (free)
  2. dedup/suppression                     -> ``passes_suppression`` + open-case attach (free)
  3. cheap-router triage                   -> ``agents/router`` (cheap)
  4. per-case caps / kill switch           -> ``CaseBudget`` (safety)

This module owns layers 2 and 4.
"""

from __future__ import annotations

from ..config import CapsConfig, Preferences
from ..models import Cluster
from ..utils import dotted_get


def passes_suppression(cluster: Cluster, prefs: Preferences) -> bool:
    """False if EVERY member event matches a suppression rule (defence in depth;
    the query already excludes suppressed events at layer 1).

    Only LIVE rules count: a disabled or expired rule is skipped here AND at the
    query layer (``querybuilder.scope_must_not``), so toggling ``enabled`` off / an
    ``expires_at`` lapsing immediately stops suppressing without deleting the rule.
    Existing rules (no new fields) are always live (enabled True / no expiry)."""
    rules = [r for r in prefs.suppression_rules if r.is_live()]
    if not rules:
        return True
    for ev in cluster.member_events:
        suppressed = any(str(dotted_get(ev.source, r.field)) == r.value for r in rules)
        if not suppressed:
            return True
    return False


class CaseBudget:
    """Per-case caps and kill switch (Section 6.3 #4).

    A malformed alert cannot trigger runaway spend: tool calls and tokens are
    capped, and ``exceeded`` short-circuits the investigator loop.
    """

    def __init__(self, caps: CapsConfig) -> None:
        self._caps = caps
        self.tool_calls = 0
        self.tokens = 0
        self.capped_reason: str | None = None

    @property
    def kill_switch(self) -> bool:
        return self._caps.kill_switch

    def can_call_tool(self) -> bool:
        if self._caps.kill_switch:
            self.capped_reason = "kill switch engaged"
            return False
        if self.tool_calls >= self._caps.max_tool_calls:
            self.capped_reason = f"max_tool_calls ({self._caps.max_tool_calls}) reached"
            return False
        return True

    def record_tool_call(self) -> None:
        self.tool_calls += 1

    def add_tokens(self, prompt_tokens: int, completion_tokens: int) -> None:
        self.tokens += prompt_tokens + completion_tokens

    def exceeded(self) -> bool:
        if self._caps.kill_switch:
            self.capped_reason = "kill switch engaged"
            return True
        if self.tokens >= self._caps.max_tokens:
            self.capped_reason = f"max_tokens ({self._caps.max_tokens}) reached"
            return True
        return False
