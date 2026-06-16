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

import logging
from typing import TYPE_CHECKING, Any

from ..config import Preferences
from ..constants import CaseStatus
from ..llm.gateway import LLMGateway
from ..models import RagChunk
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
            seeds.extend(SEED_RUNBOOKS)
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

    async def retrieve(self, query: str, top_k: int | None = None) -> list[RagChunk]:
        """Return the top-k most relevant chunks for ``query``. Never raises.

        Drops chunks scoring below ``prefs.rag.min_score``. On an embedding-space
        mismatch (model/dim changed) the store is CLEARED + reseeded once, then
        the query is retried — vectors are never truncated to force a match."""
        cfg = self._prefs.rag
        if not cfg.enabled:
            return []
        try:
            if await self._store.count() == 0:
                return []
            k = top_k or cfg.top_k
            vectors = await self._gateway.embed(
                [query], self._prefs.model_for("embedding"), surface="rag"
            )
            if not vectors:
                return []
            try:
                results = await self._store.search(vectors[0], k)
            except EmbeddingSpaceMismatch as exc:
                logger.warning("Embedding-space mismatch (%s); clearing + reseeding", exc)
                await self._reseed()
                if await self._store.count() == 0:
                    return []
                results = await self._store.search(vectors[0], k)
            return [
                RagChunk(
                    text=chunk.text,
                    source=chunk.source,
                    score=float(score),
                    metadata=dict(chunk.metadata),
                )
                for chunk, score in results
                if float(score) >= cfg.min_score
            ]
        except Exception as exc:  # noqa: BLE001
            logger.warning("RAG retrieve failed for query %r: %s", query, exc)
            return []

    async def _reseed(self) -> None:
        """Clear the store and re-run seeding (used after an embedding-space change)."""
        await self._store.clear()
        self._seeded = False
        await self.ensure_seeded()


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
