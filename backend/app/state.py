"""Application state — the dependency-injection hub and lifecycle owner.

``AppState.create`` builds every component; in production it wires the real ES
client + real LLM gateway, and in tests it accepts an injected ES client and
provider overrides so the entire app runs in-process with no network.

``_wire`` is the single place all ES-derived components are (re)constructed, so a
wizard-driven credential change can re-point the whole graph at a fresh ES client
without a restart.
"""

from __future__ import annotations

import logging

from .agents.chat import ChatEngine
from .agents.overview import OverviewService
from .agents.pipeline import InvestigationPipeline
from .agents.standup import StandupService
from .audit.audit_log import AuditLogger
from .cache import Cache
from .config import Preferences, Secrets
from .engine.poller import Poller
from .es.base import BaseESClient
from .es.indices import bootstrap_indices
from .llm.gateway import LLMGateway
from .llm.providers import BaseProvider
from .stores.cases import CaseStore
from .stores.config_store import ConfigStore
from .stores.cursor_store import CursorStore
from .stores.usage import UsageStore
from .tools.rag import RagService

logger = logging.getLogger("tlsoc.state")

_ES_SECRET_FIELDS = {"es_api_key", "es_mgmt_api_key", "es_url", "es_ca_cert", "es_verify_certs"}


class AppState:
    def __init__(
        self,
        secrets: Secrets,
        es: BaseESClient,
        provider_overrides: dict[str, BaseProvider] | None = None,
    ) -> None:
        self.secrets = secrets
        self.es = es
        self.prefs = Preferences()
        self.cache = Cache(secrets.redis_url)
        self._provider_overrides = provider_overrides
        self._wire()

    def _wire(self) -> None:
        es = self.es
        self.usage_store = UsageStore(es)
        self.audit = AuditLogger(es)
        self.cases = CaseStore(es)
        self.cursor_store = CursorStore(es)
        self.config_store = ConfigStore(es)
        self.gateway = LLMGateway(self.secrets, self.usage_store, self._provider_overrides)
        self.rag = self._build_rag()
        # The agent's read-only log surface as a connector (source-agnostic). The
        # poller, the es_query tool (via pipeline/chat) read through this. Behaviour
        # is identical to the legacy direct-ES path; swapping the primary source
        # type later re-points the whole graph here.
        self.log_source = self._build_log_source()
        self.pipeline = InvestigationPipeline(
            es, self.secrets, self.cache, self.gateway, self.rag, self.cases, self.audit,
            source=self.log_source,
        )
        self.chat_engine = ChatEngine(
            es, self.gateway, self.audit, self.cases, self.rag, source=self.log_source
        )
        self.standup_service = StandupService(es, self.gateway, self.audit)
        self.overview_service = OverviewService(self.gateway, self.secrets, self.cache, self.audit)
        self.poller = Poller(
            es, self.cases, self.cursor_store, self.audit, self.pipeline, self.get_prefs,
            source=self.log_source,
        )

    def _build_log_source(self):
        """Construct the primary pull connector for the agent's log surface.

        Both Elasticsearch and OpenSearch wrap the same scoped read-only ES client
        with identical read behaviour; the choice only affects provenance/query
        language. Defaults to Elasticsearch when no source is configured yet."""
        from .connectors.elastic import ElasticConnector
        from .connectors.opensearch import OpenSearchConnector
        from .constants import SourceType

        primary = self.prefs.primary_source()
        if primary is not None and primary.source_type == SourceType.OPENSEARCH:
            return OpenSearchConnector(self.es, connector_id=primary.id)
        connector_id = primary.id if primary is not None else None
        return ElasticConnector(self.es, connector_id=connector_id)

    def _build_rag(self) -> RagService:
        """Construct the RAG service, wiring the CaseStore (resolved-case memory)
        and selecting a persistent ES vector store ONLY when a real management ES
        client is present. Offline/fake ES (no kNN) uses the in-memory store."""
        store = None
        try:
            from .es.client import RealESClient
            from .tools.vectorstore import ESVectorStore

            if isinstance(self.es, RealESClient) and getattr(self.es, "_mgmt", None) is not None:
                store = ESVectorStore(self.es)
                logger.info("RAG using persistent ES vector store (tlsoc-agent-rag)")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not select ES vector store (%s); using in-memory", exc)
        return RagService(self.gateway, self.prefs, store=store, cases=self.cases)

    def rebuild_log_source(self) -> None:
        """Re-point the agent's log surface after the configured sources change.

        Rebuilds the primary connector from ``self.prefs`` and updates the live
        components that hold it (poller, pipeline, chat), so a wizard-driven source
        change takes effect without a restart. (Elastic/OpenSearch wrap the same
        scoped ES client, so this is behaviour-identical for those two.)"""
        self.log_source = self._build_log_source()
        self.poller._source = self.log_source
        self.pipeline._source = self.log_source
        self.chat_engine._source = self.log_source

    def get_prefs(self) -> Preferences:
        return self.prefs

    @classmethod
    def create(
        cls,
        secrets: Secrets | None = None,
        es: BaseESClient | None = None,
        provider_overrides: dict[str, BaseProvider] | None = None,
    ) -> "AppState":
        secrets = secrets or Secrets()
        if es is None:
            es = _build_es_client(secrets)
        return cls(secrets, es, provider_overrides)

    async def startup(self, *, start_poller: bool = True) -> None:
        await self.cache.connect()
        try:
            await bootstrap_indices(self.es)
        except Exception as exc:  # noqa: BLE001
            logger.error("Index bootstrap failed (%s); continuing", exc)
        self.prefs = await self.config_store.load()
        # First-run seeding of the built-in rule catalog (C3-1): idempotent and
        # guarded by rule_catalog_seed_version so operator edits are never clobbered.
        self.prefs = await self.config_store.seed_rule_catalog(self.prefs)
        self.rag = self._build_rag()
        self.pipeline._rag = self.rag
        self.chat_engine._rag = self.rag
        if start_poller:
            self.poller.start()
        logger.info(
            "AppState started (es=%s, setup_complete=%s, polling_enabled=%s)",
            type(self.es).__name__, self.prefs.setup_complete, self.prefs.polling_enabled,
        )

    async def reload_prefs(self) -> Preferences:
        self.prefs = await self.config_store.load()
        return self.prefs

    async def update_prefs(self, prefs: Preferences) -> Preferences:
        await self.config_store.save(prefs)
        self.prefs = prefs
        # Keep the long-lived RagService pointed at the latest prefs so a settings
        # change (rag.enabled / use_resolved_cases / min_score / top_k) is live.
        self.rag.set_prefs(prefs)
        return prefs

    async def apply_secrets(self, updates: dict[str, str | bool | None]) -> None:
        """Wizard-driven runtime secret update (kept in memory only).

        LLM/enrichment keys take effect immediately (the gateway/enrich tools read
        ``self.secrets`` live). If any ES credential changed, rebuild the ES client
        and re-wire all components, then re-bootstrap indices.
        """
        es_changed = False
        for key, value in updates.items():
            if not hasattr(self.secrets, key):
                continue
            setattr(self.secrets, key, value)
            if key in _ES_SECRET_FIELDS:
                es_changed = True
        # Force the gateway to rebuild provider clients with the new keys.
        self.gateway.reset_providers()
        if es_changed:
            await self.poller.stop()
            try:
                await self.es.close()
            except Exception:  # noqa: BLE001
                pass
            self.es = _build_es_client(self.secrets)
            self._wire()
            try:
                await bootstrap_indices(self.es)
            except Exception as exc:  # noqa: BLE001
                logger.error("Re-bootstrap after credential change failed: %s", exc)
            self.prefs = await self.config_store.load()
            if self.prefs.setup_complete:
                self.poller.start()

    async def shutdown(self) -> None:
        try:
            await self.poller.stop()
        except Exception:  # noqa: BLE001
            pass
        await self.gateway.aclose()
        await self.cache.aclose()
        try:
            await self.es.close()
        except Exception:  # noqa: BLE001
            pass


def _build_es_client(secrets: Secrets) -> BaseESClient:
    use_real = secrets.es_store_enabled and bool(secrets.es_mgmt_api_key or secrets.es_api_key)
    if use_real:
        try:
            from .es.client import RealESClient

            return RealESClient(secrets)
        except Exception as exc:  # noqa: BLE001
            logger.error("Could not build real ES client (%s); using in-memory store", exc)
    else:
        logger.warning(
            "No ES key configured (or es_store_enabled=false); using IN-MEMORY store. "
            "Data will NOT persist. Set ES_MGMT_API_KEY for a real deployment."
        )
    from .es.fake import InMemoryESClient

    return InMemoryESClient()
