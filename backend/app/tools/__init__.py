"""Agent tools (Section 6.5).

Each tool is a clean in-process function behind a stable, MCP-shaped interface
(``name`` + ``input_schema`` + ``run``). Swapping the transport to MCP later
requires zero change to agent code (Section 3.3).
"""
