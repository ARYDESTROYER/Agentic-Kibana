"""RAG retrieval over a small seed SOC knowledge base (Section 6.6).

The corpus ships in-process as Python constants — SOC runbook snippets, ATT&CK
techniques and suppression guidance — so RAG works with zero extra services and
degrades gracefully (Gate 2): if embedding fails the store is simply left empty
and ``retrieve`` returns ``[]`` rather than raising. Embeddings flow through the
single LLM gateway, which itself falls back to deterministic local hashing when
no embedding key is configured, so the whole path stays offline-capable.

A Chroma-backed ``VectorStore`` can be dropped in behind the same interface
(Section 6.6) without touching this module's callers.
"""

from __future__ import annotations

import hashlib
import logging
import math
import re
from typing import TYPE_CHECKING, Any

from ..config import Preferences
from ..constants import CaseStatus
from ..engine.chunking import chunk_text
from ..engine.runbooks import corpus_items as runbook_corpus_items
from ..llm.gateway import LLMGateway
from ..models import RagChunk
from ..utils import iso_now
from .base import Tool, ToolResult
from .vectorstore import (
    EmbeddingSpaceMismatch,
    InMemoryVectorStore,
    StoredChunk,
    VectorStore,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..models import Case
    from ..stores.cases import CaseStore

logger = logging.getLogger("tlsoc.tools.rag")

# Built-in seed corpus sources — guarded from deletion via the management API
# unless an explicit force=True is passed (so an operator cannot accidentally wipe
# the shipped knowledge base while curating imported documents). ``resolved_case``
# (the institutional-memory loop) is accumulated at runtime, not seeded; it is
# guarded here so a bulk "clear imported docs" cannot drop prior analyst decisions.
SEED_SOURCES = frozenset({"runbook", "mitre", "suppression", "resolved_case"})

# The corpus source tag for operator-imported threat-intelligence documents (F11).
# Retrievable like any other knowledge and injected as a TRUSTED fenced block.
THREAT_CONTEXT_SOURCE = "threat_context"

# TRUSTED-KNOWLEDGE ALLOWLIST (OWASP LLM01 hardening). Only chunks whose ``source``
# is in this allowlist are rendered as TRUSTED reference material in a prompt; ANY
# other retrieved chunk — notably operator/user-IMPORTED documents
# (``import_document`` → source="imported"), pasted threat-intel
# (``threat_context``), or any future/unknown source — is attacker-influenceable
# and MUST be wrapped in the UNTRUSTED fence (#9) before it enters a prompt, exactly
# like raw log evidence. This is an ALLOWLIST (default-deny), not a denylist, so a
# new corpus source is UNTRUSTED until someone deliberately adds it here.
#
# The set is the system-verified seed corpus: shipped operator runbooks, the bundled
# MITRE ATT&CK technique descriptions, and our own suppression guidance. NOTE:
# ``resolved_case`` is intentionally NOT trusted-rendered — its text is derived from
# case fields (entity/rules/evidence/notes), which are log-derived and therefore
# attacker-influenceable, so it is fenced as an UNTRUSTED baseline at render time.
TRUSTED_KNOWLEDGE_SOURCES = frozenset({"runbook", "mitre", "suppression"})


def is_trusted_knowledge(source: str | None) -> bool:
    """Whether a retrieved RAG chunk's ``source`` is in the TRUSTED allowlist.

    Default-deny: anything not explicitly allow-listed (imported docs, pasted
    threat-intel, unknown/future sources) is UNTRUSTED and must be fenced before it
    reaches a model prompt (#9 / OWASP LLM01)."""
    return source in TRUSTED_KNOWLEDGE_SOURCES

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(title: str) -> str:
    slug = _SLUG_RE.sub("-", (title or "").strip().lower()).strip("-")
    return slug[:60] or "document"


def _shorthash(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:8]


# --------------------------------------------------------------------------- #
# Seed corpus — each item is {text, source, metadata}.
# --------------------------------------------------------------------------- #
SEED_RUNBOOKS: list[dict[str, Any]] = [
    {
        "text": (
            "SSH brute force / failed login runbook: A burst of failed authentication "
            "attempts (sshd 'Failed password', many auth failures) from one source IP "
            "against a host indicates brute force. Confirm whether any attempt succeeded, "
            "check the breadth of targeted usernames, and block the source IP if hostile."
        ),
        "source": "runbook",
        "metadata": {"topic": "brute_force", "rule": "sshd", "mitre": "T1110"},
    },
    {
        "text": (
            "Web application / ModSecurity WAF alert runbook: ModSec or WAF rule triggers "
            "(SQLi, XSS, path traversal, LFI) against a public web app. Inspect the request "
            "payload and response code — a 200 on a flagged request suggests the exploit may "
            "have reached the app. Correlate by client IP across endpoints."
        ),
        "source": "runbook",
        "metadata": {"topic": "web_attack", "rule": "modsecurity", "mitre": "T1190"},
    },
    {
        "text": (
            "Port scan / Suricata reconnaissance runbook: Suricata 'ET SCAN' or many "
            "connection attempts to distinct ports from a single source IP indicate port "
            "scanning. Treat as reconnaissance; assess how many ports/hosts were probed and "
            "whether any service responded before deciding to block."
        ),
        "source": "runbook",
        "metadata": {"topic": "port_scan", "rule": "suricata", "mitre": "T1046"},
    },
    {
        "text": (
            "Suspicious mail / Postfix runbook: Postfix logs showing high-volume relay "
            "attempts, repeated rejected recipients, or auth failures on submission can mean "
            "spam relay abuse or credential stuffing against mail. Check sender reputation, "
            "rejection reasons and whether any authentication succeeded."
        ),
        "source": "runbook",
        "metadata": {"topic": "mail_abuse", "rule": "postfix", "mitre": "T1566"},
    },
    {
        "text": (
            "Vulnerability scan / Nessus-OpenVAS runbook: Bursts of varied requests probing "
            "known CVEs and default paths from one IP indicate an automated vulnerability "
            "scanner (Nessus, OpenVAS, nikto). Distinguish authorised internal scans from "
            "hostile external scanning before escalating."
        ),
        "source": "runbook",
        "metadata": {"topic": "vuln_scan", "rule": "nessus-openvas", "mitre": "T1595"},
    },
    {
        "text": (
            "Malicious IP reputation runbook: When threat-intel enrichment flags a source IP "
            "with a high reputation score (AbuseIPDB/VirusTotal), prioritise the case. "
            "Correlate the IP's activity across rules and hosts, capture all touched assets "
            "and recommend blocking at the perimeter."
        ),
        "source": "runbook",
        "metadata": {"topic": "ip_reputation", "rule": "enrichment", "mitre": "T1071"},
    },
]

SEED_MITRE: list[dict[str, Any]] = [
    {
        "text": "T1110 Brute Force: Adversaries guess passwords via repeated authentication attempts.",
        "source": "mitre",
        "metadata": {"technique_id": "T1110", "name": "Brute Force"},
    },
    {
        "text": "T1046 Network Service Discovery: Adversaries scan for listening services to map attack surface.",
        "source": "mitre",
        "metadata": {"technique_id": "T1046", "name": "Network Service Discovery"},
    },
    {
        "text": "T1190 Exploit Public-Facing Application: Adversaries exploit a flaw in an internet-facing app.",
        "source": "mitre",
        "metadata": {"technique_id": "T1190", "name": "Exploit Public-Facing Application"},
    },
    {
        "text": "T1566 Phishing: Adversaries send malicious messages to obtain access or credentials.",
        "source": "mitre",
        "metadata": {"technique_id": "T1566", "name": "Phishing"},
    },
    {
        "text": "T1071 Application Layer Protocol: Adversaries use common protocols (HTTP/DNS) for C2 to blend in.",
        "source": "mitre",
        "metadata": {"technique_id": "T1071", "name": "Application Layer Protocol"},
    },
    {
        "text": "T1595 Active Scanning: Adversaries actively probe infrastructure to gather information before attack.",
        "source": "mitre",
        "metadata": {"technique_id": "T1595", "name": "Active Scanning"},
    },
    {
        "text": "T1078 Valid Accounts: Adversaries use legitimate credentials to gain or maintain access.",
        "source": "mitre",
        "metadata": {"technique_id": "T1078", "name": "Valid Accounts"},
    },
    {
        "text": "T1499 Endpoint Denial of Service: Adversaries flood a service to exhaust resources and deny access.",
        "source": "mitre",
        "metadata": {"technique_id": "T1499", "name": "Endpoint Denial of Service"},
    },
]

SEED_SUPPRESSION_GUIDANCE: list[dict[str, Any]] = [
    {
        "text": (
            "Benign pattern: Authenticated vulnerability scans from a known internal scanner "
            "IP on its scheduled window are expected and benign. Match the scanner's source "
            "IP and the maintenance schedule before suppressing."
        ),
        "source": "suppression",
        "metadata": {"topic": "internal_scanner"},
    },
    {
        "text": (
            "Benign pattern: A health-check or monitoring service repeatedly hitting an "
            "endpoint generates high request volume but is not an attack. Identify the "
            "monitoring user-agent or source IP to avoid false positives."
        ),
        "source": "suppression",
        "metadata": {"topic": "health_check"},
    },
    {
        "text": (
            "Benign pattern: A user fat-fingering a password a few times then succeeding is "
            "normal. Only a sustained burst of failures, especially across many usernames or "
            "with no eventual success, should be treated as brute force."
        ),
        "source": "suppression",
        "metadata": {"topic": "password_typo"},
    },
]


class RagService:
    """Embeds the enabled seed corpus once and serves nearest-neighbour retrieval.

    Beyond the static seed corpus it can index past CLOSED cases as institutional
    memory (``use_resolved_cases``), so an investigation can surface "we have seen
    this entity / verdict before". Every stored chunk is tagged with the embedding
    model + dim so an embedding-space change clears + reseeds rather than silently
    mixing incompatible vectors.
    """

    def __init__(
        self,
        gateway: LLMGateway,
        prefs: Preferences,
        store: VectorStore | None = None,
        cases: "CaseStore | None" = None,
    ) -> None:
        self._gateway = gateway
        self._prefs = prefs
        self._store: VectorStore = store or InMemoryVectorStore()
        self._cases = cases
        self._seeded = False

    def set_prefs(self, prefs: Preferences) -> None:
        """Point the service at the latest preferences so a live settings change
        (e.g. toggling rag.enabled / use_resolved_cases / min_score) takes effect
        without a full rewire."""
        self._prefs = prefs

    def _embedding_space(self) -> tuple[str, int]:
        cfg = self._prefs.model_for("embedding")
        # dim is settled at first embed; the model id is the stable space tag.
        return (cfg.model, 0)

    def _enabled_seeds(self) -> list[dict[str, Any]]:
        cfg = self._prefs.rag
        seeds: list[dict[str, Any]] = []
        if cfg.use_runbooks:
            # Prefer the plain-text runbook FILES (Vigil's "playbooks are files")
            # when runbooks are enabled and present; fall back to the in-code seed
            # snippets so RAG always has runbook coverage.
            file_items: list[dict[str, Any]] = []
            if getattr(self._prefs, "runbooks", None) is None or self._prefs.runbooks.enabled:
                try:
                    file_items = runbook_corpus_items()
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Runbook corpus load failed; using seed runbooks: %s", exc)
            seeds.extend(file_items or SEED_RUNBOOKS)
        if cfg.use_mitre:
            seeds.extend(SEED_MITRE)
        if cfg.use_suppression_rules:
            seeds.extend(SEED_SUPPRESSION_GUIDANCE)
        # ``use_resolved_cases`` is handled separately by index_resolved_cases()
        # because it requires an async load from the CaseStore.
        return seeds

    async def _embed_and_add(self, items: list[dict[str, Any]]) -> int:
        """Embed ``items`` (each {text, source, metadata}) and add to the store.

        Tags each chunk with the active embedding model + dim. Returns the count
        added. Caller handles failures."""
        if not items:
            return 0
        texts = [s["text"] for s in items]
        model_id = self._prefs.model_for("embedding").model
        vectors = await self._gateway.embed(
            texts, self._prefs.model_for("embedding"), surface="rag"
        )
        chunks = [
            StoredChunk(
                text=s["text"],
                source=s.get("source", "unknown"),
                metadata=dict(s.get("metadata", {})),
                embedding=vec,
                embedding_model=model_id,
                dim=len(vec),
                doc_id=s.get("doc_id"),
            )
            for s, vec in zip(items, vectors)
        ]
        await self._store.add(chunks)
        return len(chunks)

    async def ensure_seeded(self) -> None:
        """Idempotently embed and store the enabled sources. Fails closed.

        Includes resolved-case memory when ``prefs.rag.use_resolved_cases``."""
        if self._seeded:
            return
        self._seeded = True  # guard first so a failure does not loop on retry
        try:
            added = await self._embed_and_add(self._enabled_seeds())
            if self._prefs.rag.use_resolved_cases:
                added += await self.index_resolved_cases()
            logger.info("RAG seeded with %d chunk(s)", added)
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG seeding failed; store left as-is: %s", exc)

    async def index_resolved_cases(self, limit: int = 200) -> int:
        """Load CLOSED cases and index one chunk per case as institutional memory.

        The chunk text combines verdict + entity + rules + the top evidence
        summaries + recommended_action; source="resolved_case"; metadata carries
        case_id / verdict / entity so the UI/agent can cite the source case.
        Returns the number of chunks added. Never raises (logs + returns 0)."""
        if self._cases is None:
            return 0
        try:
            cases, _total = await self._cases.list(
                status=CaseStatus.CLOSED.value, limit=limit
            )
            items: list[dict[str, Any]] = []
            for case in cases:
                entity = f"{case.entity.type.value}:{case.entity.value}"
                rules = ", ".join(case.rule_ids) or "n/a"
                evidence = "; ".join(e.summary for e in case.evidence[:3]) or "n/a"
                verdict = case.verdict.value if case.verdict else "n/a"
                text = (
                    f"Resolved case {case.case_id}: verdict {verdict} for entity {entity}. "
                    f"Rules: {rules}. Evidence: {evidence}. "
                    f"Recommended action: {case.recommended_action or 'n/a'}."
                )
                items.append(
                    {
                        "text": text,
                        "source": "resolved_case",
                        "metadata": {
                            "case_id": case.case_id,
                            "verdict": verdict,
                            "entity": entity,
                        },
                    }
                )
            return await self._embed_and_add(items)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Indexing resolved cases failed: %s", exc)
            return 0

    async def index_resolved_case(self, case: "Case", note: str = "") -> int:
        """Index ONE resolved-case chunk on close as institutional memory (C3-5).

        Triggered from the case-action endpoint when an analyst closes / confirms-FP
        a case. The chunk combines entity + rules + verdict + risk + trigger reason +
        the analyst NOTE so future investigations of similar entities learn from the
        prior decision. Uses a DETERMINISTIC ``doc_id = resolved_case:{case_id}`` so
        re-closing OVERWRITES rather than duplicating. Gated by ``rag.enabled`` AND
        ``rag.use_resolved_cases``. FAIL-SAFE: returns 0 (never raises) so a failed
        embedding/vector-store write never breaks the close action (it still 200s)."""
        cfg = self._prefs.rag
        if not (cfg.enabled and cfg.use_resolved_cases):
            return 0
        try:
            entity = f"{case.entity.type.value}:{case.entity.value}"
            rules = ", ".join(case.rule_ids) or "n/a"
            verdict = case.verdict.value if case.verdict else "n/a"
            reason = (
                case.trigger_reason.sentence
                if case.trigger_reason and case.trigger_reason.sentence
                else ""
            )
            note = (note or "").strip()
            text = (
                f"Resolved case {case.case_id}: verdict {verdict} for entity {entity}. "
                f"Rules: {rules}. Risk: {round(case.risk_score, 1)}. "
                f"Trigger: {reason or 'n/a'}. Analyst note: {note or 'n/a'}."
            )
            item = {
                "text": text,
                "source": "resolved_case",
                "doc_id": f"resolved_case:{case.case_id}",
                "metadata": {
                    "case_id": case.case_id,
                    "verdict": verdict,
                    "entity": entity,
                    "status": case.status.value if case.status else "",
                    "note": note,
                },
            }
            return await self._embed_and_add([item])
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "index_resolved_case failed for %s: %s", getattr(case, "case_id", "?"), exc
            )
            return 0

    # ----------------------------------------------------------------- #
    # RAG knowledge-base management (see + manage the corpus). A "document"
    # is the set of chunks sharing ``metadata.document_id``. Imports affect
    # ``retrieve`` immediately (same corpus). All methods FAIL-SAFE.
    # ----------------------------------------------------------------- #
    async def import_document(
        self,
        title: str,
        text: str,
        *,
        source: str = "imported",
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """Chunk + embed ``text`` and add it as a managed document.

        Returns ``{document_id, title, source, chunk_count}``. A stable
        ``document_id = imported:<slug>:<shorthash>`` groups the chunks; each chunk
        gets ``doc_id = f"{document_id}:{i}"`` and the management metadata
        (document_id/title/source/tags/added_at/chunk_index/n_chunks). FAIL-SAFE:
        on any failure logs and returns ``chunk_count: 0`` (never raises)."""
        title = (title or "").strip() or "Untitled"
        tags = list(tags or [])
        try:
            await self.ensure_seeded()
            pieces = chunk_text(text or "")
            if not pieces:
                return {"document_id": "", "title": title, "source": source, "chunk_count": 0}
            document_id = f"imported:{_slugify(title)}:{_shorthash(text)}"
            added_at = iso_now()
            n = len(pieces)
            items: list[dict[str, Any]] = [
                {
                    "text": piece,
                    "source": source or "imported",
                    "doc_id": f"{document_id}:{i}",
                    "metadata": {
                        "document_id": document_id,
                        "title": title,
                        "source": source or "imported",
                        "tags": tags,
                        "added_at": added_at,
                        "chunk_index": i,
                        "n_chunks": n,
                    },
                }
                for i, piece in enumerate(pieces)
            ]
            added = await self._embed_and_add(items)
            return {
                "document_id": document_id,
                "title": title,
                "source": source or "imported",
                "chunk_count": added,
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG import_document(%r) failed: %s", title, exc)
            return {"document_id": "", "title": title, "source": source, "chunk_count": 0}

    async def import_threat_context(
        self, title: str, content: str, *, tags: list[str] | None = None
    ) -> dict[str, Any]:
        """Ingest an operator-supplied THREAT-INTEL document into the RAG corpus as
        ``source="threat_context"`` (F11). Retrievable like any knowledge and injected
        as a TRUSTED fenced block. Thin wrapper over :meth:`import_document` so all
        the chunking/embedding/dedup/fail-safe behaviour is reused. The content is
        UNTRUSTED corpus text — the investigator's render path fences it (#9)."""
        return await self.import_document(
            title, content, source=THREAT_CONTEXT_SOURCE, tags=tags
        )

    async def list_documents(self) -> list[dict[str, Any]]:
        """All documents in the corpus (seeds grouped as ``seed:<source>``). Never raises."""
        try:
            await self.ensure_seeded()
            return await self._store.list_documents()
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG list_documents failed: %s", exc)
            return []

    async def get_document(self, document_id: str) -> dict[str, Any] | None:
        """A document + its chunks (as dicts), or None if no such document. Never raises."""
        try:
            await self.ensure_seeded()
            chunks = await self._store.list_chunks(document_id)
            if not chunks:
                return None
            first = chunks[0]
            meta = first.metadata or {}
            return {
                "document_id": document_id,
                "title": str(meta.get("title") or document_id),
                "source": first.source,
                "tags": list(meta.get("tags") or []),
                "added_at": meta.get("added_at") or "",
                "chunk_count": len(chunks),
                "embedding_model": first.embedding_model,
                "dim": int(first.dim or len(first.embedding) or 0),
                "chunks": [
                    {
                        "text": c.text,
                        "source": c.source,
                        "chunk_index": int((c.metadata or {}).get("chunk_index", i) or i),
                        "metadata": dict(c.metadata or {}),
                    }
                    for i, c in enumerate(chunks)
                ],
            }
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG get_document(%s) failed: %s", document_id, exc)
            return None

    async def delete_document(self, document_id: str, *, force: bool = False) -> dict[str, Any]:
        """Delete a document's chunks. Guards the built-in seed sources
        (runbook/mitre/suppression/resolved_case) unless ``force=True``.

        Returns ``{deleted, guarded, found}``: ``found`` is whether the document
        existed, ``guarded`` is True when a seed source was refused, ``deleted`` is
        the chunk count removed. Never raises."""
        try:
            await self.ensure_seeded()
            chunks = await self._store.list_chunks(document_id)
            if not chunks:
                return {"deleted": 0, "guarded": False, "found": False}
            src = chunks[0].source
            # A seed pseudo-document_id is "seed:<source>"; the source itself also
            # identifies a guarded built-in corpus.
            is_seed = src in SEED_SOURCES or document_id.startswith("seed:")
            if is_seed and not force:
                return {"deleted": 0, "guarded": True, "found": True}
            removed = await self._store.delete_document(document_id)
            return {"deleted": removed, "guarded": False, "found": True}
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG delete_document(%s) failed: %s", document_id, exc)
            return {"deleted": 0, "guarded": False, "found": False}

    async def rag_stats(self) -> dict[str, Any]:
        """Corpus stats: total chunks, count by source, embedding model + dim, and
        the document count. Never raises."""
        try:
            await self.ensure_seeded()
            stats = await self._store.stats()
            docs = await self._store.list_documents()
            stats["document_count"] = len(docs)
            return stats
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG rag_stats failed: %s", exc)
            return {
                "total_chunks": 0,
                "by_source": {},
                "embedding_model": "",
                "dim": 0,
                "document_count": 0,
            }

    async def retrieve(self, query: str, top_k: int | None = None) -> list[RagChunk]:
        """Return the top-k most relevant chunks for ``query``. Never raises.

        Hybrid (MemPalace-inspired): the vector search is the FLOOR — survivors that
        clear ``min_score`` (on the raw vector score) are re-ranked by a convex blend
        of vector similarity and a dependency-free BM25 lexical score, which recovers
        exact-token matches (IPs, hashes, rule names) that embed as noise. With
        ``rag.hybrid`` off this is byte-for-byte the prior vector-only behaviour.

        On an embedding-space mismatch (model/dim changed) the store is CLEARED +
        reseeded once, then the query is retried — vectors are never truncated."""
        cfg = self._prefs.rag
        if not cfg.enabled:
            return []
        try:
            if await self._store.count() == 0:
                return []
            k = top_k or cfg.top_k
            # Over-fetch a candidate pool for hybrid re-ranking; identical to ``k``
            # when hybrid is disabled.
            pool_k = max(k * cfg.hybrid_overfetch, k) if cfg.hybrid else k
            vectors = await self._gateway.embed(
                [query], self._prefs.model_for("embedding"), surface="rag"
            )
            if not vectors:
                return []
            try:
                results = await self._store.search(vectors[0], pool_k)
            except EmbeddingSpaceMismatch as exc:
                logger.warning("Embedding-space mismatch (%s); clearing + reseeding", exc)
                await self._reseed()
                if await self._store.count() == 0:
                    return []
                results = await self._store.search(vectors[0], pool_k)
            # min_score gates on the RAW vector score (so disabling hybrid, or a
            # too-strict threshold, behaves exactly as before).
            survivors = [(c, float(s)) for c, s in results if float(s) >= cfg.min_score]
            if not survivors:
                return []
            if cfg.hybrid and len(survivors) > 1:
                ranked = _hybrid_rerank(query, survivors, cfg.vector_weight, cfg.bm25_weight)
            else:
                ranked = survivors
            return [
                RagChunk(
                    text=chunk.text,
                    source=chunk.source,
                    score=float(score),
                    metadata=dict(chunk.metadata),
                )
                for chunk, score in ranked[:k]
            ]
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG retrieve failed for query %r: %s", query, exc)
            return []

    async def _reseed(self) -> None:
        """Clear the store and re-run seeding (used after an embedding-space change)."""
        await self._store.clear()
        self._seeded = False
        await self.ensure_seeded()


# --------------------------------------------------------------------------- #
# Hybrid re-ranking (dependency-free BM25 over the vector candidate pool).
# --------------------------------------------------------------------------- #
# Tokens keep '.', '-', '_' so IPs/hashes/domains/rule-names stay whole, but split
# on ':' so an "ip:1.2.3.4" label/value (or host:port) yields a matchable bare value.
_TOKEN_RE = re.compile(r"[a-z0-9][a-z0-9._-]*")


def _tokenize(text: str) -> list[str]:
    return [t for t in _TOKEN_RE.findall(text.lower()) if len(t) >= 2]


def _minmax(values: list[float]) -> list[float]:
    if not values:
        return []
    lo, hi = min(values), max(values)
    if hi - lo < 1e-12:
        return [1.0 for _ in values]  # all equal → don't zero them out
    return [(v - lo) / (hi - lo) for v in values]


def _hybrid_rerank(
    query: str,
    survivors: list[tuple[Any, float]],
    vector_weight: float,
    bm25_weight: float,
    *,
    k1: float = 1.5,
    b: float = 0.75,
) -> list[tuple[Any, float]]:
    """Re-rank a vector candidate pool by ``vw*vector_norm + bw*bm25_norm``.

    BM25 (Okapi) is computed corpus-relative over the candidate pool only — the
    chunk text plus its metadata (so an exact IOC/case-id token in metadata counts).
    Both score families are min-max normalised before blending so the weights mean
    what they say. Returns (chunk, combined_score) sorted descending."""
    q_tokens = set(_tokenize(query))
    docs = [_tokenize(f"{c.text} {c.source} {c.metadata}") for c, _ in survivors]
    n = len(docs)
    avgdl = sum(len(d) for d in docs) / n if n else 0.0
    df: dict[str, int] = {}
    for d in docs:
        for tok in set(d):
            if tok in q_tokens:
                df[tok] = df.get(tok, 0) + 1

    bm25_scores: list[float] = []
    for d in docs:
        dl = len(d)
        score = 0.0
        if dl and q_tokens:
            counts: dict[str, int] = {}
            for tok in d:
                if tok in q_tokens:
                    counts[tok] = counts.get(tok, 0) + 1
            for tok, f in counts.items():
                idf = math.log(1 + (n - df[tok] + 0.5) / (df[tok] + 0.5))
                denom = f + k1 * (1 - b + b * (dl / avgdl if avgdl else 1.0))
                score += idf * (f * (k1 + 1)) / denom if denom else 0.0
        bm25_scores.append(score)

    vec_norm = _minmax([v for _, v in survivors])
    bm25_norm = _minmax(bm25_scores)
    combined = [
        (survivors[i][0], vector_weight * vec_norm[i] + bm25_weight * bm25_norm[i])
        for i in range(n)
    ]
    combined.sort(key=lambda t: t[1], reverse=True)
    return combined


class RagTool(Tool):
    name = "rag_retrieve"
    description = (
        "Retrieve relevant SOC knowledge — runbooks, MITRE ATT&CK techniques and "
        "suppression guidance — for an investigation query. Returns the most "
        "similar knowledge-base snippets to ground the analysis."
    )
    input_schema = {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "what to look up"},
            "top_k": {"type": "integer", "description": "max snippets to return"},
        },
        "required": ["query"],
        "additionalProperties": False,
    }

    def __init__(self, rag: RagService) -> None:
        self._rag = rag

    async def run(self, query: str = "", top_k: int | None = None, **kwargs: Any) -> ToolResult:
        await self._rag.ensure_seeded()
        chunks = await self._rag.retrieve(query, top_k=top_k)
        if chunks:
            sources = ", ".join(sorted({c.source for c in chunks}))
            summary = f"Retrieved {len(chunks)} knowledge snippet(s) ({sources})."
        else:
            summary = "No relevant knowledge found."
        return ToolResult(
            ok=True,
            summary=summary,
            data=[chunk.model_dump() for chunk in chunks],
            query=query,
            meta={"count": len(chunks)},
        )
