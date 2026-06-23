"""Application state — the dependency-injection hub and lifecycle owner.

``AppState.create`` builds every component; in production it wires the real ES
client + real LLM gateway, and in tests it accepts an injected ES client and
provider overrides so the entire app runs in-process with no network.

``_wire`` is the single place all ES-derived components are (re)constructed, so a
wizard-driven credential change can re-point the whole graph at a fresh ES client
without a restart.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from .agents.chat import ChatEngine
from .agents.overview import OverviewService
from .agents.pipeline import InvestigationPipeline
from .agents.standup import StandupService
from .audit.audit_log import AuditLogger
from .cache import Cache
from .config import Preferences, Secrets
from .engine.ingest import IngestService
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
        self._receivers: list = []
        self._receiver_tasks: list = []
        # Async SQL engine for the SQL state backend (None on the ES backend).
        # Built lazily in _build_state_backend and disposed on shutdown.
        self._sql_engine = None
        # A per-source ES client OWNED by this AppState (built when the primary
        # source carries its own ES connection/TLS overrides); closed on rewire +
        # shutdown. None means the primary uses the shared global client.
        self._owned_log_client = None
        self._wire()

    def _wire(self) -> None:
        es = self.es
        # OWN-state backend (Epoch A): cases/audit/usage/config/cursor live EITHER
        # in Elasticsearch (default) or a SQL database (sqlite/postgres). The
        # agent's read-only LOG surface always stays on the connector layer below.
        self._build_state_backend()
        self.gateway = LLMGateway(self.secrets, self.usage_store, self._provider_overrides)
        # Auth service (Wave 2). Disabled unless secrets.auth_enabled — the no-auth
        # "old version" is the default. Building it is cheap and re-runs on rewire.
        from .auth.service import AuthService

        self.auth = AuthService(
            enabled=self.secrets.auth_enabled,
            jwt_secret=self.secrets.auth_jwt_secret or "",
            token_hours=self.secrets.auth_token_hours,
            users=self.secrets.auth_user_map(),
        )
        # Markdown playbook registry (loaded from disk; deterministic per-cluster
        # selection). Reloaded in startup() once prefs (and any dir override) load.
        self.playbooks = self._build_playbooks()
        # Operator MEMORY store (durable trusted facts). Backed by the SAME KV the
        # config/cursor stores use for the active backend (SQL: SqlKVStore; ES: a
        # thin EsKVStore over the config index) — no new index/table/migration.
        self.memory = self._build_memory()
        self.rag = self._build_rag()
        # The agent's read-only log surface as a connector (source-agnostic). The
        # poller, the es_query tool (via pipeline/chat) read through this. Behaviour
        # is identical to the legacy direct-ES path; swapping the primary source
        # type later re-points the whole graph here.
        self.log_source = self._build_log_source()
        self.pipeline = InvestigationPipeline(
            es, self.secrets, self.cache, self.gateway, self.rag, self.cases, self.audit,
            source=self.log_source, playbooks=self.playbooks, memory=self.memory,
        )
        self.chat_engine = ChatEngine(
            es, self.gateway, self.audit, self.cases, self.rag,
            source=self.log_source, memory=self.memory,
        )
        self.standup_service = StandupService(es, self.gateway, self.audit)
        self.overview_service = OverviewService(self.gateway, self.secrets, self.cache, self.audit)
        self.poller = Poller(
            es, self.cases, self.cursor_store, self.audit, self.pipeline, self.get_prefs,
            source=self.log_source,
        )
        # Shared ingest path for PUSH receivers (webhook/syslog/queues/…): the same
        # correlate → case path the poller uses.
        self.ingest_service = IngestService(self.cases, self.audit, self.pipeline, self.get_prefs)

    def _is_sql_backend(self) -> bool:
        return self.secrets.state_backend in ("sqlite", "postgres")

    def _build_state_backend(self) -> None:
        """Wire the suite's OWN-state stores per ``secrets.state_backend``.

        Default (``elasticsearch``): the ES-backed stores over ``self.es``,
        exactly as before. SQL (``sqlite``/``postgres``): build (or reuse) an
        async SQLAlchemy engine from ``state_db_url`` and wire the Sql* repos.
        Either way the resulting attributes (usage_store/audit/cases/cursor_store/
        config_store) satisfy the same repository interfaces, so every downstream
        caller is unchanged. asyncpg/pgvector are imported lazily, only on the
        postgres path, so this method imports/runs on SQLite with no pg deps."""
        if self._is_sql_backend():
            from .stores.sql import (
                SqlAuditRepository,
                SqlCaseRepository,
                SqlConfigStore,
                SqlCursorStore,
                SqlKVStore,
                SqlUsageRepository,
                build_async_engine,
            )
            from .stores.sql.engine import resolve_db_url

            if self._sql_engine is None:
                url = resolve_db_url(self.secrets.state_backend, self.secrets.state_db_url)
                self._sql_engine = build_async_engine(url)
            engine = self._sql_engine
            kv = SqlKVStore(engine)
            self._kv = kv  # shared KV (also backs the operator MEMORY store)
            self.usage_store = SqlUsageRepository(engine)
            self.audit = SqlAuditRepository(engine)
            self.cases = SqlCaseRepository(engine)
            self.cursor_store = SqlCursorStore(kv)
            self.config_store = SqlConfigStore(kv)
            logger.info("OWN-state backend: SQL (%s)", self.secrets.state_backend)
            return
        es = self.es
        from .stores.memory import EsKVStore

        # ES backend has no generic KV table; a thin adapter over the config index
        # gives the MEMORY store the same get/put contract the SQL backend provides.
        self._kv = EsKVStore(es)
        self.usage_store = UsageStore(es)
        self.audit = AuditLogger(es)
        self.cases = CaseStore(es)
        self.cursor_store = CursorStore(es)
        self.config_store = ConfigStore(es)

    def _playbooks_dir(self) -> Path:
        """Where playbook *.md files live: the override from prefs, else the default
        ``backend/playbooks`` (sibling of the ``app`` package)."""
        override = getattr(self.prefs, "playbooks", None)
        if override is not None and override.dir:
            return Path(override.dir)
        return Path(__file__).resolve().parent.parent / "playbooks"

    def _build_memory(self):
        """Construct the operator MEMORY store over the active backend's KV. The KV
        is set in _build_state_backend, so this always has a valid handle."""
        from .stores.memory import MemoryStore

        return MemoryStore(self._kv)

    def _build_playbooks(self):
        """Construct + load the PlaybookRegistry (never raises; a bad file is
        skipped, an empty/missing dir yields zero playbooks → generic behaviour)."""
        from .playbooks.registry import PlaybookRegistry

        reg = PlaybookRegistry(self._playbooks_dir())
        try:
            summary = reg.reload()
            logger.info(
                "Loaded %d playbook(s); skipped %d",
                summary.get("loaded", 0), len(summary.get("skipped", [])),
            )
        except Exception as exc:  # noqa: BLE001 — registry should never raise; be safe
            logger.warning("Playbook load failed (%s); continuing with none", exc)
        return reg

    def reload_playbooks(self) -> dict:
        """Hot-reload playbooks from disk via the registry's ATOMIC validate-then-swap
        (a wholesale-broken dir keeps the prior good live set). Re-points at the
        configured dir first if it changed. Returns {loaded, skipped, ids}."""
        from .playbooks.registry import PlaybookRegistry

        if str(self.playbooks._directory) != str(self._playbooks_dir()):
            self.playbooks = PlaybookRegistry(self._playbooks_dir())
        summary = self.playbooks.reload()
        self.pipeline._playbooks = self.playbooks
        return summary

    def es_client_for_source(self, src) -> tuple[BaseESClient, bool]:
        """Return (es_client, owned) honoring the source's per-source ES connection +
        TLS settings. `owned=True` means a fresh client the CALLER must close; `False`
        means the shared global `self.es`. Falls back to the shared client when the
        source has no connection overrides or a real client can't be built."""
        merged = {**(src.config or {}), **self.secrets.source_secrets(src.id)}
        overrides = _source_es_overrides(merged)
        if not overrides:
            return self.es, False
        overrides["es_mgmt_api_key"] = None  # never point a global mgmt key at a source URL
        try:
            from .es.client import RealESClient
            return RealESClient(self.secrets.model_copy(update=overrides)), True
        except Exception as exc:  # noqa: BLE001
            logger.warning("per-source ES client build failed (%s); using shared client", exc)
            return self.es, False

    def _set_owned_log_client(self, client) -> None:
        prev = getattr(self, "_owned_log_client", None)
        if prev is not None and prev is not client:
            self._schedule_close(prev)
        self._owned_log_client = client if client is not self.es else None

    def _schedule_close(self, client) -> None:
        try:
            import asyncio
            asyncio.get_running_loop().create_task(client.close())
        except RuntimeError:
            pass  # no running loop (sync init) — closed at shutdown

    def _build_log_source(self):
        """Construct the primary pull connector for the agent's log surface.

        Honors the primary source's OWN ES connection + TLS settings (es_url/
        es_api_key/es_verify_certs/es_ca_cert) by building a per-source client when
        those overrides are present; otherwise wraps the shared scoped read-only ES
        client. Both Elasticsearch and OpenSearch read identically; the choice only
        affects provenance/query language. Defaults to Elasticsearch when no source
        is configured yet."""
        from .connectors.elastic import ElasticConnector
        from .connectors.opensearch import OpenSearchConnector
        from .connectors.wazuh import WazuhConnector
        from .constants import SourceType

        primary = self.prefs.primary_source()
        if primary is None:
            self._set_owned_log_client(None)
            return ElasticConnector(self.es)
        es_client, owned = self.es_client_for_source(primary)
        self._set_owned_log_client(es_client if owned else None)
        # Pass the source's display_name through config so tagged events carry a
        # human-readable source_name (UI filter-by-source). Non-secret, additive.
        cfg = {**(primary.config or {})}
        if primary.display_name:
            cfg.setdefault("display_name", primary.display_name)
        cid = primary.id
        if primary.source_type == SourceType.OPENSEARCH:
            return OpenSearchConnector(es_client, config=cfg, connector_id=cid)
        if primary.source_type == SourceType.WAZUH:
            return WazuhConnector(es_client, config=cfg, connector_id=cid)
        return ElasticConnector(es_client, config=cfg, connector_id=cid)

    def _build_rag(self) -> RagService:
        """Construct the RAG service, wiring the CaseStore (resolved-case memory)
        and selecting a persistent vector store. On the SQL state backend the
        SqlVectorStore is used (pgvector on Postgres, JSON+Python cosine on
        SQLite); on the ES backend a persistent ES vector store is used ONLY when a
        real management ES client is present. Otherwise the in-memory store."""
        store = None
        if self._is_sql_backend() and self._sql_engine is not None:
            try:
                from .stores.sql import SqlVectorStore

                store = SqlVectorStore(self._sql_engine)
                logger.info("RAG using persistent SQL vector store (%s)", self.secrets.state_backend)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Could not select SQL vector store (%s); using in-memory", exc)
            return RagService(self.gateway, self.prefs, store=store, cases=self.cases)
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
        await self._bootstrap_state_backend()
        self.prefs = await self.config_store.load()
        # First-run seeding of the built-in rule catalog (C3-1): idempotent and
        # guarded by rule_catalog_seed_version so operator edits are never clobbered.
        self.prefs = await self.config_store.seed_rule_catalog(self.prefs)
        self.rag = self._build_rag()
        self.pipeline._rag = self.rag
        self.chat_engine._rag = self.rag
        # Reload playbooks now that prefs (incl. any dir override) are available.
        self.playbooks = self._build_playbooks()
        self.pipeline._playbooks = self.playbooks
        if start_poller:
            self.poller.start()
            await self._start_receivers()
        logger.info(
            "AppState started (es=%s, setup_complete=%s, polling_enabled=%s)",
            type(self.es).__name__, self.prefs.setup_complete, self.prefs.polling_enabled,
        )

    async def _bootstrap_state_backend(self) -> None:
        """Create the OWN-state schema for the active backend.

        SQL backend → create the SQL tables (idempotent) and SKIP ES index
        bootstrap entirely (a SQL deployment needs no Elasticsearch for its own
        state). ES backend → bootstrap the tlsoc-agent-* indices as before."""
        if self._is_sql_backend() and self._sql_engine is not None:
            try:
                from .stores.sql import create_all

                await create_all(self._sql_engine)
            except Exception as exc:  # noqa: BLE001
                logger.error("SQL state schema bootstrap failed (%s); continuing", exc)
            return
        try:
            await bootstrap_indices(self.es)
        except Exception as exc:  # noqa: BLE001
            logger.error("Index bootstrap failed (%s); continuing", exc)

    async def _start_receivers(self) -> None:
        """Start background PUSH receivers for enabled configured sources.

        HTTP push receivers (webhook/HEC) are driven by the ``/api/ingest/{id}``
        route, not a task, so they are skipped here. Every other receiver
        (syslog/queues/object-store/file) runs as a guarded asyncio task whose
        ``emit`` feeds the shared :class:`IngestService`. A receiver that can't
        start (missing optional dep, bind error) is logged and skipped — it never
        blocks startup."""
        await self._stop_receivers()
        from .connectors.registry import get_registry
        from .constants import IngestMode

        reg = get_registry()
        for src in self.prefs.sources:
            if not src.enabled or not reg.is_receiver(src.source_type):
                continue
            cls = reg.get(src.source_type)
            if cls is None:
                continue
            if IngestMode.PUSH_HTTP in cls.manifest().ingest_modes:
                continue  # route-driven, no background task
            try:
                effective = {**src.config, **self.secrets.source_secrets(src.id)}
                receiver = cls(config=effective, connector_id=src.id)

                async def _emit(events, _self=self, _sid=src.id):
                    await _self.ingest_service.ingest(events, _self.prefs, source_id=_sid)

                task = asyncio.create_task(receiver.start(_emit, self.prefs))
                self._receivers.append(receiver)
                self._receiver_tasks.append(task)
                logger.info("Started push receiver %s (%s)", src.id, src.source_type.value)
            except Exception as exc:  # noqa: BLE001 — one bad source must not block startup
                logger.error("Could not start receiver %s (%s): %s", src.id, src.source_type.value, exc)

    async def _stop_receivers(self) -> None:
        for receiver in self._receivers:
            try:
                await receiver.stop()
            except Exception:  # noqa: BLE001
                pass
        for task in self._receiver_tasks:
            task.cancel()
        self._receivers = []
        self._receiver_tasks = []

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
                await self._bootstrap_state_backend()
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
        await self._stop_receivers()
        await self.gateway.aclose()
        await self.cache.aclose()
        owned = getattr(self, "_owned_log_client", None)
        if owned is not None and owned is not self.es:
            try:
                await owned.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            await self.es.close()
        except Exception:  # noqa: BLE001
            pass
        if self._sql_engine is not None:
            try:
                await self._sql_engine.dispose()
            except Exception:  # noqa: BLE001
                pass
            self._sql_engine = None


def _coerce_bool(v: Any, default: bool = True) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() not in ("false", "0", "no", "off", "")
    return default if v is None else bool(v)


def _source_es_overrides(merged: dict[str, Any]) -> dict[str, Any]:
    """Translate a source's merged config+secrets into Secrets connection overrides.
    Returns {} when the source specifies no ES connection settings (→ use the shared
    global client). This is what makes a source's es_verify_certs/es_ca_cert apply."""
    out: dict[str, Any] = {}
    if merged.get("es_url"):
        out["es_url"] = str(merged["es_url"])
    if merged.get("es_api_key"):
        out["es_api_key"] = str(merged["es_api_key"])
    if "es_verify_certs" in merged:
        out["es_verify_certs"] = _coerce_bool(merged.get("es_verify_certs"))
    if merged.get("es_ca_cert"):
        out["es_ca_cert"] = str(merged["es_ca_cert"])
    return out


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
