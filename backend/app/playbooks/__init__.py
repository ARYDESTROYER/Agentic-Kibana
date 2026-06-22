"""Markdown playbook engine for the TLSOC Agentic Triage backend.

A *playbook* is an operator-authored Markdown file with a YAML-ish front-matter
manifest (deterministic match criteria + recommendations) and a free-text body of
investigation procedure. Playbooks can only RECOMMEND; deterministic code and
operator settings decide close/escalate (non-negotiable #3). This package is a
self-contained module: parsing (``loader``), the data contracts (``manifest``) and
deterministic selection + an atomic hot-reloadable registry (``registry``).
"""

from __future__ import annotations

from .loader import load_playbooks, parse_playbook
from .manifest import Playbook, PlaybookManifest, PlaybookMatch
from .registry import PlaybookRegistry, select_playbook

__all__ = [
    "PlaybookManifest",
    "PlaybookMatch",
    "Playbook",
    "PlaybookRegistry",
    "select_playbook",
    "load_playbooks",
    "parse_playbook",
]
