"""Deterministic engine: correlation, risk, cost gate, case-manager policy, and
the polling/scanning loops. Correlation and scoring run in code, never in the
LLM (Section 6.2). The close/escalate DECISION is code, never the model
(Section 6.4 / Non-negotiable #3)."""
