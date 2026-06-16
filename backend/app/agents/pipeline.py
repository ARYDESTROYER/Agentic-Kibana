"""Investigation pipeline — the shared spine used by every surface.

One code path produces a case from a cluster: enrich → deterministic risk →
cheap-router triage → (benign shortcut | strong investigator) → deterministic
Case Manager decision → persist + audit. Surfaces 2 (investigate), 3 (automated
scan) and the poller all call this, guaranteeing identical, auditable behaviour.

It NEVER raises: any failure yields a NEEDS_HUMAN case (Section 6.7).
"""

from __future__ import annotations

import logging

from ..audit.audit_log import AuditLogger
from ..cache import Cache
from ..config import Preferences, Secrets
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
from .common import entity_kql
from .formatter import Formatter
from .graph import run_investigation
from .investigator import Investigator
from .router import Router

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
    ) -> None:
        self._es = es
        self._secrets = secrets
        self._cache = cache
        self._gateway = gateway
        self._rag = rag_service
        self._cases = cases
        self._audit = audit
        self._router = Router(gateway, audit)

    def _build_investigator(self, prefs: Preferences) -> tuple[Investigator, EnrichTool]:
        enrich = EnrichTool(self._secrets, prefs, self._cache)
        registry = ToolRegistry([
            EsQueryTool(self._es, prefs),
            enrich,
            RagTool(self._rag),
        ])
        formatter = Formatter(self._gateway, self._audit)
        investigator = Investigator(self._gateway, registry, self._audit, formatter)
        return investigator, enrich

    async def investigate_cluster(
        self, cluster: Cluster, source_surface: SourceSurface, prefs: Preferences
    ) -> Case:
        case_id = new_id("case-")
        existing: Case | None = None
        try:
            existing = await self._cases.find_open_by_signature(cluster.signature)
            if existing:
                case_id = existing.case_id

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

            if budget.kill_switch:
                verdict = VerdictResult(
                    verdict=Verdict.NEEDS_HUMAN,
                    recommended_action="Kill switch engaged; investigation skipped.",
                    reproduce_query=entity_kql(cluster, prefs),
                )
            else:
                # LangGraph flow: triage -> (benign shortcut | strong investigator).
                verdict, flow_cost = await run_investigation(
                    self._router, investigator, self._rag, cluster, enrichment,
                    prefs, budget, source_surface.value, case_id,
                )
                cost += flow_cost

            case = self._assemble_case(case_id, cluster, verdict, source_surface, existing, cost, prefs)
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
        case = Case(
            case_id=case_id,
            cluster_signature=cluster.signature,
            created_at=existing.created_at if existing else iso_now(),
            updated_at=iso_now(),
            source_surface=source_surface,
            rule_ids=cluster.rule_values,
            entity=cluster.entity,
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
    ) -> Case:
        member_ids = list(dict.fromkeys(
            (existing.member_event_ids if existing else []) + cluster.member_event_ids
        ))
        created_at = existing.created_at if existing else iso_now()
        history = existing.history if existing else []
        token_cost = (existing.token_cost if existing else 0.0) + cost
        title = f"{cluster.entity.type.value}:{cluster.entity.value} — {', '.join(cluster.rule_values) or 'activity'}"
        return Case(
            case_id=case_id,
            cluster_signature=cluster.signature,
            created_at=created_at,
            updated_at=iso_now(),
            source_surface=source_surface,
            rule_ids=cluster.rule_values,
            entity=cluster.entity,
            member_event_ids=member_ids,
            risk_score=cluster.risk_score,
            risk_breakdown=cluster.risk_breakdown,
            verdict=verdict.verdict,
            confidence=verdict.confidence,
            evidence=verdict.evidence,
            mitre=verdict.mitre,
            recommended_action=verdict.recommended_action,
            reproduce_query=verdict.reproduce_query or entity_kql(cluster, prefs),
            title=truncate(title, 200),
            summary=truncate(verdict.recommended_action, 300),
            token_cost=round(token_cost, 6),
            history=history,
        )


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
        source_surface=source_surface,
        rule_ids=cluster.rule_values,
        entity=cluster.entity,
        member_event_ids=cluster.member_event_ids,
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
    )
