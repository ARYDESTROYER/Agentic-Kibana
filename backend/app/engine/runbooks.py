"""Token-bounded plain-text runbooks.

A runbook is a ``.md`` container under ``backend/app/runbooks/`` because the small
YAML-ish frontmatter is convenient to review and package. The guidance body itself
is deliberately plain text with fixed labels; operator submissions cannot contain
Markdown presentation syntax:

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
    SIGNAL
    A burst of failed authentication attempts from one source.

    EVIDENCE REQUIRED
    Authentication outcomes for the source and target account.

    INVESTIGATION STEPS
    1. Confirm whether any attempt succeeded.

Runbooks feed the RAG ``runbook`` corpus as retrievable reference knowledge. They
are deliberately distinct from executable/selected Playbooks and never alter the
deterministic close/escalate policy. A tiny dependency-free frontmatter parser
keeps the "no new deps" rule. Packaged files are cached; the operator-managed layer
is persisted separately through :mod:`app.stores.runbooks`.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path

from .chunking import chunk_text

logger = logging.getLogger("tlsoc.engine.runbooks")

RUNBOOKS_DIR = Path(__file__).resolve().parent.parent / "runbooks"
MAX_RUNBOOK_BYTES = 128 * 1024
MAX_RUNBOOK_BODY_CHARS = 1800
MAX_TITLE_CHARS = 120
MAX_SUMMARY_CHARS = 280
MAX_PERSONA_CHARS = 48
MAX_LIST_ITEMS = 12
MAX_LIST_ITEM_CHARS = 64
MAX_RETRIEVAL_DESCRIPTOR_CHARS = 1200
# Existing operator documents were accepted under these wider defensive ceilings.
# Keep them readable/reindexable until their next edit, when the strict limits above
# apply. This is compatibility only, not an authoring allowance.
_LEGACY_MAX_TITLE_CHARS = 160
_LEGACY_MAX_SUMMARY_CHARS = 600
_LEGACY_MAX_PERSONA_CHARS = 80
_LEGACY_MAX_LIST_ITEMS = 64
_LEGACY_MAX_LIST_ITEM_CHARS = 160
MIN_SECTION_CONTENT_CHARS = 12
REQUIRED_MANIFEST_FIELDS = (
    "id",
    "title",
    "summary",
    "applies_to_rules",
    "applies_to_entities",
    "keywords",
)
OPTIONAL_MANIFEST_FIELDS = ("persona", "applies_to_techniques")
REQUIRED_BODY_LABELS = (
    "SIGNAL",
    "EVIDENCE REQUIRED",
    "INVESTIGATION STEPS",
    "TRUE POSITIVE SIGNALS",
    "FALSE POSITIVE SIGNALS",
    "NEEDS HUMAN WHEN",
    "RECOMMENDED NEXT ACTION",
)
OPTIONAL_BODY_LABELS = ("LIMITATIONS",)
_ALL_BODY_LABELS = REQUIRED_BODY_LABELS + OPTIONAL_BODY_LABELS
_ALLOWED_MANIFEST_FIELDS = frozenset(REQUIRED_MANIFEST_FIELDS + OPTIONAL_MANIFEST_FIELDS)
_RUNBOOK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
_MITRE_RE = re.compile(r"^T\d{4}(?:\.\d{3})?$")
_RESERVED_IDS = frozenset({"readme", "index", "reindex"})


@dataclass(frozen=True)
class RunbookValidationIssue:
    """One actionable authoring problem returned at the API boundary."""

    code: str
    field: str
    problem: str
    reason: str
    fix: str

    def payload(self) -> dict[str, str]:
        return {
            "code": self.code,
            "field": self.field,
            "problem": self.problem,
            "reason": self.reason,
            "fix": self.fix,
        }


class RunbookManagementError(ValueError):
    """Base class for bounded operator runbook management errors."""


class RunbookValidationError(RunbookManagementError):
    """One submission failed one or more authoring-standard checks."""

    def __init__(
        self,
        issues: list[RunbookValidationIssue],
        *,
        body_characters: int = 0,
    ) -> None:
        self.issues = tuple(issues)
        self.body_characters = max(0, int(body_characters))
        super().__init__(
            issues[0].problem if issues else "runbook submission is invalid"
        )


class RunbookConflictError(RunbookManagementError):
    """A runbook id already exists."""


class RunbookNotFoundError(RunbookManagementError):
    """A runbook id does not exist."""


class RunbookProtectedError(RunbookManagementError):
    """A bundled runbook was targeted by a mutation."""


class RunbookRevisionConflictError(RunbookManagementError):
    """The caller attempted to replace an older operator revision."""


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
    source_path: str = ""

    def retrieval_descriptor(self) -> str:
        """Return the bounded text prefixed to every retrieved guidance chunk."""
        parts = [f"{self.title}.", self.summary]
        if self.keywords:
            parts.append("Keywords: " + ", ".join(self.keywords) + ".")
        if self.applies_to_rules:
            parts.append("Rules: " + ", ".join(self.applies_to_rules) + ".")
        if self.applies_to_techniques:
            parts.append("MITRE: " + ", ".join(self.applies_to_techniques) + ".")
        if self.applies_to_entities:
            parts.append("Entities: " + ", ".join(self.applies_to_entities) + ".")
        return " ".join(part for part in parts if part).strip()

    def embedding_descriptor(self) -> str:
        """Return the compact metadata representation used for vector retrieval."""
        return " ".join(
            part
            for part in (
                self.title,
                self.summary,
                " ".join(self.keywords),
                " ".join(self.applies_to_rules),
                " ".join(self.applies_to_techniques),
                " ".join(self.applies_to_entities),
                self.persona,
            )
            if part
        ).strip()

    def as_corpus_items(
        self, *, revision: int = 1, source_type: str = "bundled"
    ) -> list[dict]:
        """Chunk the actual guidance into stable, per-runbook RAG documents.

        The applicability descriptor prefixes every chunk so exact rules, MITRE
        techniques, entities, and keywords remain easy to retrieve. The body is
        included because runbooks are RAG knowledge (not direct Playbook injection).
        """
        descriptor = self.retrieval_descriptor()
        embedding_descriptor = self.embedding_descriptor()
        # Prefix each guidance chunk once. A strict <=1,800-character body normally
        # produces one descriptor+guidance document, avoiding the former metadata-
        # only chunk and repeated retrieval context. Compatibility-loaded legacy
        # bodies may still split, with enough metadata on every part to retrieve it.
        body_chunks = chunk_text(self.body, target_chars=2200, overlap=160) or [self.body]
        chunks = body_chunks
        document_id = f"runbook:{self.id}"
        total = len(chunks)
        return [
            {
                "text": f"{descriptor}\n\n{chunk}".strip(),
                # Embed only the compact applicability descriptor. The vector stays
                # focused while retrieval returns one complete guidance chunk.
                "embedding_text": embedding_descriptor or descriptor or chunk,
                "source": "runbook",
                "doc_id": f"{document_id}:{index}",
                "metadata": {
                    "document_id": document_id,
                    "runbook_id": self.id,
                    "title": self.title,
                    "persona": self.persona,
                    "rules": list(self.applies_to_rules),
                    "mitre": list(self.applies_to_techniques),
                    "entities": list(self.applies_to_entities),
                    "keywords": list(self.keywords),
                    "revision": int(revision),
                    "source_type": source_type,
                    "trust_class": (
                        "operator_runbook"
                        if source_type == "operator"
                        else "bundled_runbook"
                    ),
                    "chunk_index": index,
                    "n_chunks": total,
                },
            }
            for index, chunk in enumerate(chunks)
            if chunk.strip()
        ]

    def as_corpus_item(self) -> dict:
        """Backward-compatible first corpus chunk for callers expecting one item."""
        return self.as_corpus_items()[0]


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
    normalized = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    m = _FRONTMATTER_RE.match(normalized)
    if not m:
        return {}, normalized.strip()
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


def _to_runbook(
    meta: dict[str, object], body: str, fallback_id: str, *, source_path: str = ""
) -> Runbook:
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
        source_path=source_path,
    )


def validate_runbook_id(runbook_id: str) -> str:
    value = str(runbook_id or "").strip()
    if _RUNBOOK_ID_RE.fullmatch(value) is None:
        raise RunbookValidationError(
            [
                RunbookValidationIssue(
                    code="manifest.id.invalid",
                    field="id",
                    problem="The runbook id is not a valid lowercase slug.",
                    reason=(
                        "Stable ids are used for durable storage and retrieval "
                        "document identifiers."
                    ),
                    fix=(
                        "Use 1–64 lowercase letters, numbers, hyphens, or "
                        "underscores, starting with a letter or number."
                    ),
                )
            ]
        )
    if value in _RESERVED_IDS:
        raise RunbookValidationError(
            [
                RunbookValidationIssue(
                    code="manifest.id.reserved",
                    field="id",
                    problem=f"The runbook id {value!r} is reserved.",
                    reason="Reserved ids are used by catalog operations.",
                    fix="Choose a descriptive signal-family id that is not reserved.",
                )
            ]
        )
    return value


def runbook_authoring_standard() -> dict[str, object]:
    """Return the backend-owned contract that authoring surfaces must present."""
    return {
        "version": 1,
        "body_max_characters": MAX_RUNBOOK_BODY_CHARS,
        "retrieval_descriptor_max_characters": MAX_RETRIEVAL_DESCRIPTOR_CHARS,
        "document_max_bytes": MAX_RUNBOOK_BYTES,
        "section_min_characters": MIN_SECTION_CONTENT_CHARS,
        "reserved_ids": sorted(_RESERVED_IDS),
        "character_count": (
            "Unicode characters after newline normalization and outer trimming"
        ),
        "metadata_limits": {
            "title_max_characters": MAX_TITLE_CHARS,
            "summary_max_characters": MAX_SUMMARY_CHARS,
            "persona_max_characters": MAX_PERSONA_CHARS,
            "list_max_items": MAX_LIST_ITEMS,
            "list_item_max_characters": MAX_LIST_ITEM_CHARS,
        },
        "required_manifest_fields": list(REQUIRED_MANIFEST_FIELDS),
        "optional_manifest_fields": list(OPTIONAL_MANIFEST_FIELDS),
        "required_body_labels": list(REQUIRED_BODY_LABELS),
        "optional_body_labels": list(OPTIONAL_BODY_LABELS),
        "investigation_steps": "Sequential one-line numbered steps: 1., 2., 3.",
        "allowed_metadata_format": "Concise plain text only",
        "allowed_body_format": "Plain sentences and sequential numbered steps only",
        "prohibited_metadata_format": [
            "Markdown headings or table pipes",
            "bold, italics, underline, or strikethrough",
            "inline code",
            "Markdown links, images, or autolinks",
            "raw HTML",
            "template placeholder text",
        ],
        "prohibited_body_format": [
            "Markdown headings",
            "tables",
            "bold, italics, underline, or strikethrough",
            "unordered or task lists",
            "inline, fenced, or indented code",
            "links or images",
            "raw HTML",
            "blockquotes",
            "horizontal rules",
            "template placeholder text",
        ],
    }


def _issue(
    code: str,
    field: str,
    problem: str,
    reason: str,
    fix: str,
) -> RunbookValidationIssue:
    return RunbookValidationIssue(
        code=code,
        field=field,
        problem=problem,
        reason=reason,
        fix=fix,
    )


_ATX_HEADING_RE = re.compile(r"(?m)^\s{0,3}#{1,6}(?:\s|$)")
_SETEXT_HEADING_RE = re.compile(r"(?m)^\s*\S.*\n\s*(?:=+|-+)\s*$")
_GFM_TABLE_RE = re.compile(r"\|")
_BOLD_RE = re.compile(r"(?:\*\*[^*\n]+\*\*|__[^_\n]+__)")
_ITALIC_STAR_RE = re.compile(r"(?<!\*)\*(?!\*)(?=\S)[^*\n]*?\S\*(?!\*)")
_ITALIC_UNDERSCORE_RE = re.compile(
    r"(?<![\w_])_(?!_)(?=\S)[^_\n]*?\S_(?![\w_])"
)
_UNDERLINE_RE = re.compile(r"(?is)</?u(?:\s[^<>]*)?>|\+\+[^+\n]+\+\+")
_STRIKETHROUGH_RE = re.compile(r"~~[^~\n]+~~")
_FENCED_CODE_RE = re.compile(r"(?m)^\s*(?:```|~~~)")
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
_INDENTED_CODE_RE = re.compile(r"(?m)^(?: {4}|\t)\S")
_RAW_HTML_RE = re.compile(r"(?is)</?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?>")
_MARKDOWN_LINK_RE = re.compile(
    r"!?\[[^\]\n]*\]\([^\n)]*\)|!?\[[^\]\n]+\]\[[^\]\n]*\]"
)
_REFERENCE_LINK_RE = re.compile(r"(?m)^\s*\[[^\]\n]+\]:\s+\S+")
_AUTOLINK_RE = re.compile(r"<(?:https?://|mailto:)[^>\n]+>", re.IGNORECASE)
_BLOCKQUOTE_RE = re.compile(r"(?m)^\s{0,3}>\s?")
_TASK_LIST_RE = re.compile(r"(?m)^\s*[-+*]\s+\[[ xX]\]\s+")
_UNORDERED_LIST_RE = re.compile(r"(?m)^\s{0,3}[-+*]\s+")
_HORIZONTAL_RULE_RE = re.compile(r"(?m)^\s{0,3}(?:([-*_])\s*){3,}$")
_PLACEHOLDER_RE = re.compile(
    r"(?i)(?:\[(?:describe|add|enter|explain|list|replace|write|provide|insert)"
    r"[^\]\n]{0,100}\]|\b(?:todo|tbd|placeholder|lorem ipsum)\b)"
)

_FORBIDDEN_BODY_PATTERNS: tuple[
    tuple[str, re.Pattern[str], str, str, str], ...
] = (
    (
        "body.format.heading",
        _ATX_HEADING_RE,
        "Markdown headings are not allowed in the guidance body.",
        "The fixed labels already provide structure; heading tokens add no agent value.",
        "Remove # characters and use only the required uppercase labels.",
    ),
    (
        "body.format.setext_heading",
        _SETEXT_HEADING_RE,
        "Setext-style Markdown headings are not allowed.",
        "Underline-style headings spend context tokens and bypass the fixed structure.",
        "Remove the === or --- underline and use the required label line.",
    ),
    (
        "body.format.table",
        _GFM_TABLE_RE,
        "Tables and table-like pipe syntax are not allowed.",
        "Tables are token-dense and their row-to-header meaning is fragile in retrieval.",
        "Remove pipe characters and rewrite each relevant row as a short plain sentence.",
    ),
    (
        "body.format.bold",
        _BOLD_RE,
        "Bold Markdown is not allowed.",
        "Emphasis markers consume context without changing the agent's evidence.",
        "Remove ** or __ markers and keep the words as plain text.",
    ),
    (
        "body.format.italic",
        _ITALIC_STAR_RE,
        "Italic Markdown is not allowed.",
        "Emphasis markers consume context without changing the agent's evidence.",
        "Remove the surrounding asterisks and keep the words as plain text.",
    ),
    (
        "body.format.italic",
        _ITALIC_UNDERSCORE_RE,
        "Italic Markdown is not allowed.",
        "Emphasis markers consume context without changing the agent's evidence.",
        "Remove the surrounding underscores; ordinary field_name underscores are valid.",
    ),
    (
        "body.format.underline",
        _UNDERLINE_RE,
        "Underline formatting is not allowed.",
        "Presentation markup consumes context and has no investigation meaning.",
        "Remove underline markup and keep the words as plain text.",
    ),
    (
        "body.format.strikethrough",
        _STRIKETHROUGH_RE,
        "Strikethrough Markdown is not allowed.",
        "Deleted-looking text is ambiguous evidence and wastes context.",
        "Delete obsolete text or replace it with the intended plain sentence.",
    ),
    (
        "body.format.fenced_code",
        _FENCED_CODE_RE,
        "Fenced code blocks are not allowed.",
        "Large code blocks are expensive and can dominate the retrieved guidance.",
        "Describe the required evidence or read-only query intent as a short sentence.",
    ),
    (
        "body.format.inline_code",
        _INLINE_CODE_RE,
        "Inline code formatting is not allowed.",
        "Backticks add presentation tokens without adding evidence.",
        "Remove backticks and keep field names or values as plain text.",
    ),
    (
        "body.format.indented_code",
        _INDENTED_CODE_RE,
        "Indented code blocks are not allowed.",
        "Indented blocks are parsed as code and are inefficient retrieval context.",
        "Remove indentation and express the instruction as one plain line.",
    ),
    (
        "body.format.html",
        _RAW_HTML_RE,
        "Raw HTML is not allowed.",
        "HTML is presentation markup and is not trusted as investigation guidance.",
        "Remove the HTML tags and keep only the plain-text meaning.",
    ),
    (
        "body.format.link",
        _MARKDOWN_LINK_RE,
        "Markdown links or images are not allowed.",
        "Link labels and destinations add context cost and can hide the actual evidence.",
        "State the relevant fact directly; use a plain URL only when indispensable.",
    ),
    (
        "body.format.link",
        _REFERENCE_LINK_RE,
        "Markdown reference links are not allowed.",
        "Reference indirection adds context cost and can separate meaning during retrieval.",
        "State the relevant fact directly; use a plain URL only when indispensable.",
    ),
    (
        "body.format.link",
        _AUTOLINK_RE,
        "Markdown autolinks are not allowed.",
        "Angle-bracket link syntax adds presentation markup.",
        "Remove angle brackets; retain a plain URL only when indispensable.",
    ),
    (
        "body.format.blockquote",
        _BLOCKQUOTE_RE,
        "Markdown blockquotes are not allowed.",
        "Quoted presentation is ambiguous in trusted operational guidance.",
        "Rewrite the necessary fact as a direct plain sentence.",
    ),
    (
        "body.format.task_list",
        _TASK_LIST_RE,
        "Markdown task lists are not allowed.",
        "Checkbox syntax is presentation state, not investigation evidence.",
        "Use sequential numbered steps under INVESTIGATION STEPS.",
    ),
    (
        "body.format.unordered_list",
        _UNORDERED_LIST_RE,
        "Markdown bullet lists are not allowed.",
        "Fixed sections and numbered steps are cheaper and more deterministic to parse.",
        "Remove the bullet marker and write one short plain sentence per line.",
    ),
    (
        "body.format.horizontal_rule",
        _HORIZONTAL_RULE_RE,
        "Markdown horizontal rules are not allowed.",
        "Separator markup consumes tokens; the fixed labels already separate concerns.",
        "Remove the separator line.",
    ),
)

_FORBIDDEN_METADATA_PATTERNS: tuple[
    tuple[str, re.Pattern[str], str, str, str], ...
] = (
    (
        "bold",
        _BOLD_RE,
        "Bold Markdown is not allowed in metadata.",
        "Formatting markers inflate every retrieval descriptor without adding meaning.",
        "Remove ** or __ markers and keep the value as plain text.",
    ),
    (
        "italic",
        re.compile(
            rf"(?:{_ITALIC_STAR_RE.pattern}|{_ITALIC_UNDERSCORE_RE.pattern})"
        ),
        "Italic Markdown is not allowed in metadata.",
        "Emphasis markers inflate every retrieval descriptor without adding meaning.",
        "Remove the emphasis markers; ordinary field_name underscores remain valid.",
    ),
    (
        "underline",
        _UNDERLINE_RE,
        "Underline formatting is not allowed in metadata.",
        "Presentation markup is not useful retrieval evidence.",
        "Remove underline markup and keep the value as plain text.",
    ),
    (
        "strikethrough",
        _STRIKETHROUGH_RE,
        "Strikethrough Markdown is not allowed in metadata.",
        "Deleted-looking metadata is ambiguous and spends descriptor tokens.",
        "Delete obsolete wording or replace it with the intended plain text.",
    ),
    (
        "code",
        re.compile(r"`"),
        "Code formatting is not allowed in metadata.",
        "Backticks add presentation tokens without improving retrieval.",
        "Remove every backtick and retain the identifier as plain text.",
    ),
    (
        "link",
        re.compile(
            rf"(?:{_MARKDOWN_LINK_RE.pattern}|{_AUTOLINK_RE.pattern})",
            re.IGNORECASE,
        ),
        "Markdown links or images are not allowed in metadata.",
        "Link syntax can hide the actual applicability value and wastes context.",
        "State the value directly; retain a plain URL only when indispensable.",
    ),
    (
        "html",
        _RAW_HTML_RE,
        "Raw HTML is not allowed in metadata.",
        "HTML is presentation markup, not retrieval evidence.",
        "Remove the tags and keep only their plain-text meaning.",
    ),
    (
        "heading",
        _ATX_HEADING_RE,
        "Markdown heading syntax is not allowed in metadata.",
        "The metadata field name already supplies structure.",
        "Remove the leading # characters and keep the value as plain text.",
    ),
    (
        "table",
        re.compile(r"\|"),
        "Table-like pipe characters are not allowed in metadata.",
        "Pipe-delimited values are ambiguous and can be parsed as presentation markup.",
        "Replace the pipe expression with one concise value or separate list values.",
    ),
)


def _as_values(meta: dict[str, object], key: str) -> tuple[str, ...]:
    value = meta.get(key)
    if isinstance(value, tuple):
        return tuple(str(item).strip() for item in value if str(item).strip())
    if isinstance(value, str) and value.strip():
        return (value.strip(),)
    return ()


def _metadata_format_issues(
    field: str,
    values: tuple[str, ...],
) -> list[RunbookValidationIssue]:
    """Reject presentation syntax from values that enter retrieval descriptors."""
    issues: list[RunbookValidationIssue] = []
    joined = "\n".join(values)
    for kind, pattern, problem, reason, fix in _FORBIDDEN_METADATA_PATTERNS:
        if pattern.search(joined):
            issues.append(
                _issue(
                    f"manifest.{field}.format.{kind}",
                    field,
                    problem,
                    reason,
                    fix,
                )
            )
    return issues


def _manifest_syntax_issues(content: str) -> list[RunbookValidationIssue]:
    """Find unsupported or duplicate frontmatter without changing the tiny parser."""
    match = _FRONTMATTER_RE.match(content.lstrip("﻿"))
    if match is None:
        return []
    issues: list[RunbookValidationIssue] = []
    seen: set[str] = set()
    active_list = False
    for number, line in enumerate(match.group(1).splitlines(), start=2):
        if not line.strip():
            continue
        if line.lstrip().startswith("- ") and active_list:
            continue
        active_list = False
        if ":" not in line:
            issues.append(
                _issue(
                    "manifest.syntax.invalid",
                    "manifest",
                    f"Frontmatter line {number} is not a key: value entry.",
                    "Ignored metadata makes retrieval applicability incomplete.",
                    "Write the field as key: value or remove the line.",
                )
            )
            continue
        key, _, value = line.partition(":")
        key = key.strip()
        if key in seen:
            issues.append(
                _issue(
                    "manifest.field.duplicate",
                    key or "manifest",
                    f"Frontmatter field {key!r} is repeated.",
                    "Duplicate metadata is ambiguous and the last value would silently win.",
                    f"Keep exactly one {key}: entry.",
                )
            )
        seen.add(key)
        if key not in _ALLOWED_MANIFEST_FIELDS:
            issues.append(
                _issue(
                    "manifest.field.unsupported",
                    key or "manifest",
                    f"Frontmatter field {key!r} is not supported.",
                    "Unknown fields are not indexed and waste authoring context.",
                    "Remove it or move its essential meaning into a supported field.",
                )
            )
        stripped_value = value.strip()
        if stripped_value.startswith("[") != stripped_value.endswith("]"):
            issues.append(
                _issue(
                    "manifest.syntax.invalid_list",
                    key or "manifest",
                    f"Frontmatter list {key!r} has an unmatched square bracket.",
                    "Malformed lists can silently change retrieval metadata.",
                    f"Write {key}: [value, value] with both brackets.",
                )
            )
        active_list = not value.strip()
    return issues


def _canonical_body_label(line: str) -> tuple[str, bool] | None:
    value = line.strip()
    candidate = value[:-1].strip() if value.endswith(":") else value
    upper = candidate.upper()
    if upper not in _ALL_BODY_LABELS:
        return None
    return upper, value == upper


def _meaningful_content(text: str) -> bool:
    compact = re.sub(r"\s+", " ", text).strip()
    return len(compact) >= MIN_SECTION_CONTENT_CHARS and _PLACEHOLDER_RE.search(compact) is None


def _body_structure_issues(body: str) -> list[RunbookValidationIssue]:
    issues: list[RunbookValidationIssue] = []
    lines = body.replace("\r\n", "\n").replace("\r", "\n").splitlines()
    occurrences: list[tuple[str, int, bool]] = []
    for index, line in enumerate(lines):
        parsed = _canonical_body_label(line)
        if parsed is not None:
            occurrences.append((parsed[0], index, parsed[1]))
        elif re.fullmatch(r"[A-Z][A-Z0-9 _/&-]{2,}:?", line.strip()):
            issues.append(
                _issue(
                    "body.structure.label_unknown",
                    "body",
                    f"Unknown body label {line.strip()!r} is not allowed.",
                    "A fixed label vocabulary keeps every retrieved runbook predictable.",
                    "Remove it or move its guidance under one of the supported labels.",
                )
            )

    positions: dict[str, list[int]] = {label: [] for label in _ALL_BODY_LABELS}
    for label, index, exact in occurrences:
        positions[label].append(index)
        if not exact:
            issues.append(
                _issue(
                    "body.structure.label_format",
                    f"body.{label}",
                    f"{label} must be uppercase, without punctuation, on its own line.",
                    "Exact labels make the guidance deterministic to validate and retrieve.",
                    f"Replace that line with exactly: {label}",
                )
            )

    for label in REQUIRED_BODY_LABELS:
        if not positions[label]:
            issues.append(
                _issue(
                    "body.structure.section_missing",
                    f"body.{label}",
                    f"Required section {label} is missing.",
                    "Every runbook must carry the same complete evidence and decision scaffold.",
                    (
                        f"Add {label} on its own line in the required position, "
                        "then add guidance below it."
                    ),
                )
            )
    for label, indexes in positions.items():
        if len(indexes) > 1:
            issues.append(
                _issue(
                    "body.structure.section_duplicate",
                    f"body.{label}",
                    f"Section {label} appears more than once.",
                    "Duplicate sections waste context and make precedence ambiguous.",
                    f"Merge the guidance under one {label} label.",
                )
            )

    first_positions = [
        (label, indexes[0]) for label, indexes in positions.items() if indexes
    ]
    expected_order = {label: index for index, label in enumerate(_ALL_BODY_LABELS)}
    observed = [label for label, _ in sorted(first_positions, key=lambda item: item[1])]
    if observed != sorted(observed, key=expected_order.__getitem__):
        issues.append(
            _issue(
                "body.structure.section_order",
                "body",
                "Body sections are not in the required order.",
                "Stable ordering reduces retrieval ambiguity for smaller models.",
                "Order the labels as: " + " → ".join(_ALL_BODY_LABELS) + ".",
            )
        )

    if occurrences:
        first_index = min(item[1] for item in occurrences)
        if any(line.strip() for line in lines[:first_index]):
            issues.append(
                _issue(
                    "body.structure.leading_content",
                    "body",
                    "Guidance appears before the SIGNAL label.",
                    "Unlabelled content cannot be assigned a deterministic meaning.",
                    "Move it into the appropriate required section.",
                )
            )

    ordered_occurrences = sorted(occurrences, key=lambda item: item[1])
    for occurrence_index, (label, line_index, _exact) in enumerate(ordered_occurrences):
        next_index = (
            ordered_occurrences[occurrence_index + 1][1]
            if occurrence_index + 1 < len(ordered_occurrences)
            else len(lines)
        )
        section_lines = [
            line.strip()
            for line in lines[line_index + 1 : next_index]
            if line.strip()
        ]
        section_text = "\n".join(section_lines)
        if not _meaningful_content(section_text):
            issues.append(
                _issue(
                    "body.structure.section_incomplete",
                    f"body.{label}",
                    f"Section {label} does not contain meaningful guidance.",
                    "Empty, very short, or placeholder sections cannot ground an investigation.",
                    f"Add at least {MIN_SECTION_CONTENT_CHARS} specific characters below {label}.",
                )
            )
            if not section_lines:
                continue
        if label == "INVESTIGATION STEPS":
            numbers: list[int] = []
            invalid_lines = False
            short_steps = False
            for line in section_lines:
                match = re.fullmatch(r"(\d+)\.\s+(.+)", line)
                if match is None:
                    invalid_lines = True
                    continue
                numbers.append(int(match.group(1)))
                if not _meaningful_content(match.group(2)):
                    short_steps = True
            if invalid_lines or not numbers:
                issues.append(
                    _issue(
                        "body.steps.format",
                        "body.INVESTIGATION STEPS",
                        "Every investigation step must be one numbered line.",
                        "One-line numbered steps are compact and deterministic for smaller models.",
                        "Use only lines such as 1. Inspect authentication outcomes.",
                    )
                )
            if numbers and numbers != list(range(1, len(numbers) + 1)):
                issues.append(
                    _issue(
                        "body.steps.sequence",
                        "body.INVESTIGATION STEPS",
                        "Investigation step numbers are not sequential from 1.",
                        "Stable numbering prevents missing or duplicated procedural steps.",
                        "Renumber the one-line steps as 1., 2., 3., without gaps.",
                    )
                )
            if short_steps:
                issues.append(
                    _issue(
                        "body.steps.incomplete",
                        "body.INVESTIGATION STEPS",
                        "One or more investigation steps are too short or still placeholders.",
                        "A step must name a concrete evidence check or analyst action.",
                        (
                            f"Give every step at least {MIN_SECTION_CONTENT_CHARS} "
                            "specific characters."
                        ),
                    )
                )
        elif any(re.match(r"^\d+\.\s+", line) for line in section_lines):
            issues.append(
                _issue(
                    "body.structure.numbered_outside_steps",
                    f"body.{label}",
                    f"Numbered lines are only allowed under INVESTIGATION STEPS, not {label}.",
                    "Numbers outside the procedure blur evidence signals with ordered actions.",
                    "Remove the number and keep each item as a plain sentence line.",
                )
            )
    return issues


def _collect_submission_issues(
    content: str,
    *,
    expected_id: str | None,
) -> tuple[list[RunbookValidationIssue], int]:
    issues: list[RunbookValidationIssue] = []
    text = content if isinstance(content, str) else ""
    if not text.strip():
        return (
            [
                _issue(
                    "document.required",
                    "content",
                    "Runbook content is required.",
                    "The catalog cannot index an empty runbook.",
                    "Start from the in-product template and complete every required field.",
                )
            ],
            0,
        )
    if "\x00" in text:
        issues.append(
            _issue(
                "document.nul_byte",
                "content",
                "Runbook content contains a NUL byte.",
                "NUL bytes are not valid authoring text and can break downstream storage.",
                "Remove the NUL byte and paste clean UTF-8 text.",
            )
        )
    if len(text.encode("utf-8")) > MAX_RUNBOOK_BYTES:
        issues.append(
            _issue(
                "document.too_large",
                "content",
                "The complete runbook exceeds the 128 KiB storage safety limit.",
                "The outer safety bound protects durable state and API payloads.",
                "Remove pasted logs or attachments; keep only concise guidance.",
            )
        )

    requested_id = str(expected_id or "").strip()
    if expected_id is not None and _RUNBOOK_ID_RE.fullmatch(requested_id) is None:
        issues.append(
            _issue(
                "manifest.id.invalid",
                "id",
                "The requested runbook id is not a valid lowercase slug.",
                "Stable ids are used for durable storage and retrieval document identifiers.",
                "Use 1–64 lowercase letters, numbers, hyphens, or underscores.",
            )
        )
    elif requested_id in _RESERVED_IDS:
        issues.append(
            _issue(
                "manifest.id.reserved",
                "id",
                f"The requested runbook id {requested_id!r} is reserved.",
                "Reserved ids are used by catalog operations.",
                "Choose a descriptive signal-family id that is not reserved.",
            )
        )

    meta, body = parse_frontmatter(text)
    body_characters = len(body)
    if not meta:
        issues.append(
            _issue(
                "manifest.required",
                "manifest",
                "Frontmatter is missing or malformed.",
                "Applicability metadata is required for accurate retrieval.",
                "Begin and end the supported key: value fields with --- lines.",
            )
        )
    else:
        issues.extend(_manifest_syntax_issues(text))
        for field in ("id", "title", "summary", "persona"):
            value = meta.get(field)
            if value is not None and not isinstance(value, str):
                issues.append(
                    _issue(
                        "manifest.field.type",
                        field,
                        f"Frontmatter field {field} must be one plain scalar value.",
                        "A list in a scalar field produces ambiguous catalog metadata.",
                        f"Write one line in the form {field}: concise value.",
                    )
                )
        for field in ("title", "summary", "persona"):
            value = meta.get(field)
            if isinstance(value, str) and value.strip():
                issues.extend(_metadata_format_issues(field, (value.strip(),)))
        for field in (
            "applies_to_rules",
            "applies_to_techniques",
            "applies_to_entities",
            "keywords",
        ):
            issues.extend(_metadata_format_issues(field, _as_values(meta, field)))
        for field in ("id", "title", "summary"):
            value = str(meta.get(field) or "").strip()
            if not value:
                issues.append(
                    _issue(
                        f"manifest.{field}.required",
                        field,
                        f"Required frontmatter field {field} is missing or empty.",
                        "High-signal metadata is needed for catalog discovery and retrieval.",
                        f"Add a concise {field}: value to the frontmatter.",
                    )
                )
            elif _PLACEHOLDER_RE.search(value):
                issues.append(
                    _issue(
                        f"manifest.{field}.placeholder",
                        field,
                        f"Required frontmatter field {field} still contains placeholder text.",
                        "Placeholder metadata weakens catalog discovery and retrieval precision.",
                        f"Replace {field} with a specific production value.",
                    )
                )
        for field in ("applies_to_rules", "applies_to_entities", "keywords"):
            values = _as_values(meta, field)
            if not values:
                issues.append(
                    _issue(
                        f"manifest.{field}.required",
                        field,
                        f"Required frontmatter field {field} needs at least one value.",
                        "The agent uses this field to retrieve the runbook for the right signal.",
                        f"Add at least one specific value, for example {field}: [value].",
                    )
                )
            elif any(_PLACEHOLDER_RE.search(value) for value in values):
                issues.append(
                    _issue(
                        f"manifest.{field}.placeholder",
                        field,
                        f"Required frontmatter field {field} contains a placeholder value.",
                        "Placeholder tags cannot retrieve the runbook for real telemetry.",
                        f"Replace every placeholder in {field} with a specific value.",
                    )
                    )

        for field in ("persona", "applies_to_techniques"):
            values = _as_values(meta, field)
            if any(_PLACEHOLDER_RE.search(value) for value in values):
                issues.append(
                    _issue(
                        f"manifest.{field}.placeholder",
                        field,
                        f"Optional frontmatter field {field} contains placeholder text.",
                        "Placeholder metadata weakens retrieval precision and wastes context.",
                        f"Replace every placeholder in {field} with a specific value or remove the field.",
                    )
                )

        raw_id = str(meta.get("id") or "").strip()
        if raw_id and _RUNBOOK_ID_RE.fullmatch(raw_id) is None:
            issues.append(
                _issue(
                    "manifest.id.invalid",
                    "id",
                    "The frontmatter id is not a valid lowercase slug.",
                    "Stable ids are used for durable storage and retrieval document identifiers.",
                    "Use 1–64 lowercase letters, numbers, hyphens, or underscores.",
                )
            )
        elif raw_id in _RESERVED_IDS:
            issues.append(
                _issue(
                    "manifest.id.reserved",
                    "id",
                    f"The runbook id {raw_id!r} is reserved.",
                    "Reserved ids are used by catalog operations.",
                    "Choose a descriptive signal-family id that is not reserved.",
                )
            )
        if expected_id is not None and raw_id and raw_id != expected_id:
            issues.append(
                _issue(
                    "manifest.id.mismatch",
                    "id",
                    f"Frontmatter id {raw_id!r} does not match requested id {expected_id!r}.",
                    "One stable id must identify both the stored record and retrieval document.",
                    f"Change the frontmatter line to id: {expected_id}",
                )
            )

        title = str(meta.get("title") or "").strip()
        summary = str(meta.get("summary") or "").strip()
        persona = str(meta.get("persona") or "").strip()
        for field, value, maximum in (
            ("title", title, MAX_TITLE_CHARS),
            ("summary", summary, MAX_SUMMARY_CHARS),
            ("persona", persona, MAX_PERSONA_CHARS),
        ):
            if len(value) > maximum:
                issues.append(
                    _issue(
                        f"manifest.{field}.too_long",
                        field,
                        f"{field} is {len(value)} characters; maximum is {maximum}.",
                        "Bounded metadata keeps every retrieved descriptor concise.",
                        f"Shorten {field} to {maximum} characters or fewer.",
                    )
                )
        for field in (
            "applies_to_rules",
            "applies_to_techniques",
            "applies_to_entities",
            "keywords",
        ):
            values = _as_values(meta, field)
            folded_values = [value.casefold() for value in values]
            if len(folded_values) != len(set(folded_values)):
                issues.append(
                    _issue(
                        f"manifest.{field}.duplicate",
                        field,
                        f"{field} contains duplicate values.",
                        "Repeated metadata spends descriptor tokens without improving retrieval.",
                        "Remove duplicates, treating uppercase and lowercase values as the same.",
                    )
                )
            if len(values) > MAX_LIST_ITEMS:
                issues.append(
                    _issue(
                        f"manifest.{field}.too_many",
                        field,
                        f"{field} has {len(values)} values; maximum is {MAX_LIST_ITEMS}.",
                        "Broad metadata reduces retrieval precision and inflates every chunk.",
                        "Keep only values that directly identify this signal family.",
                    )
                )
            if any(len(value) > MAX_LIST_ITEM_CHARS for value in values):
                issues.append(
                    _issue(
                        f"manifest.{field}.item_too_long",
                        field,
                        f"A {field} value exceeds {MAX_LIST_ITEM_CHARS} characters.",
                        "Oversized tags inflate every retrieved runbook chunk.",
                        f"Shorten each value to {MAX_LIST_ITEM_CHARS} characters or fewer.",
                    )
                )
        techniques = _as_values(meta, "applies_to_techniques")
        if any(_MITRE_RE.fullmatch(value) is None for value in techniques):
            issues.append(
                _issue(
                    "manifest.applies_to_techniques.invalid",
                    "applies_to_techniques",
                    "One or more MITRE technique ids are invalid.",
                    "Canonical ids improve exact retrieval and avoid invented techniques.",
                    "Use ids such as T1234 or T1234.001, or remove the optional field.",
                )
            )

        descriptor_candidate = _to_runbook(
            meta,
            body,
            raw_id or requested_id or "runbook",
        )
        descriptor_characters = max(
            len(descriptor_candidate.retrieval_descriptor()),
            len(descriptor_candidate.embedding_descriptor()),
        )
        if descriptor_characters > MAX_RETRIEVAL_DESCRIPTOR_CHARS:
            issues.append(
                _issue(
                    "manifest.descriptor.too_long",
                    "manifest",
                    (
                        "The combined retrieval metadata is "
                        f"{descriptor_characters} characters; maximum is "
                        f"{MAX_RETRIEVAL_DESCRIPTOR_CHARS}."
                    ),
                    (
                        "Metadata prefixes every retrieved guidance chunk, so an oversized "
                        "descriptor increases inference cost on every match."
                    ),
                    (
                        "Remove broad synonyms and keep only the most specific title, summary, "
                        "rules, techniques, entities, and keywords until the combined descriptor "
                        f"is {MAX_RETRIEVAL_DESCRIPTOR_CHARS} characters or fewer."
                    ),
                )
            )

    if not body:
        issues.append(
            _issue(
                "body.required",
                "body",
                "The guidance body is empty.",
                "A runbook needs evidence and decision guidance to help an investigation.",
                "Complete every required body section in the in-product template.",
            )
        )
    else:
        if body_characters > MAX_RUNBOOK_BODY_CHARS:
            issues.append(
                _issue(
                    "body.too_long",
                    "body",
                    (
                        f"The guidance body is {body_characters} characters; "
                        f"maximum is {MAX_RUNBOOK_BODY_CHARS}."
                    ),
                    (
                        "A single bounded guidance chunk reduces cost and improves "
                        "smaller-model focus."
                    ),
                    (
                        f"Remove repetition and examples until the body is "
                        f"{MAX_RUNBOOK_BODY_CHARS} Unicode characters or fewer."
                    ),
                )
            )
        seen_format_codes: set[str] = set()
        for code, pattern, problem, reason, fix in _FORBIDDEN_BODY_PATTERNS:
            if code not in seen_format_codes and pattern.search(body):
                issues.append(_issue(code, "body", problem, reason, fix))
                seen_format_codes.add(code)
        if _PLACEHOLDER_RE.search(body):
            issues.append(
                _issue(
                    "body.placeholder",
                    "body",
                    "The guidance still contains template placeholder text.",
                    "Placeholder scaffolding supplies no evidence and can mislead the agent.",
                    (
                        "Replace every bracketed instruction, TODO, or TBD with "
                        "case-specific guidance."
                    ),
                )
            )
        issues.extend(_body_structure_issues(body))

    # Keep one actionable item for each exact code+field pair.
    unique: list[RunbookValidationIssue] = []
    seen: set[tuple[str, str]] = set()
    for item in issues:
        key = (item.code, item.field)
        if key not in seen:
            unique.append(item)
            seen.add(key)
    return unique, body_characters


def parse_runbook_document(
    content: str,
    *,
    expected_id: str | None = None,
    source_path: str = "",
    enforce_authoring_standard: bool = False,
) -> Runbook:
    """Validate one document and return its model.

    Compatibility parsing remains available for existing durable operator records;
    create/update callers opt into the strict authoring standard. Bundled files are
    also loaded strictly so the shipped catalog cannot regress.
    """
    if enforce_authoring_standard:
        issues, body_characters = _collect_submission_issues(
            content,
            expected_id=expected_id,
        )
        if issues:
            raise RunbookValidationError(
                issues,
                body_characters=body_characters,
            )
    if not isinstance(content, str) or not content.strip():
        raise RunbookManagementError("runbook content is required")
    if "\x00" in content:
        raise RunbookManagementError("runbook content may not contain NUL bytes")
    if len(content.encode("utf-8")) > MAX_RUNBOOK_BYTES:
        raise RunbookManagementError("runbook exceeds the 128 KiB management limit")
    meta, body = parse_frontmatter(content)
    if not meta:
        raise RunbookManagementError("runbook front matter is required")
    runbook_id = validate_runbook_id(str(meta.get("id") or expected_id or ""))
    if expected_id is not None and runbook_id != expected_id:
        raise RunbookManagementError(
            f"front-matter id {runbook_id!r} must match {expected_id!r}"
        )
    title = str(meta.get("title") or "").strip()
    if not title:
        raise RunbookManagementError("runbook title is required")
    title_max = MAX_TITLE_CHARS if enforce_authoring_standard else _LEGACY_MAX_TITLE_CHARS
    summary_max = MAX_SUMMARY_CHARS if enforce_authoring_standard else _LEGACY_MAX_SUMMARY_CHARS
    persona_max = MAX_PERSONA_CHARS if enforce_authoring_standard else _LEGACY_MAX_PERSONA_CHARS
    list_max = MAX_LIST_ITEMS if enforce_authoring_standard else _LEGACY_MAX_LIST_ITEMS
    list_item_max = (
        MAX_LIST_ITEM_CHARS
        if enforce_authoring_standard
        else _LEGACY_MAX_LIST_ITEM_CHARS
    )
    if len(title) > title_max:
        raise RunbookManagementError(f"runbook title exceeds {title_max} characters")
    summary = str(meta.get("summary") or "").strip()
    if len(summary) > summary_max:
        raise RunbookManagementError(f"runbook summary exceeds {summary_max} characters")
    persona = str(meta.get("persona") or "").strip()
    if len(persona) > persona_max:
        raise RunbookManagementError(f"runbook persona exceeds {persona_max} characters")
    if not body.strip():
        raise RunbookManagementError("runbook guidance body is required")
    runbook = _to_runbook(meta, body, runbook_id, source_path=source_path)
    for label, values in (
        ("applies_to_rules", runbook.applies_to_rules),
        ("applies_to_techniques", runbook.applies_to_techniques),
        ("applies_to_entities", runbook.applies_to_entities),
        ("keywords", runbook.keywords),
    ):
        if len(values) > list_max:
            raise RunbookManagementError(f"{label} exceeds {list_max} items")
        if any(len(value) > list_item_max for value in values):
            raise RunbookManagementError(
                f"{label} items may not exceed {list_item_max} characters"
            )
    if any(_MITRE_RE.fullmatch(value) is None for value in runbook.applies_to_techniques):
        raise RunbookManagementError("MITRE techniques must look like T1234 or T1234.001")
    return runbook


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
                runbooks.append(
                    parse_runbook_document(
                        path.read_text(encoding="utf-8"),
                        expected_id=None,
                        source_path=str(path),
                        enforce_authoring_standard=True,
                    )
                )
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
    return [
        item
        for rb in (runbooks if runbooks is not None else load_runbooks())
        for item in rb.as_corpus_items()
    ]

# NOTE: per-cluster PROCEDURE selection now lives in ``app/playbooks/`` (the
# Markdown playbook registry). Runbooks here are RAG knowledge only — there is no
# ``select_runbook`` anymore.
