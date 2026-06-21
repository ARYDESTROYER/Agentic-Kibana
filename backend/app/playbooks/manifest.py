"""Playbook manifest data contracts.

A *playbook* is an operator-authored Markdown file with a YAML-ish front-matter
block (the ``PlaybookManifest``) and a free-text body of investigation procedure.
The manifest declares deterministic *match criteria* (which clusters this playbook
applies to) and *recommendations* (suggested tools / RAG queries / verdict bias).
A playbook can only RECOMMEND — deterministic code and operator settings make the
close/escalate decision (Section 5, non-negotiable #3).

Unknown front-matter keys are ignored (``model_config = {"extra": "ignore"}``) so a
typo or a newer schema field never makes a playbook fatal to load — the loader
logs a warning instead.
"""

from __future__ import annotations

from dataclasses import dataclass

from pydantic import BaseModel, Field, field_validator

# A playbook id is a short slug: lowercase alnum start, then alnum / ``_`` / ``-``.
_SLUG_RE = r"^[a-z0-9][a-z0-9_-]{0,63}$"


class PlaybookMatch(BaseModel):
    """Deterministic match criteria for a playbook.

    Every field is *any-of* and OPTIONAL: an empty / ``None`` criterion does NOT
    constrain. A playbook matches a cluster iff ALL of its PRESENT criteria are
    satisfied (see ``registry.select_playbook``).

    ``entity_types`` values are ``EntityType`` values ("ip" / "user" / "host").
    ``mitre`` and ``any_tags`` currently match opportunistically against the
    cluster's rule names (clusters carry no MITRE/tags pre-investigation).
    """

    model_config = {"extra": "ignore"}

    rule_ids: list[str] = Field(default_factory=list)
    entity_types: list[str] = Field(default_factory=list)
    mitre: list[str] = Field(default_factory=list)
    min_event_count: int | None = None
    any_tags: list[str] = Field(default_factory=list)


class PlaybookManifest(BaseModel):
    """The front-matter contract for a playbook Markdown file."""

    model_config = {"extra": "ignore"}

    id: str
    name: str
    version: int = Field(default=1, ge=1)
    description: str = ""
    match: PlaybookMatch = Field(default_factory=PlaybookMatch)
    priority: int = 0
    suggested_tools: list[str] = Field(default_factory=list)
    rag_queries: list[str] = Field(default_factory=list)
    escalate_if: str = ""
    suggested_verdict_bias: str = ""

    @field_validator("id")
    @classmethod
    def _validate_id(cls, v: str) -> str:
        import re

        if not isinstance(v, str) or not re.match(_SLUG_RE, v):
            raise ValueError(
                f"playbook id must be a non-empty slug matching {_SLUG_RE!r}, got {v!r}"
            )
        return v


@dataclass(frozen=True)
class Playbook:
    """A loaded playbook: its parsed manifest plus the operator-authored body."""

    manifest: PlaybookManifest
    body: str
    source_path: str = ""

    @property
    def id(self) -> str:
        return self.manifest.id

    @property
    def name(self) -> str:
        return self.manifest.name

    @property
    def version(self) -> int:
        return self.manifest.version
