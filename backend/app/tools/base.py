"""Tool interface and registry (MCP-shaped).

A ``Tool`` exposes a ``name``, a human description, a JSON ``input_schema`` and an
async ``run(input) -> ToolResult``. These four fields map one-to-one onto an MCP
tool definition, so the in-process registry can be replaced by an MCP client
transport without touching any agent code.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from ..constants import ToolTier


@dataclass
class ToolResult:
    ok: bool
    summary: str = ""
    data: Any = None
    error: str | None = None
    # The reproducible query (KQL/DSL) behind the result, surfaced to audit and to
    # the one-click Discover locator (Section 8.1/8.2).
    query: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


class Tool(ABC):
    name: str = "tool"
    description: str = ""
    input_schema: dict[str, Any] = {}
    # Capability tier (authorisation firewall). Every built-in tool today is SAFE
    # (read-only). A write/response tool declares a higher tier and the investigator
    # gates it accordingly (FORBIDDEN → never; REQUIRES_APPROVAL → propose-only).
    tier: ToolTier = ToolTier.SAFE

    @abstractmethod
    async def run(self, **kwargs: Any) -> ToolResult: ...

    def definition(self) -> dict[str, Any]:
        """MCP-style tool definition for prompting / future MCP export."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema,
        }


class ToolRegistry:
    def __init__(self, tools: list[Tool] | None = None) -> None:
        self._tools: dict[str, Tool] = {}
        for tool in tools or []:
            self.register(tool)

    def register(self, tool: Tool) -> None:
        self._tools[tool.name] = tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def names(self) -> list[str]:
        return list(self._tools)

    def definitions(self) -> list[dict[str, Any]]:
        return [t.definition() for t in self._tools.values()]
