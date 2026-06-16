"""Agent roles (Section 6.4): router, investigator, formatter, chat, standup.

New use case = new prompt + tool set, NOT a new agent (Section 6.4). All four
roles route through the single gateway; all log-derived values are fenced as
untrusted DATA in prompts (Section 3.3 injection seam).
"""
