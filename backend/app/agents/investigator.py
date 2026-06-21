"""Investigator role — the ReAct loop (Section 6.4).

One strong generalist gathers evidence via read-only tools, reasons, and produces
a draft verdict, which the formatter then shapes. Per-case caps (tool calls,
tokens, kill switch) bound the loop so a malformed alert cannot cause runaway
spend (Section 6.3 #4). ANY failure returns NEEDS_HUMAN — never a dropped alert
(Section 6.7).
"""

from __future__ import annotations

import json
import logging

from ..audit.audit_log import AuditLogger
from ..config import Preferences
from ..constants import ActionType, Role, ToolTier, Verdict
from ..engine.cost_gate import CaseBudget
from ..llm.gateway import GatewayError, LLMGateway
from ..models import Cluster, EnrichmentResult, RagChunk, VerdictResult
from ..tools.base import ToolRegistry
from ..utils import extract_json, truncate
from .common import coerce_verdict, entity_kql
from .formatter import Formatter
from .personas import AgentPersona
from .prompts import (
    build_investigator_system,
    fence,
    render_cluster,
    tool_defs_text,
)

logger = logging.getLogger("tlsoc.agents.investigator")


class Investigator:
    def __init__(
        self,
        gateway: LLMGateway,
        tools: ToolRegistry,
        audit: AuditLogger,
        formatter: Formatter,
    ) -> None:
        self._gateway = gateway
        self._tools = tools
        self._audit = audit
        self._formatter = formatter

    async def investigate(
        self,
        cluster: Cluster,
        enrichment: EnrichmentResult | None,
        rag_chunks: list[RagChunk] | None,
        prefs: Preferences,
        budget: CaseBudget,
        *,
        surface: str,
        case_id: str | None = None,
        persona: AgentPersona | None = None,
        runbook_text: str | None = None,
    ) -> tuple[VerdictResult, float]:
        cost = 0.0
        # Per-rule model selection (C3-6b): resolve via the cluster's primary rule;
        # identical to ``prefs.investigator_model``/``prefs.formatter_model`` when
        # no per-rule override exists.
        primary_rule = cluster.primary_rule()
        model_cfg = prefs.model_for_rule(Role.INVESTIGATOR, primary_rule)
        try:
            # Multi-agent roster: the assigned persona specialises the system prompt
            # (focus + methodology) without relaxing any read-only / fencing rule.
            addendum = persona.system_addendum if persona else ""
            system = build_investigator_system(
                tool_defs_text(self._tools.definitions()), addendum
            )
            context = render_cluster(cluster, enrichment, rag_chunks, runbook=runbook_text)
            messages = [
                {"role": "system", "content": system},
                {"role": "user", "content": context + "\n\nBegin the investigation. Respond with JSON only."},
            ]
            await self._audit.record(
                action_type=ActionType.PROMPT, surface=surface, actor=Role.INVESTIGATOR.value,
                case_id=case_id, model=model_cfg.model, prompt_excerpt=context,
                result_summary=f"persona={persona.id if persona else 'generalist'}",
            )

            draft: VerdictResult | None = None
            reasoning = ""
            max_steps = prefs.caps.max_tool_calls + 3

            for _step in range(max_steps):
                if budget.exceeded():
                    reasoning += f"\n[capped] {budget.capped_reason}"
                    break
                try:
                    res = await self._gateway.complete(
                        Role.INVESTIGATOR, messages, model_cfg,
                        surface=surface, case_id=case_id,
                    )
                except GatewayError as exc:
                    logger.warning("Investigator model error (%s); failing to human", exc)
                    return _fail_to_human(f"investigator model error: {exc}", cluster, prefs), cost

                cost += res.cost
                budget.add_tokens(res.prompt_tokens, res.completion_tokens)
                obj = extract_json(res.text)

                if not obj or "action" not in obj:
                    messages.append({"role": "assistant", "content": res.text})
                    messages.append({"role": "user", "content": "Respond with ONLY a valid JSON action object."})
                    continue

                action = obj.get("action")
                if action == "final":
                    reasoning = str(obj.get("reasoning", ""))
                    draft = coerce_verdict(obj.get("verdict") or {})
                    break

                if action == "tool":
                    if not budget.can_call_tool():
                        reasoning += f"\n[capped] {budget.capped_reason}"
                        break
                    name = str(obj.get("tool", ""))
                    tool = self._tools.get(name)
                    budget.record_tool_call()
                    if tool is None:
                        messages.append({"role": "assistant", "content": res.text})
                        messages.append({"role": "user",
                                         "content": f"Unknown tool '{name}'. Available: {self._tools.names()}"})
                        continue
                    # Capability firewall (#3 generalised): an autonomous agent may
                    # only call SAFE/MANAGED tools. Outward/irreversible tools must be
                    # PROPOSED for human approval, never executed here; forbidden tools
                    # are hard-blocked. Every built-in tool is SAFE today, so this is
                    # defense-in-depth that activates the moment a write tool is added.
                    if tool.tier in (ToolTier.FORBIDDEN, ToolTier.REQUIRES_APPROVAL):
                        await self._audit.record(
                            action_type=ActionType.DECISION, surface=surface,
                            actor=Role.INVESTIGATOR.value, case_id=case_id, tool_name=name,
                            result_summary=f"tool '{name}' blocked by tier={tool.tier.value}",
                        )
                        messages.append({"role": "assistant", "content": res.text})
                        guidance = (
                            f"Tool '{name}' is FORBIDDEN for autonomous use; do not call it."
                            if tool.tier == ToolTier.FORBIDDEN
                            else (
                                f"Tool '{name}' requires human approval and was NOT executed. "
                                "Describe the action in 'recommended_action' for an analyst instead."
                            )
                        )
                        messages.append({"role": "user", "content": guidance})
                        continue
                    tool_input = obj.get("input") or {}
                    tr = await tool.run(**tool_input)
                    await self._audit.record(
                        action_type=ActionType.TOOL_CALL, surface=surface,
                        actor=Role.INVESTIGATOR.value, case_id=case_id,
                        tool_name=name, tool_input=tool_input,
                        tool_output_summary=tr.summary, query_text=tr.query,
                    )
                    observation = {"ok": tr.ok, "summary": tr.summary, "data": tr.data, "error": tr.error}
                    messages.append({"role": "assistant", "content": res.text})
                    messages.append({
                        "role": "user",
                        "content": (
                            f"Tool '{name}' result:\n"
                            f"{fence(json.dumps(observation, default=str), source='tool', tool=name)}"
                        ),
                    })
                    continue

                messages.append({"role": "user", "content": "Use action 'tool' or 'final' only."})

            if draft is None:
                draft = _fail_to_human(
                    "Investigation inconclusive or capped; routing to human.", cluster, prefs
                )

            verdict, fcost = await self._formatter.format(
                draft, reasoning, prefs, surface=surface, case_id=case_id,
                model_cfg=prefs.model_for_rule(Role.FORMATTER, primary_rule),
            )
            cost += fcost
            if not verdict.reproduce_query:
                verdict.reproduce_query = entity_kql(cluster, prefs)

            await self._audit.record(
                action_type=ActionType.VERDICT, surface=surface, actor=Role.INVESTIGATOR.value,
                case_id=case_id, model=model_cfg.model,
                result_summary=f"verdict={verdict.verdict.value} confidence={verdict.confidence}",
            )
            return verdict, cost
        except Exception as exc:  # noqa: BLE001 — never drop an alert
            logger.exception("Investigator crashed; failing to human")
            await self._audit.record(
                action_type=ActionType.ERROR, surface=surface, actor=Role.INVESTIGATOR.value,
                case_id=case_id, result_summary=f"investigator crash: {exc}",
            )
            return _fail_to_human(f"investigator error: {exc}", cluster, prefs), cost


def _fail_to_human(reason: str, cluster: Cluster, prefs: Preferences) -> VerdictResult:
    return VerdictResult(
        verdict=Verdict.NEEDS_HUMAN,
        confidence=0.0,
        recommended_action=truncate(reason, 400),
        reproduce_query=entity_kql(cluster, prefs),
    )
