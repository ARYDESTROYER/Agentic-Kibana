"""Dependency-free text chunker for RAG document ingestion.

Splits a document into retrieval-sized chunks WITHOUT any new dependency. The
strategy mirrors how the runbook corpus is built: prefer natural paragraph
boundaries (blank lines), then PACK paragraphs greedily up to ``target_chars`` so
a chunk stays a coherent unit, with a small character ``overlap`` carried from the
tail of the previous chunk into the next so a fact straddling a boundary is still
retrievable from at least one chunk.

Guarantees (relied on by the importer + tests):
* Non-empty input NEVER yields an empty list (a single short doc → one chunk).
* A single paragraph longer than ``target_chars`` is hard-split (never dropped).
* Whitespace-only input yields ``[]``.
"""

from __future__ import annotations

import re

# Split on one-or-more blank lines (paragraph boundaries). Tolerates CRLF.
_PARA_RE = re.compile(r"\n\s*\n+")


def _hard_split(paragraph: str, target_chars: int) -> list[str]:
    """Split an over-long single paragraph into <= target_chars pieces.

    Tries to break on whitespace near the limit so words are not severed; falls
    back to a hard character cut if there is no nearby whitespace."""
    pieces: list[str] = []
    text = paragraph
    while len(text) > target_chars:
        window = text[:target_chars]
        cut = window.rfind(" ")
        # Only honour a whitespace break if it is reasonably far in, else hard cut.
        if cut < target_chars // 2:
            cut = target_chars
        pieces.append(text[:cut].strip())
        text = text[cut:].lstrip()
    if text.strip():
        pieces.append(text.strip())
    return [p for p in pieces if p]


def chunk_text(text: str, target_chars: int = 1200, overlap: int = 120) -> list[str]:
    """Chunk ``text`` into ~``target_chars`` pieces packed on paragraph boundaries.

    ``overlap`` characters from the tail of each emitted chunk are prepended to the
    next chunk to preserve cross-boundary context. Never raises; whitespace-only
    input returns ``[]`` and any non-empty input returns >= 1 chunk."""
    if not text or not text.strip():
        return []
    target_chars = max(1, int(target_chars))
    overlap = max(0, min(int(overlap), target_chars - 1))

    # Normalise newlines, then split into paragraphs; hard-split any monster paras.
    normalised = text.replace("\r\n", "\n").replace("\r", "\n")
    paragraphs: list[str] = []
    for raw in _PARA_RE.split(normalised):
        para = raw.strip()
        if not para:
            continue
        if len(para) > target_chars:
            paragraphs.extend(_hard_split(para, target_chars))
        else:
            paragraphs.append(para)

    if not paragraphs:
        # Input had content but no paragraph survived (shouldn't happen) — fall back
        # to a single trimmed chunk so non-empty input always yields a chunk.
        return [text.strip()]

    chunks: list[str] = []
    current = ""
    for para in paragraphs:
        if not current:
            current = para
            continue
        # +2 accounts for the "\n\n" join between paragraphs.
        if len(current) + len(para) + 2 <= target_chars:
            current = f"{current}\n\n{para}"
        else:
            chunks.append(current)
            tail = current[-overlap:].strip() if overlap else ""
            current = f"{tail}\n\n{para}" if tail else para
    if current.strip():
        chunks.append(current.strip())

    return [c for c in chunks if c.strip()]
