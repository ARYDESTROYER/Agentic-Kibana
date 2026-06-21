"""Plain-text runbooks — Vigil's "your playbooks are plain-text files" pillar.

A runbook is a Markdown file under ``backend/app/runbooks/`` with a small YAML-ish
frontmatter block and a free-text body of investigation guidance:

    ---
    id: brute_force
    title: SSH / credential brute force
    applies_to_rules: [sshd, linux_auth, postfix]
    applies_to_techniques: [T1110, T1078]
    applies_to_entities: [user, ip]
    keywords: [ssh, brute, failed password, auth]
    persona: identity_access
    summary: Triage a burst of failed authentications from one source.
    ---
    ## Steps
    1. Confirm whether ANY attempt succeeded ...

Runbooks feed two paths: (a) the RAG ``runbook`` corpus (so they're retrievable),
and (b) direct injection of the single best-matching runbook as TRUSTED guidance
into the investigator prompt. A tiny dependency-free frontmatter parser keeps the
"no new deps" rule (mirrors how Vigil parses its WORKFLOW.md). Loading is cached
because the files are static at runtime; ``reload_runbooks()`` clears the cache.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from ..config import Preferences
from ..models import Cluster

logger = logging.getLogger("tlsoc.engine.runbooks")

RUNBOOKS_DIR = Path(__file__).resolve().parent.parent / "runbooks"


@dataclass(frozen=True)
class Runbook:
    id: str
    title: str
    body: str
    summary: str = ""
    persona: str = ""
    applies_to_rules: tuple[str, ...] = ()
    applies_to_techniques: tuple[str, ...] = ()
    applies_to_entities: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()

    def as_corpus_item(self) -> dict:
        """A RAG corpus document for this runbook (source='runbook').

        We index a CONCISE, keyword-rich descriptor (title + summary + keywords +
        rules/techniques) rather than the full multi-paragraph body: it embeds and
        BM25-matches cleanly, and the full body is injected directly into the
        investigator prompt when this runbook is the selected match anyway."""
        parts = [f"{self.title}.", self.summary]
        if self.keywords:
            parts.append("Keywords: " + ", ".join(self.keywords) + ".")
        if self.applies_to_rules:
            parts.append("Rules: " + ", ".join(self.applies_to_rules) + ".")
        if self.applies_to_techniques:
            parts.append("MITRE: " + ", ".join(self.applies_to_techniques) + ".")
        text = " ".join(p for p in parts if p).strip()
        return {
            "text": text,
            "source": "runbook",
            "doc_id": f"runbook:{self.id}",
            "metadata": {
                "runbook_id": self.id,
                "title": self.title,
                "persona": self.persona,
                "rules": list(self.applies_to_rules),
                "mitre": list(self.applies_to_techniques),
            },
        }


# --------------------------------------------------------------------------- #
# Minimal, dependency-free frontmatter parsing.
# --------------------------------------------------------------------------- #
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


def _split_list(raw: str) -> tuple[str, ...]:
    raw = raw.strip()
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1]
    parts = [p.strip().strip("'\"") for p in raw.split(",")]
    return tuple(p for p in parts if p)


def parse_frontmatter(text: str) -> tuple[dict[str, object], str]:
    """Return (meta, body). Supports scalars, inline ``[a, b]`` lists, and indented
    ``- item`` lists. Anything it can't parse is ignored (never raises)."""
    m = _FRONTMATTER_RE.match(text.lstrip("﻿"))
    if not m:
        return {}, text.strip()
    raw_meta, body = m.group(1), m.group(2).strip()
    meta: dict[str, object] = {}
    current_key: str | None = None
    current_list: list[str] = []

    def _flush() -> None:
        nonlocal current_key, current_list
        if current_key is not None:
            meta[current_key] = tuple(current_list)
        current_key, current_list = None, []

    for line in raw_meta.splitlines():
        if not line.strip():
            continue
        if line.lstrip().startswith("- ") and current_key is not None:
            current_list.append(line.lstrip()[2:].strip().strip("'\""))
            continue
        _flush()
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if not val:
            current_key = key  # indented list follows
            current_list = []
        elif val.startswith("["):
            meta[key] = _split_list(val)
        else:
            meta[key] = val.strip("'\"")
    _flush()
    return meta, body


def _to_runbook(meta: dict[str, object], body: str, fallback_id: str) -> Runbook:
    def _tuple(key: str) -> tuple[str, ...]:
        v = meta.get(key)
        if isinstance(v, tuple):
            return tuple(str(x) for x in v)
        if isinstance(v, str) and v:
            return (v,)
        return ()

    return Runbook(
        id=str(meta.get("id") or fallback_id),
        title=str(meta.get("title") or fallback_id),
        body=body,
        summary=str(meta.get("summary") or ""),
        persona=str(meta.get("persona") or ""),
        applies_to_rules=_tuple("applies_to_rules"),
        applies_to_techniques=_tuple("applies_to_techniques"),
        applies_to_entities=_tuple("applies_to_entities"),
        keywords=_tuple("keywords"),
    )


_CACHE: list[Runbook] | None = None


def load_runbooks(directory: Path | None = None) -> list[Runbook]:
    """Load + cache all ``*.md`` runbooks from the runbooks directory. Never raises
    (a bad file is skipped with a warning)."""
    global _CACHE
    if directory is None and _CACHE is not None:
        return _CACHE
    base = directory or RUNBOOKS_DIR
    runbooks: list[Runbook] = []
    if base.is_dir():
        for path in sorted(base.glob("*.md")):
            try:
                meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
                runbooks.append(_to_runbook(meta, body, path.stem))
            except Exception as exc:  # noqa: BLE001
                logger.warning("Skipping unparseable runbook %s: %s", path, exc)
    if directory is None:
        _CACHE = runbooks
    return runbooks


def reload_runbooks() -> None:
    """Drop the cache (e.g. after editing runbook files)."""
    global _CACHE
    _CACHE = None


def corpus_items(runbooks: list[Runbook] | None = None) -> list[dict]:
    """RAG corpus documents for all runbooks."""
    return [rb.as_corpus_item() for rb in (runbooks if runbooks is not None else load_runbooks())]


def select_runbook(cluster: Cluster, prefs: Preferences) -> Runbook | None:
    """Pick the single best-matching runbook for a cluster, or None.

    Scores each runbook against the cluster's primary rule, rule set and entity
    type. Rule matches weigh most, then keyword hits, then entity-type affinity.
    Deterministic (ties broken by runbook id). Returns None when nothing scores."""
    cfg = getattr(prefs, "runbooks", None)
    if cfg is not None and not cfg.enabled:
        return None
    runbooks = load_runbooks()
    if not runbooks:
        return None

    primary = (cluster.primary_rule() or "").lower()
    rules_l = {r.lower() for r in cluster.rule_values}
    rules_l.add(primary)
    entity_type = cluster.entity.type.value
    haystack = " ".join([primary, *rules_l, cluster.entity.value]).lower()

    best: tuple[int, str] | None = None
    best_rb: Runbook | None = None
    for rb in runbooks:
        score = 0
        rb_rules = {r.lower() for r in rb.applies_to_rules}
        if rb_rules & rules_l:
            score += 10 * len(rb_rules & rules_l)
        if any(r in primary or primary in r for r in rb_rules if r and primary):
            score += 5
        score += sum(3 for kw in rb.keywords if kw.lower() in haystack)
        if entity_type in {e.lower() for e in rb.applies_to_entities}:
            score += 1
        if score <= 0:
            continue
        key = (score, rb.id)
        if best is None or key > best:
            best, best_rb = key, rb
    return best_rb
