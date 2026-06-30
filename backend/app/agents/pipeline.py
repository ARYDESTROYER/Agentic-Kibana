"""Investigation pipeline — the shared spine used by every surface.

One code path produces a case from a cluster: enrich → deterministic risk →
cheap-router triage → (benign shortcut | strong investigator) → deterministic
Case Manager decision → persist + audit. Surfaces 2 (investigate), 3 (automated
scan) and the poller all call this, guaranteeing identical, auditable behaviour.

It NEVER raises: any failure yields a NEEDS_HUMAN case (Section 6.7).
"""

from __future__ import annotations

import asyncio
import logging
from typing import TYPE_CHECKING

from ..audit.audit_log import AuditLogger
from ..cache import Cache
from ..config import Preferences, Secrets
from ..connectors.base import PullConnector
from ..connectors.elastic import ElasticConnector
from ..constants import ActionType, CaseStatus, DecisionBy, EntityType, SourceSurface, Verdict
from ..engine.case_manager import CaseManager
from ..engine.cost_gate import CaseBudget
from ..engine.risk import compute_risk
from ..es.base import BaseESClient
from ..llm.gateway import LLMGateway
from ..models import Case, Cluster, EnrichmentResult, VerdictResult
from ..stores.cases import CaseStore
from ..tools.base import ToolRegistry
from ..tools.enrich import EnrichTool
from ..tools.es_query import EsQueryTool
from ..tools.rag import RagService, RagTool
from ..utils import iso_now, new_id, truncate
from .common import entity_kql, normalize_kql
from .formatter import Formatter
from .graph import run_investigation
from .investigator import Investigator
from .personas import select_persona
from .router import Router

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..engine.case_id import SequenceStore
    from ..playbooks.registry import PlaybookRegistry
    from ..stores.memory import MemoryStore

logger = logging.getLogger("tlsoc.agents.pipeline")


class InvestigationPipeline:
    def __init__(
        self,
        es: BaseESClient,
        secrets: Secrets,
        cache: Cache,
        gateway: LLMGateway,
        rag_service: RagService,
        cases: CaseStore,
        audit: AuditLogger,
        source: PullConnector | None = None,
        playbooks: "PlaybookRegistry | None" = None,
        memory: "MemoryStore | None" = None,
        seq_store: "SequenceStore | None" = None,
    ) -> None:
        self._es = es
        # The agent's read-only log surface. Defaults to wrapping ``es`` in an
        # ElasticConnector (full back-compat) so a direct construction without a
        # source keeps working; state wiring injects the configured connector.
        self._source = source or ElasticConnector(es)
        self._secrets = secrets
        self._cache = cache
        self._gateway = gateway
        self._rag = rag_service
        self._cases = cases
        self._audit = audit
        self._router = Router(gateway, audit)
        # Markdown playbook registry (deterministic per-cluster selection). None →
        # no playbooks (generic investigator), preserving today's behaviour.
        self._playbooks = playbooks
        # Operator MEMORY store (durable trusted facts auto-injected into every
        # investigation). None → no memory injected (today's behaviour).
        self._memory = memory
        # Case-number sequence store (F7). None → case_number stays "" and the UI
        # falls back to case_id (today's behaviour).
        self._seq_store = seq_store
        # Optional fire-and-forget notification dispatcher (F5 / Wave 4), wired by
        # AppState AFTER construction. None → no notifications (today's behaviour). It
        # is called ONLY after apply()+save and never alters the case decision (#3).
        self.notifier = None
        # Optional threshold-automation executor (F10 / Wave 6), wired by AppState
        # AFTER construction. None → no automation (today's behaviour). It runs ONLY
        # after apply()+save and may ONLY tag/recommend/notify/queue a re-investigation/
        # open a HITL Proposal — it NEVER sets case.status/disposition (#3).
        self.automation = None
        # Optional realtime EventBus for live ``agent.step`` progress frames (Round-3
        # Wave-4). DEFAULT None → resolved lazily from the module singleton so this
        # works with zero integrator wiring (mirrors AppState.event_bus); set
        # explicitly only to inject a test/alternate bus. Publishing is ALWAYS
        # best-effort + fully isolated: it NEVER changes decide()/the ledger and a bus
        # error can never break the pipeline (#3/#11). When realtime is disabled nobody
        # subscribes and publish is a cheap history-only no-op.
        self.event_bus = None

    def _emit_step(
        self, case_id: str, step: str, *, status: str = "running",
        detail: str = "", extra: dict | None = None,
    ) -> None:
        """Publish ONE ``agent.step`` frame to the per-case room (``cases:{case_id}``)
        so the Wave-4 case-detail EventSource can render investigation progress live.

        ADDITIVE + BEST-EFFORT + NON-BLOCKING: this is a pure transport nudge that runs
        ALONGSIDE the deterministic flow — it reads nothing the decision depends on and
        writes nothing onto the case. The decision is produced solely by
        ``case_manager.apply()``; these frames only NARRATE the steps. The whole thing
        is wrapped so a bus error (or a missing bus) can never break the pipeline
        (#3/#11). ``detail`` is a SHORT, already-render-safe label (a persona/playbook
        id, a verdict enum, a status word) — never raw log/AI text (#9; the UI escapes
        it regardless)."""
        try:
            bus = self.event_bus
            if bus is None:
                from ..realtime import get_event_bus

                bus = get_event_bus()
            if bus is None or not case_id:
                return
            payload: dict = {"case_id": case_id, "step": step, "status": status}
            if detail:
                payload["detail"] = truncate(str(detail), 200)
            if extra:
                payload.update(extra)
            bus.publish(f"cases:{case_id}", "agent.step", payload)
        except Exception as exc:  # noqa: BLE001 — realtime is advisory; never break the flow
            logger.debug("agent.step publish skipped for %s: %s", case_id, exc)

    def _build_investigator(self, prefs: Preferences) -> tuple[Investigator, EnrichTool]:
        enrich = EnrichTool(self._secrets, prefs, self._cache)
        registry = ToolRegistry([
            EsQueryTool(self._source, prefs),
            enrich,
            RagTool(self._rag),
        ])
        formatter = Formatter(self._gateway, self._audit)
        investigator = Investigator(self._gateway, registry, self._audit, formatter)
        return investigator, enrich

    def _maybe_notify(self, case: Case) -> None:
        """Schedule a fire-and-forget notification for a freshly-saved case (#3-safe).

        Detached via ``asyncio.create_task`` so it never blocks/awaits in the case
        path; ``NotificationService.notify`` swallows every error. A no-op when no
        notifier is wired / notifications are disabled. NEVER raises."""
        notifier = getattr(self, "notifier", None)
        if notifier is None:
            return
        try:
            import asyncio

            asyncio.create_task(notifier.notify(case, save=self._cases.save))
        except Exception as exc:  # noqa: BLE001 — must never affect the case flow
            logger.debug("notification scheduling skipped: %s", exc)

    async def _maybe_automate(self, case: Case, prefs: Preferences) -> None:
        """Run post-decision threshold automation for a freshly-saved case (#3-safe).

        A no-op when no automation executor is wired / automation is disabled. The
        executor itself is error-isolated; this wrapper double-guards so a failure can
        NEVER break the case path. It NEVER sets case.status/disposition."""
        automation = getattr(self, "automation", None)
        if automation is None:
            return
        try:
            await automation.run(case, prefs, save=self._cases.save)
        except Exception as exc:  # noqa: BLE001 — automation must never affect the case flow
            logger.warning("threshold automation skipped for %s: %s", case.case_id, exc)

    async def _maybe_index_resolved(self, case: Case) -> None:
        """Best-effort: index a terminal (closed/resolved) case into the RAG corpus
        as institutional memory (F11). OUTSIDE the decision logic — a failure never
        blocks/raises. The RagService method is itself gated + fail-safe."""
        try:
            from ..constants import TERMINAL_CASE_STATUSES

            if case.status and case.status.value in TERMINAL_CASE_STATUSES:
                await self._rag.index_resolved_case(case)
        except Exception as exc:  # noqa: BLE001 — knowledge loop is best-effort
            logger.debug("resolved-case indexing skipped for %s: %s", case.case_id, exc)

    async def _allocate_case_number(
        self, existing: Case | None, cluster: Cluster, prefs: Preferences
    ) -> str:
        """Render a human-facing display id (F7) for a NEW case, preserving an
        existing case's number on re-investigation. Returns "" when the feature is
        disabled / no sequence store is wired (the UI then falls back to case_id).
        Never raises — a numbering glitch must never break case creation."""
        if existing is not None and existing.case_number:
            return existing.case_number
        fmt = getattr(prefs, "case_id_format", None)
        if not fmt or not getattr(fmt, "enabled", False) or self._seq_store is None:
            return ""
        try:
            from ..engine.case_id import render, reset_bucket

            bucket = reset_bucket(fmt.reset_period)
            seq = await self._seq_store.next(fmt.prefix, bucket, start=fmt.seq_start)
            return render(fmt.template, {
                "seq": seq,
                "prefix": fmt.prefix,
                "source": cluster.source_name or "",
            })
        except Exception as exc:  # noqa: BLE001 — numbering must never break creation
            logger.warning("Case-number allocation failed (%s); falling back to case_id", exc)
            return ""

    async def investigate_cluster(
        self,
        cluster: Cluster,
        source_surface: SourceSurface,
        prefs: Preferences,
        *,
        force: bool = False,
        force_playbook_id: str | None = None,
    ) -> Case:
        case_id = new_id("case-")
        existing: Case | None = None
        try:
            existing = await self._cases.find_open_by_signature(cluster.signature)
            if existing:
                case_id = existing.case_id

            # --- P1: case/verdict stability ---
            # An already-investigated OPEN case (verdict is not None) with NO material
            # change (no new member event ids) and no explicit force must be returned
            # UNCHANGED — no LLM calls — to stop poll/attach-driven verdict drift.
            # Re-investigate only when force=True, the case is an un-investigated
            # candidate (verdict is None), or new events were added.
            if existing and existing.verdict is not None and not force:
                new_ids = set(cluster.member_event_ids) - set(existing.member_event_ids)
                if not new_ids:
                    await self._audit.record(
                        action_type=ActionType.DECISION, surface=source_surface.value,
                        actor="pipeline", case_id=case_id,
                        result_summary=(
                            "no material change; returning existing case unchanged "
                            f"(verdict={existing.verdict.value})"
                        ),
                    )
                    return existing

            # Live progress: the investigation has begun (router/triage stage). Pure
            # narration — best-effort, never gates the flow (#3/#11).
            self._emit_step(case_id, "router", status="running",
                            detail="triage starting")

            investigator, enrich = self._build_investigator(prefs)

            # --- enrichment + deterministic risk ---
            enrichment: EnrichmentResult | None = None
            reputation = 0.0
            if cluster.entity.type == EntityType.IP and prefs.enrichment.enabled:
                enrichment = await enrich.enrich_ip(cluster.entity.value)
                reputation = enrichment.reputation_score
            breakdown = compute_risk(cluster, prefs, reputation)
            cluster.risk_score = breakdown.total
            cluster.risk_breakdown = breakdown

            budget = CaseBudget(prefs.caps)
            cost = 0.0

            # Multi-agent roster + Markdown playbooks (Vigil-inspired): both are
            # selected deterministically from the cluster. The persona specialises
            # the investigator; the matched playbook is injected as TRUSTED operator
            # procedure (it can only RECOMMEND — code/settings decide close/escalate).
            persona = select_persona(cluster, prefs)
            playbook = None
            playbook_reason = "playbooks_disabled"
            if force_playbook_id and self._playbooks is not None:
                # Manual "run a playbook" (F10): the operator FORCES a specific
                # playbook as the injected TRUSTED procedure. This is CONTEXT-ONLY —
                # the playbook can still only RECOMMEND; the deterministic policy
                # decides close/escalate exactly as for an auto-selected playbook (#3).
                forced = self._playbooks.get(force_playbook_id)
                if forced is not None:
                    playbook = forced
                    playbook_reason = f"forced:{force_playbook_id}"
                else:
                    playbook_reason = f"forced_missing:{force_playbook_id}"
            elif prefs.playbooks.enabled and self._playbooks is not None:
                playbook, playbook_reason = self._playbooks.select(cluster)
            await self._audit.record(
                action_type=ActionType.DECISION, surface=source_surface.value,
                actor="playbook_selector", case_id=case_id,
                result_summary=(
                    f"playbook={f'{playbook.id} v{playbook.version}' if playbook else 'none'} "
                    f"persona={persona.id} reason={playbook_reason}"
                ),
            )
            # Live progress: the specialist persona + playbook are selected.
            self._emit_step(
                case_id, "persona", status="running", detail=persona.id,
                extra={"playbook_id": (playbook.id if playbook else "")},
            )

            # Operator MEMORY (durable trusted facts): auto-injected into the strong
            # investigation as a distinct TRUSTED block. Best-effort + bounded; a
            # memory load failure must never break the pipeline (never raises).
            memory_entries = []
            if self._memory is not None:
                try:
                    memory_entries = await self._memory.list(active_only=True)
                except Exception as exc:  # noqa: BLE001 — memory is advisory only
                    logger.warning("Loading operator memory failed (%s); continuing", exc)
                    memory_entries = []

            if budget.kill_switch:
                verdict = VerdictResult(
                    verdict=Verdict.NEEDS_HUMAN,
                    recommended_action="Kill switch engaged; investigation skipped.",
                    reproduce_query=entity_kql(cluster, prefs),
                )
            else:
                # Live progress: handing off to the tool-using investigation graph.
                self._emit_step(case_id, "tools", status="running",
                                detail="investigation running")
                # LangGraph flow: triage -> (benign shortcut | strong investigator).
                # Enforce caps.timeout_seconds (Section 6.3 #4): a runaway / slow
                # investigation is capped to a NEEDS_HUMAN verdict, never left to spin.
                try:
                    verdict, flow_cost = await asyncio.wait_for(
                        run_investigation(
                            self._router, investigator, self._rag, cluster, enrichment,
                            prefs, budget, source_surface.value, case_id,
                            persona=persona, playbook=playbook, memory=memory_entries,
                        ),
                        timeout=prefs.caps.timeout_seconds,
                    )
                    cost += flow_cost
                except asyncio.TimeoutError:
                    logger.warning(
                        "Investigation for %s exceeded caps.timeout_seconds=%ss; capping to human",
                        cluster.signature, prefs.caps.timeout_seconds,
                    )
                    await self._audit.record(
                        action_type=ActionType.ERROR, surface=source_surface.value,
                        actor="pipeline", case_id=case_id,
                        result_summary=(
                            f"investigation timed out after {prefs.caps.timeout_seconds}s; "
                            "capped to NEEDS_HUMAN"
                        ),
                    )
                    verdict = VerdictResult(
                        verdict=Verdict.NEEDS_HUMAN,
                        recommended_action=(
                            f"Investigation exceeded the {prefs.caps.timeout_seconds}s time "
                            "cap; manual review required."
                        ),
                        reproduce_query=entity_kql(cluster, prefs),
                    )

            # Live progress: a verdict exists (from the kill-switch, the timeout cap,
            # or the investigation graph). The DETERMINISTIC close/escalate decision
            # has NOT been made yet — that is the next step.
            self._emit_step(case_id, "verdict", status="running",
                            detail=verdict.verdict.value)

            case_number = await self._allocate_case_number(existing, cluster, prefs)
            case = self._assemble_case(
                case_id, cluster, verdict, source_surface, existing, cost, prefs,
                persona_id=persona.id, playbook_id=(playbook.id if playbook else ""),
                case_number=case_number,
            )
            CaseManager(prefs).apply(case)
            await self._cases.save(case)
            await self._audit.record(
                action_type=ActionType.DECISION, surface=source_surface.value,
                actor="case_manager", case_id=case_id,
                result_summary=(
                    f"verdict={verdict.verdict.value} status={case.status.value} "
                    f"decision_by={case.decision_by.value if case.decision_by else None} "
                    f"risk={case.risk_score} cost={round(cost, 6)}"
                ),
            )
            # Live progress: TERMINAL ``decision`` frame, emitted AFTER apply()+save +
            # the audit record so it only REPORTS the already-decided, already-persisted
            # case — it never feeds the deterministic decision (#3). This is the last
            # agent.step a subscriber sees for this run.
            self._emit_step(
                case_id, "decision", status="done", detail=case.status.value,
                extra={
                    "verdict": verdict.verdict.value,
                    "decision_by": (case.decision_by.value if case.decision_by else None),
                },
            )
            # Threshold automation (F10) runs AFTER the deterministic decision + save
            # (#3). It may ONLY tag/recommend/notify/queue a re-investigation (which
            # itself re-runs decide()) / open a HITL Proposal — never set status or
            # close. Fully error-isolated: a failure can never break the case path.
            await self._maybe_automate(case, prefs)
            # Reusable-knowledge loop (F11): if this case is terminal (closed/resolved),
            # index it as a resolved_case RAG chunk so future investigations learn from
            # it. Best-effort, OUTSIDE the decision logic — never blocks/raises.
            await self._maybe_index_resolved(case)
            # Fire-and-forget outbound notifications AFTER the deterministic decision +
            # save (#3). A send (or failure) can never block, delay, or alter the case
            # — create_task detaches it and notify() swallows all errors internally.
            self._maybe_notify(case)
            return case
        except Exception as exc:  # noqa: BLE001 — never drop an alert
            logger.exception("Pipeline failed for cluster %s; failing to human", cluster.signature)
            case = _fail_to_human_case(case_id, cluster, source_surface, str(exc), existing, prefs)
            try:
                await self._cases.save(case)
            except Exception:  # noqa: BLE001
                logger.error("Could not persist fail-to-human case %s", case_id)
            await self._audit.record(
                action_type=ActionType.ERROR, surface=source_surface.value,
                actor="pipeline", case_id=case_id, result_summary=f"pipeline error: {exc}",
            )
            return case

    async def register_candidate(
        self, cluster: Cluster, source_surface: SourceSurface, prefs: Preferences
    ) -> Case:
        """Create/refresh an OPEN candidate case with NO LLM cost (deterministic
        risk only). Every correlated cluster becomes a visible case so nothing is
        ever dropped; auto-forwarded clusters are investigated separately."""
        existing = await self._cases.find_open_by_signature(cluster.signature)
        case_id = existing.case_id if existing else new_id("case-")
        breakdown = compute_risk(cluster, prefs, 0.0)
        cluster.risk_score = breakdown.total
        cluster.risk_breakdown = breakdown
        member_ids = list(dict.fromkeys(
            (existing.member_event_ids if existing else []) + cluster.member_event_ids
        ))
        case_number = await self._allocate_case_number(existing, cluster, prefs)
        case = Case(
            case_id=case_id,
            case_number=case_number,
            cluster_signature=cluster.signature,
            created_at=existing.created_at if existing else iso_now(),
            updated_at=iso_now(),
            source_surface=_preserved_surface(existing, source_surface),
            origin_surface=_origin_surface(existing, source_surface),
            rule_ids=_merge_rules(existing, cluster),
            entity=cluster.entity,
            source_id=_source_id(existing, cluster),
            source_name=_source_name(existing, cluster),
            member_event_ids=member_ids,
            risk_score=cluster.risk_score,
            risk_breakdown=cluster.risk_breakdown,
            verdict=None,
            status=CaseStatus.OPEN,
            title=truncate(
                f"{cluster.entity.type.value}:{cluster.entity.value} — "
                f"{', '.join(cluster.rule_values) or 'activity'}", 200),
            summary="Candidate cluster awaiting investigation.",
            history=(existing.history if existing else []),
            verdict_history=(existing.verdict_history if existing else []),
            trigger_reason=_trigger(existing, cluster),
        )
        await self._cases.save(case)
        await self._audit.record(
            action_type=ActionType.POLL, surface=source_surface.value, actor="poller",
            case_id=case_id,
            result_summary=f"registered candidate risk={case.risk_score} rules={cluster.rule_values}",
        )
        return case

    def _assemble_case(
        self,
        case_id: str,
        cluster: Cluster,
        verdict: VerdictResult,
        source_surface: SourceSurface,
        existing: Case | None,
        cost: float,
        prefs: Preferences,
        persona_id: str = "",
        playbook_id: str = "",
        case_number: str = "",
    ) -> Case:
        member_ids = list(dict.fromkeys(
            (existing.member_event_ids if existing else []) + cluster.member_event_ids
        ))
        created_at = existing.created_at if existing else iso_now()
        history = existing.history if existing else []
        token_cost = (existing.token_cost if existing else 0.0) + cost
        title = f"{cluster.entity.type.value}:{cluster.entity.value} — {', '.join(cluster.rule_values) or 'activity'}"
        # P1 provenance: keep the original creating surface; never overwrite it with
        # the current call's surface (so an automated_scan case stays in the
        # Automated Scans tab after a manual investigate).
        surface = _preserved_surface(existing, source_surface)
        origin = _origin_surface(existing, source_surface)
        # P1: append to the verdict trail on each (re)investigation.
        verdict_history = list(existing.verdict_history) if existing else []
        verdict_history.append({
            "ts": iso_now(),
            "verdict": verdict.verdict.value,
            "confidence": verdict.confidence,
            "risk_score": cluster.risk_score,
        })
        # Normalise the reproduce query UNCONDITIONALLY so it always uses the
        # configured field syntax (e.g. `source.ip : "x"`), never a bare `ip:x` —
        # covers BOTH the router/benign path and the LLM/formatter path. The
        # entity_kql fallback is already correct; normalize_kql is idempotent on it.
        raw_reproduce = verdict.reproduce_query or entity_kql(cluster, prefs)
        reproduce_query = normalize_kql(raw_reproduce, prefs)
        return Case(
            case_id=case_id,
            case_number=(existing.case_number if existing and existing.case_number else case_number),
            cluster_signature=cluster.signature,
            created_at=created_at,
            updated_at=iso_now(),
            source_surface=surface,
            origin_surface=origin,
            rule_ids=_merge_rules(existing, cluster),
            entity=cluster.entity,
            source_id=_source_id(existing, cluster),
            source_name=_source_name(existing, cluster),
            member_event_ids=member_ids,
            risk_score=cluster.risk_score,
            risk_breakdown=cluster.risk_breakdown,
            verdict=verdict.verdict,
            confidence=verdict.confidence,
            evidence=verdict.evidence,
            mitre=verdict.mitre,
            recommended_action=verdict.recommended_action,
            reproduce_query=reproduce_query,
            title=truncate(title, 200),
            summary=truncate(verdict.recommended_action, 300),
            token_cost=round(token_cost, 6),
            history=history,
            verdict_history=verdict_history,
            trigger_reason=_trigger(existing, cluster),
            agent_persona=persona_id or (existing.agent_persona if existing else ""),
            playbook_id=playbook_id or (existing.playbook_id if existing else ""),
        )


def _trigger(existing: Case | None, cluster: Cluster):
    """Keep the cluster's freshly-computed trigger reason, falling back to the
    existing case's (so a manual re-investigate doesn't erase the scan's reason)."""
    return cluster.trigger_reason or (existing.trigger_reason if existing else None)


def _source_id(existing: Case | None, cluster: Cluster) -> str | None:
    """Record the originating source id on the case (multi-source provenance),
    preserving an existing case's value (never erased by a later attach)."""
    return cluster.source_id or (existing.source_id if existing else None)


def _source_name(existing: Case | None, cluster: Cluster) -> str | None:
    return cluster.source_name or (existing.source_name if existing else None)


def _merge_rules(existing: Case | None, cluster: Cluster) -> list[str]:
    """Union previously-recorded rules with the new cluster's rules.

    Rules are deliberately NOT part of the cluster signature (Section 6.2), so a
    newly-seen rule for an already-open entity must ENRICH the case, never replace
    its rule history."""
    prior = set(existing.rule_ids) if existing else set()
    return sorted(prior | set(cluster.rule_values))


def _fail_to_human_case(
    case_id: str,
    cluster: Cluster,
    source_surface: SourceSurface,
    error: str,
    existing: Case | None,
    prefs: Preferences,
) -> Case:
    return Case(
        case_id=case_id,
        cluster_signature=cluster.signature,
        created_at=existing.created_at if existing else iso_now(),
        updated_at=iso_now(),
        source_surface=_preserved_surface(existing, source_surface),
        origin_surface=_origin_surface(existing, source_surface),
        rule_ids=_merge_rules(existing, cluster),
        entity=cluster.entity,
        source_id=_source_id(existing, cluster),
        source_name=_source_name(existing, cluster),
        member_event_ids=list(dict.fromkeys(
            (existing.member_event_ids if existing else []) + cluster.member_event_ids
        )),
        risk_score=cluster.risk_score,
        risk_breakdown=cluster.risk_breakdown,
        verdict=Verdict.NEEDS_HUMAN,
        confidence=0.0,
        recommended_action="Automated investigation failed; manual review required.",
        reproduce_query=entity_kql(cluster, prefs),
        status=CaseStatus.NEEDS_HUMAN,
        decision_by=DecisionBy.SYSTEM,
        title=f"[FAILED] {cluster.entity.type.value}:{cluster.entity.value}",
        error=truncate(error, 500),
        history=(existing.history if existing else []),
        verdict_history=(existing.verdict_history if existing else []),
        trigger_reason=_trigger(existing, cluster),
    )


def _preserved_surface(existing: Case | None, source_surface: SourceSurface) -> SourceSurface:
    """Keep the original creating surface (P1 provenance). For an existing case we
    NEVER overwrite ``source_surface`` with the current call's surface, so e.g. an
    automated_scan case stays in the Automated Scans tab after a manual investigate."""
    return existing.source_surface if existing else source_surface


def _origin_surface(existing: Case | None, source_surface: SourceSurface) -> SourceSurface:
    """The FIRST surface this case ever had. Stable across (re)investigations."""
    if existing:
        return existing.origin_surface or existing.source_surface
    return source_surface
