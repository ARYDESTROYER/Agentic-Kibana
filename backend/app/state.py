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
        # Demo Mode (Wave 5): a SEPARATE, throwaway store stack + live simulator,
        # built ONLY while demo is engaged. None == demo off (the default). The
        # "active store" properties below switch every read/write store onto this
        # stack so REAL cases are hidden + isolated; disable GC's it + the real
        # state returns intact.
        self._demo = None
        self._demo_sim = None
        self._wire()

    # ------------------------------------------------------------------ #
    # Active-store indirection (Demo Mode, Wave 5).
    #
    # Every READ/WRITE endpoint reaches its store via these properties, NOT the raw
    # ``_real_*`` attributes. When demo is engaged (``self._demo`` is set) they
    # transparently return the throwaway demo stack, so the cases list / metrics /
    # overview / cost / standup / browse all serve DEMO data and the REAL cases are
    # hidden — without a single ``if demo`` in any route. When demo is off, the real
    # store is returned, byte-for-byte as before. A WRITE-GUARD asserts no demo row
    # can reach the real store (and vice-versa); see ``_write_guard``.
    # ------------------------------------------------------------------ #
    @property
    def demo_active(self) -> bool:
        return self._demo is not None

    @property
    def cases(self):
        return self._demo.cases if self._demo is not None else self._real_cases

    @property
    def audit(self):
        return self._demo.audit if self._demo is not None else self._real_audit

    @property
    def usage_store(self):
        return self._demo.usage_store if self._demo is not None else self._real_usage_store

    @property
    def pipeline(self):
        return self._demo.pipeline if self._demo is not None else self._real_pipeline

    @property
    def ingest_service(self):
        return self._demo.ingest_service if self._demo is not None else self._real_ingest_service

    @property
    def standup_service(self):
        return self._demo.standup_service if self._demo is not None else self._real_standup_service

    @property
    def overview_service(self):
        return self._demo.overview_service if self._demo is not None else self._real_overview_service

    @property
    def chat_engine(self):
        # In demo, chat MUST use the demo-bound engine ($0 demo gateway + demo
        # audit/cases) so a chat turn spends no real $, writes no permanent real
        # audit rows, and an in-case chat reads the DEMO case store. Off demo, the
        # real engine — byte-for-byte as before.
        return self._demo.chat_engine if self._demo is not None else self._real_chat_engine

    def _wire(self) -> None:
        es = self.es
        # OWN-state backend (Epoch A): cases/audit/usage/config/cursor live EITHER
        # in Elasticsearch (default) or a SQL database (sqlite/postgres). The
        # agent's read-only LOG surface always stays on the connector layer below.
        self._build_state_backend()
        self.gateway = LLMGateway(self.secrets, self._real_usage_store, self._provider_overrides)
        # Auth service (Wave 2). Disabled unless secrets.auth_enabled — the no-auth
        # "old version" is the default. Building it is cheap and re-runs on rewire.
        from .auth.service import AuthService

        self.auth = AuthService(
            enabled=self.secrets.auth_enabled,
            jwt_secret=self.secrets.auth_jwt_secret or "",
            token_hours=self.secrets.auth_token_hours,
            users=self.secrets.auth_user_map(),
            admin_username=self.secrets.auth_admin_username,
            mfa_enforce_roles=list(getattr(getattr(self.prefs, "mfa", None), "enforce_for_roles", []) or []),
        )
        # Multi-USER store (Wave 1) over the SAME KV the MEMORY/PROPOSAL stores use
        # — no new index/table/migration. Seeded + folded into AuthService during
        # async startup() (and after user-mgmt mutations) via refresh_users().
        self.users = self._build_users()
        # Session registry (Wave 3) over the SAME shared KV — no new index/table.
        # Persisted so it survives _wire() rebuilds. The async revocation/expiry
        # check runs in the deps layer (require_auth) against this store; the per-user
        # token_version snapshot is folded into AuthService (set_session_versions).
        self.sessions = self._build_sessions()
        # Markdown playbook registry (loaded from disk; deterministic per-cluster
        # selection). Reloaded in startup() once prefs (and any dir override) load.
        self.playbooks = self._build_playbooks()
        # Operator MEMORY store (durable trusted facts). Backed by the SAME KV the
        # config/cursor stores use for the active backend (SQL: SqlKVStore; ES: a
        # thin EsKVStore over the config index) — no new index/table/migration.
        self.memory = self._build_memory()
        # Agent-DRAFTED proposals awaiting human approval (HITL). Backed by the SAME
        # KV as the MEMORY store — no new index/table/migration.
        self.proposals = self._build_proposals()
        # Per-USER personal preferences (Wave 7: pervasive customization — saved
        # views, per-table column state, theme mode). Backed by the SAME KV as the
        # MEMORY store — keyed by user_id, 'default' bucket when auth is off, no new
        # index/table/migration. Merged ORG ← USER by the cascade resolver.
        self.user_prefs = self._build_user_prefs()
        # Case-number sequence store (F7) over the SAME shared KV — no new index/table.
        self.case_seq = self._build_case_seq()
        self.rag = self._build_rag()
        # The agent's read-only log surface as a connector (source-agnostic). The
        # poller, the es_query tool (via pipeline/chat) read through this. Behaviour
        # is identical to the legacy direct-ES path; swapping the primary source
        # type later re-points the whole graph here.
        self.log_source = self._build_log_source()
        self._real_pipeline = InvestigationPipeline(
            es, self.secrets, self.cache, self.gateway, self.rag, self._real_cases, self._real_audit,
            source=self.log_source, playbooks=self.playbooks, memory=self.memory,
            seq_store=self.case_seq,
        )
        self._real_chat_engine = ChatEngine(
            es, self.gateway, self._real_audit, self._real_cases, self.rag,
            source=self.log_source, memory=self.memory,
        )
        self._real_standup_service = StandupService(es, self.gateway, self._real_audit)
        self._real_overview_service = OverviewService(self.gateway, self.secrets, self.cache, self._real_audit)
        self.poller = Poller(
            es, self._real_cases, self.cursor_store, self._real_audit, self._real_pipeline, self.get_prefs,
            source=self.log_source,
        )
        # Shared ingest path for PUSH receivers (webhook/syslog/queues/…): the same
        # correlate → case path the poller uses.
        self._real_ingest_service = IngestService(
            self._real_cases, self._real_audit, self._real_pipeline, self.get_prefs
        )
        # Fire-and-forget outbound notifications (F5 / Wave 4). Built AFTER the case
        # stores so the case-creation pipeline + lifecycle routes can fire it post-save.
        # It never blocks or alters the case decision (#3).
        from .notifications.dispatch import NotificationService

        self.notifications = NotificationService(
            get_prefs=self.get_prefs, secrets=self.secrets, cache=self.cache, audit=self._real_audit,
        )
        # Let the pipeline reach the dispatcher (post-save, fire-and-forget hook).
        self._real_pipeline.notifier = self.notifications

        # Threshold automation (F10 / Wave 6): post-decision, #3-safe. It runs AFTER
        # apply()+save and may ONLY tag/recommend/notify/queue a re-investigation
        # (which re-runs decide())/open a HITL Proposal — never set status/close.
        from .engine.threshold_automation import ThresholdAutomation

        self.automation = ThresholdAutomation(
            self.proposals, self._real_audit,
            notify=self._automation_notify,
            queue_playbook_run=self._automation_queue_playbook,
        )
        self._real_pipeline.automation = self.automation

    async def _automation_notify(self, case, trigger: str) -> None:
        """Automation NOTIFY action → dispatch through the existing notification
        service. Fire-and-forget; never raises into the case path."""
        notifier = getattr(self, "notifications", None)
        if notifier is None:
            return
        await notifier.dispatch(case, trigger)

    async def _automation_queue_playbook(self, case, playbook_id: str) -> None:
        """Automation RUN_PLAYBOOK action → QUEUE a re-investigation of the case with
        the playbook forced as TRUSTED context. Detached so it never blocks the
        case path; the re-investigation itself re-runs the deterministic decide()."""
        import asyncio

        async def _do() -> None:
            try:
                cluster = await self._automation_cluster_for_case(case)
                if cluster is None:
                    return
                await self._real_pipeline.investigate_cluster(
                    cluster, case.source_surface, self.prefs,
                    force=True, force_playbook_id=playbook_id,
                )
            except Exception:  # noqa: BLE001 — a queued re-investigation never breaks anything
                logger.debug("automation playbook re-investigation failed for %s", case.case_id)

        asyncio.create_task(_do())

    async def _automation_cluster_for_case(self, case):
        """Rebuild a cluster for a queued automation re-investigation (read-only).

        Mirrors the routes' ``_cluster_for_case`` but kept dependency-light here to
        avoid a routes import cycle. Returns None when no events remain."""
        from .engine.correlation import cluster_from_events
        from .es.querybuilder import ids_query
        from .models import RawEvent

        prefs = self.prefs
        if not case.member_event_ids:
            return None
        try:
            resp = await self.es.search_logs(
                prefs.data_view_pattern,
                ids_query(case.member_event_ids, size=len(case.member_event_ids)),
            )
        except Exception:  # noqa: BLE001
            return None
        hits = resp.get("hits", {}).get("hits", [])
        events = [RawEvent.from_hit(h, prefs) for h in hits]
        members = [e for e in events if e.entity_value(case.entity.type) == case.entity.value] or events
        if not members:
            return None
        cluster = cluster_from_events(case.entity.type, case.entity.value, members)
        cluster.trigger_reason = None  # preserve the existing case's trigger reason
        return cluster

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
            self._real_usage_store = SqlUsageRepository(engine)
            self._real_audit = SqlAuditRepository(engine)
            self._real_cases = SqlCaseRepository(engine)
            self.cursor_store = SqlCursorStore(kv)
            self.config_store = SqlConfigStore(kv)
            logger.info("OWN-state backend: SQL (%s)", self.secrets.state_backend)
            return
        es = self.es
        from .stores.memory import EsKVStore

        # ES backend has no generic KV table; a thin adapter over the config index
        # gives the MEMORY store the same get/put contract the SQL backend provides.
        self._kv = EsKVStore(es)
        self._real_usage_store = UsageStore(es)
        self._real_audit = AuditLogger(es)
        self._real_cases = CaseStore(es)
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

    def _build_proposals(self):
        """Construct the agent-PROPOSAL store over the active backend's KV (the same
        KV the MEMORY store uses — works on ES + SQL, no new index/table)."""
        from .stores.proposals import ProposalStore

        return ProposalStore(self._kv)

    def _build_user_prefs(self):
        """Construct the per-USER personal-preferences store (Wave 7) over the active
        backend's KV (the same KV the MEMORY/USER stores use — works on ES + SQL, no
        new index/table). Holds saved views, per-table column state, theme mode."""
        from .stores.user_prefs import UserPrefsStore

        return UserPrefsStore(self._kv)

    def _build_users(self):
        """Construct the multi-USER store over the active backend's KV (the same KV
        the MEMORY/PROPOSAL stores use — works on ES + SQL, no new index/table)."""
        from .stores.users import UserStore

        return UserStore(self._kv)

    def _build_sessions(self):
        """Construct the session registry store (Wave 3) over the active backend's KV
        (the same KV the MEMORY/USER stores use — works on ES + SQL, no new
        index/table). Persisted so it survives _wire() rebuilds."""
        from .stores.sessions import SessionStore

        return SessionStore(self._kv)

    def _build_case_seq(self):
        """Construct the case-number SequenceStore (F7) over the active backend's KV
        (the same KV the MEMORY store uses — its own namespace, no new index/table)."""
        from .engine.case_id import SequenceStore

        return SequenceStore(self._kv)

    async def seed_users(self) -> None:
        """First-run seeding of the demo super_admin (``Admin``/``Admin@123``), and
        of the env single-admin as a real user, when auth is ENABLED and the user
        store is EMPTY. Race-safe (create-if-absent only when empty) and a strict
        no-op when auth is disabled. Records a transient ``_seeded_default_admin``
        signal for /api/setup/status. Best-effort: a store failure never blocks
        startup."""
        self._seeded_default_admin = False
        if not self.secrets.auth_enabled:
            return
        try:
            if await self.users.count() > 0:
                return
            from .auth.passwords import hash_password
            from .constants import UserRole

            # When an env single-admin is configured (auth_admin_password set), that
            # IS the bootstrap admin — don't also seed the demo Admin (it would
            # collide on the lowercased username and shadow the env creds). The demo
            # seed is for the zero-config deployment that has no env admin.
            env_admin = bool(self.secrets.auth_admin_password)
            if self.secrets.auth_seed_admin and not env_admin:
                created = await self.users.create_if_absent(
                    username=self.secrets.auth_seed_admin_username,
                    password_hash=hash_password(self.secrets.auth_seed_admin_password),
                    role=UserRole.SUPER_ADMIN.value,
                    active=True,
                    must_change_password=False,
                )
                if created is not None:
                    self._seeded_default_admin = True
                    logger.info(
                        "Seeded demo super_admin '%s' (change the password!)",
                        created.username,
                    )
        except Exception as exc:  # noqa: BLE001 — seeding is best-effort
            logger.warning("User seeding failed (%s); continuing", exc)

    async def refresh_users(self) -> None:
        """Sync :attr:`auth` with the CURRENT multi-user store records (role / active
        / must_change_password / password hash) via ``AuthService.set_users`` —
        WITHOUT rebuilding the service (so the JWT signing secret is stable across
        refreshes and live sessions survive a user-mgmt mutation). Called after
        startup seeding and after any user-mgmt mutation so a new/disabled/role-
        changed user takes effect on the next request without a restart."""
        try:
            users = await self.users.list()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Refreshing users into AuthService failed (%s)", exc)
            return
        try:
            self.auth.set_users(users)
            # Keep the MFA-enforce role set in sync with current prefs (Wave 2 / F3).
            self.auth.set_mfa_enforce_roles(
                list(getattr(getattr(self.prefs, "mfa", None), "enforce_for_roles", []) or [])
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("AuthService.set_users failed (%s)", exc)
        # Keep the per-user session token_version snapshot in AuthService current so
        # the next mint stamps the right ``tv`` (Wave 3). Best-effort.
        await self.refresh_sessions(users)

    async def refresh_sessions(self, users: list | None = None) -> None:
        """Fold the CURRENT per-user session ``token_version`` snapshot (from the
        persistent SessionStore) into AuthService so synchronous token minting stamps
        the right ``tv`` claim. Called on startup, after a user-mgmt mutation, and
        after a revoke-all (which bumps a tv). Best-effort + never raises."""
        sessions = getattr(self, "sessions", None)
        if sessions is None:
            return
        try:
            if users is None:
                users = await self.users.list()
        except Exception:  # noqa: BLE001
            users = []
        versions: dict[str, int] = {}
        try:
            for u in users or []:
                uname = str(getattr(u, "username", "") or "")
                if uname:
                    versions[uname] = await sessions.token_version_for(uname)
            # Include the AuthService BASE/env-admin username(s). They are NOT stored
            # Users, so iterating users.list() alone leaves their snapshot tv at 0 —
            # after a revoke-all bumps the persistent tv to >=1, a fresh env-admin
            # login would stamp tv=0 < current_tv → permanent reauth_required lockout.
            # Default each from the SessionStore's per-user tv (like a stored user);
            # skip any already resolved above (a stored user with the same name wins).
            seen = {k.strip().lower() for k in versions}
            auth = getattr(self, "auth", None)
            base_names = list(auth.base_usernames()) if auth is not None else []
            for uname in base_names:
                if uname and uname.strip().lower() not in seen:
                    versions[uname] = await sessions.token_version_for(uname)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Refreshing session token_versions failed (%s)", exc)
            return
        try:
            self.auth.set_session_versions(versions)
        except Exception as exc:  # noqa: BLE001
            logger.warning("AuthService.set_session_versions failed (%s)", exc)

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
        self._real_pipeline._playbooks = self.playbooks
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
            return RagService(self.gateway, self.prefs, store=store, cases=self._real_cases)
        try:
            from .es.client import RealESClient
            from .tools.vectorstore import ESVectorStore

            if isinstance(self.es, RealESClient) and getattr(self.es, "_mgmt", None) is not None:
                store = ESVectorStore(self.es)
                logger.info("RAG using persistent ES vector store (tlsoc-agent-rag)")
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not select ES vector store (%s); using in-memory", exc)
        return RagService(self.gateway, self.prefs, store=store, cases=self._real_cases)

    def rebuild_log_source(self) -> None:
        """Re-point the agent's log surface after the configured sources change.

        Rebuilds the primary connector from ``self.prefs`` and updates the live
        components that hold it (poller, pipeline, chat), so a wizard-driven source
        change takes effect without a restart. (Elastic/OpenSearch wrap the same
        scoped ES client, so this is behaviour-identical for those two.)"""
        self.log_source = self._build_log_source()
        self.poller._source = self.log_source
        self._real_pipeline._source = self.log_source
        self._real_chat_engine._source = self.log_source

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
        # Seed the demo/first admin (when auth is on + the store is empty) and fold
        # the user store into the AuthService so login + RBAC use real accounts.
        await self.seed_users()
        await self.refresh_users()
        self.rag = self._build_rag()
        self._real_pipeline._rag = self.rag
        self._real_chat_engine._rag = self.rag
        # Reload playbooks now that prefs (incl. any dir override) are available.
        self.playbooks = self._build_playbooks()
        self._real_pipeline._playbooks = self.playbooks
        # Demo Mode (Wave 5): if a demo run was persisted as active, rebuild the
        # throwaway stack + re-seed so the read endpoints have a demo store to serve
        # (demo data is in-memory; the FLAG persists across restarts — re-seeding
        # restores a believable demo deterministically from the same seed).
        demo = getattr(self.prefs, "demo", None)
        if demo is not None and demo.active:
            try:
                await self.enable_demo(
                    mode=demo.mode, seed=demo.seed, history_days=demo.history_days,
                    tick_seconds=demo.tick_seconds, tick_jitter=demo.tick_jitter,
                    incident_rate=demo.incident_rate,
                )
            except Exception as exc:  # noqa: BLE001 — never block startup on demo re-seed
                logger.warning("Demo re-seed on startup failed (%s); continuing", exc)
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
                    # Real push receivers ALWAYS feed the REAL ingest path (even while
                    # demo is engaged) so live telemetry lands in the real store
                    # (hidden during demo, never mixed into the demo store).
                    await _self._real_ingest_service.ingest(events, _self.prefs, source_id=_sid)

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
        # Keep the MFA-enforce role set live after a settings change (Wave 2 / F3).
        try:
            self.auth.set_mfa_enforce_roles(
                list(getattr(getattr(prefs, "mfa", None), "enforce_for_roles", []) or [])
            )
        except Exception:  # noqa: BLE001
            pass
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

    # ------------------------------------------------------------------ #
    # Demo Mode lifecycle (Wave 5) — enable / reset / disable / status.
    # All reversible + isolated: enable builds a throwaway demo stack + seeds a
    # backdated history; disable stops the ticker, hard-deletes demo data by run_id,
    # and flips the flag so the real state returns intact.
    # ------------------------------------------------------------------ #
    async def enable_demo(
        self, *, mode: str = "seeded", seed: int | None = None,
        history_days: int | None = None, tick_seconds: float | None = None,
        tick_jitter: float | None = None, incident_rate: float | None = None,
    ) -> dict:
        """Engage demo mode: stamp a run_id, build the isolated stack, pre-generate a
        backdated historical case spread, and (in ``live``) start the simulator. If a
        demo is already running it is disabled first (clean re-seed)."""
        from .config import DemoConfig
        from .engine.demo_generator import build_org, generate_historical_cases
        from .engine.demo_runtime import DemoSimulator, DemoStack
        from .utils import new_id, now_utc, to_millis

        if self._demo is not None:
            await self.disable_demo()

        cur = getattr(self.prefs, "demo", None) or DemoConfig()
        new_demo = DemoConfig(
            mode=("live" if mode == "live" else "seeded"),
            seed=int(seed if seed is not None else cur.seed),
            run_id=new_id("demorun-"),
            history_days=int(history_days if history_days is not None else cur.history_days),
            tick_seconds=float(tick_seconds if tick_seconds is not None else cur.tick_seconds),
            tick_jitter=float(tick_jitter if tick_jitter is not None else cur.tick_jitter),
            incident_rate=float(incident_rate if incident_rate is not None else cur.incident_rate),
        )
        # Persist the demo block FIRST so get_prefs() (read by the demo stack/sim)
        # already reflects the active run.
        prefs = self.prefs.model_copy(deep=True)
        prefs.demo = new_demo
        await self.update_prefs(prefs)

        # Build the throwaway demo stack + register the demo connector's manifest.
        self._demo = DemoStack(self.secrets, self.get_prefs, run_id=new_demo.run_id)
        try:
            from .connectors.registry import set_demo_registered

            set_demo_registered(True)
        except Exception:  # noqa: BLE001
            pass

        # Pre-generate the backdated historical spread so "old" cases exist instantly.
        org = build_org(new_demo.seed)
        now_ms = to_millis(now_utc())
        cases = generate_historical_cases(
            new_demo.seed, org, history_days=new_demo.history_days,
            run_id=new_demo.run_id, now_millis=now_ms,
        )
        for case in cases:
            self._write_guard(case, demo=True)
            await self._demo.cases.save(case)

        # Start the live simulator (only ticks in 'live' mode).
        if new_demo.mode == "live":
            self._demo_sim = DemoSimulator(self._demo, self.get_prefs, seed=new_demo.seed)
            self._demo_sim.start()
        logger.info("Demo mode ENABLED (mode=%s run_id=%s seeded %d cases)",
                    new_demo.mode, new_demo.run_id, len(cases))
        return await self.demo_status()

    async def reset_demo(self) -> dict:
        """Delete the current demo data + re-seed from the SAME seed/run knobs (a
        fresh run_id). A no-op error-path when demo is not active."""
        cur = getattr(self.prefs, "demo", None)
        if self._demo is None or cur is None or not cur.active:
            return await self.demo_status()
        mode, seed = cur.mode, cur.seed
        hd, ts, tj, ir = cur.history_days, cur.tick_seconds, cur.tick_jitter, cur.incident_rate
        await self.disable_demo()
        return await self.enable_demo(
            mode=mode, seed=seed, history_days=hd, tick_seconds=ts,
            tick_jitter=tj, incident_rate=ir,
        )

    async def disable_demo(self) -> dict:
        """Stop the ticker, hard-delete ALL demo data (cases/audit/usage/events) by
        tearing down the throwaway stack, and flip demo OFF. The real state is
        untouched throughout, so it returns intact."""
        from .config import DemoConfig

        if self._demo_sim is not None:
            try:
                await self._demo_sim.stop()
            except Exception:  # noqa: BLE001
                pass
            self._demo_sim = None
        if self._demo is not None:
            try:
                await self._demo.purge()
                await self._demo.aclose()
            except Exception:  # noqa: BLE001
                pass
            self._demo = None
        try:
            from .connectors.registry import set_demo_registered

            set_demo_registered(False)
        except Exception:  # noqa: BLE001
            pass
        prefs = self.prefs.model_copy(deep=True)
        prefs.demo = DemoConfig()  # mode='off', run_id=''
        await self.update_prefs(prefs)
        logger.info("Demo mode DISABLED; real state restored")
        return await self.demo_status()

    async def demo_tick(self) -> dict:
        """Run ONE demo simulation tick on demand (a manual ``/poll`` while demo is
        engaged). Builds an ephemeral simulator for ``seeded`` mode (which has no
        background ticker) so the showcase can be driven manually. Returns the tick
        stats. A no-op when demo is off."""
        if self._demo is None:
            return {"benign": 0, "story": 0, "demo": False}
        sim = self._demo_sim
        if sim is None:
            from .engine.demo_runtime import DemoSimulator

            seed = int(getattr(getattr(self.prefs, "demo", None), "seed", 1337) or 1337)
            sim = DemoSimulator(self._demo, self.get_prefs, seed=seed)
        stats = await sim.tick_once()
        stats["demo"] = True
        return stats

    async def demo_status(self) -> dict:
        """A small status payload for GET /api/demo/status."""
        demo = getattr(self.prefs, "demo", None)
        mode = getattr(demo, "mode", "off") if demo else "off"
        run_id = getattr(demo, "run_id", "") if demo else ""
        case_count = 0
        if self._demo is not None:
            try:
                _cases, case_count = await self._demo.cases.list(limit=1)
            except Exception:  # noqa: BLE001
                case_count = 0
        return {
            "mode": mode,
            "active": bool(demo and demo.active),
            "run_id": run_id,
            "seed": getattr(demo, "seed", 0) if demo else 0,
            "history_days": getattr(demo, "history_days", 0) if demo else 0,
            "tick_seconds": getattr(demo, "tick_seconds", 0.0) if demo else 0.0,
            "incident_rate": getattr(demo, "incident_rate", 0.0) if demo else 0.0,
            "simulator_running": self._demo_sim is not None,
            "case_count": case_count,
        }

    @staticmethod
    def _write_guard(case, *, demo: bool) -> None:
        """Assert a row's demo-ness matches the store it is about to be written to.

        A demo case MUST be tagged ``demo`` and carry a ``demo-…`` case_id; a real
        case must NOT. This is the belt-and-braces backstop ensuring no demo row ever
        leaks into the real store and vice-versa (#4)."""
        is_demo_row = ("demo" in (getattr(case, "tags", []) or [])) or str(
            getattr(case, "case_id", "")
        ).startswith("demo-")
        if demo and not is_demo_row:
            raise AssertionError("write-guard: a demo store write must carry a demo-tagged row")
        if not demo and is_demo_row:
            raise AssertionError("write-guard: a real store write must NOT carry a demo row")

    async def shutdown(self) -> None:
        try:
            await self.disable_demo()
        except Exception:  # noqa: BLE001
            pass
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


def parse_user_agent(ua: str) -> dict[str, str]:
    """A tiny, dependency-free User-Agent parser (Wave 3, stdlib only).

    Returns ``{"ua_browser", "ua_os", "client_type"}`` — best-effort, never raises.
    This is heuristic (NOT a full UA database) and produces PLAIN labels rendered as
    text by the UI (#9). An unrecognised UA degrades to empty strings."""
    raw = (ua or "").strip()
    low = raw.lower()
    if not raw:
        return {"ua_browser": "", "ua_os": "", "client_type": ""}
    # Browser (order matters — Edge/Chrome share tokens; check the more specific first).
    browser = ""
    for needle, label in (
        ("edg/", "Edge"), ("edga/", "Edge"), ("edgios/", "Edge"),
        ("opr/", "Opera"), ("opera", "Opera"),
        ("chrome/", "Chrome"), ("crios/", "Chrome"),
        ("firefox/", "Firefox"), ("fxios/", "Firefox"),
        ("safari/", "Safari"),
        ("curl/", "curl"), ("python-requests", "python-requests"),
        ("postmanruntime", "Postman"), ("httpie", "HTTPie"),
    ):
        if needle in low:
            browser = label
            break
    # OS family.
    os_name = ""
    for needle, label in (
        ("windows nt 10", "Windows"), ("windows nt 11", "Windows"), ("windows", "Windows"),
        ("iphone", "iOS"), ("ipad", "iPadOS"),
        ("mac os x", "macOS"), ("macintosh", "macOS"),
        ("android", "Android"),
        ("cros", "ChromeOS"),
        ("linux", "Linux"),
    ):
        if needle in low:
            os_name = label
            break
    # Client type heuristic.
    if any(t in low for t in ("curl/", "python-requests", "postmanruntime", "httpie", "go-http", "okhttp")):
        client_type = "api"
    elif any(t in low for t in ("mobile", "iphone", "android")):
        client_type = "mobile"
    elif browser:
        client_type = "browser"
    else:
        client_type = ""
    return {"ua_browser": browser, "ua_os": os_name, "client_type": client_type}


def client_ip_from(request) -> str:
    """Best-effort client IP from a Starlette/FastAPI request (Wave 3, stdlib only).

    Honors a single ``X-Forwarded-For`` hop (first entry) when present, else the
    socket peer. PLAIN text, never raises. (No trust decision is made here — the IP
    is metadata only, never an authz input.)"""
    try:
        xff = request.headers.get("x-forwarded-for") or ""
        if xff:
            first = xff.split(",")[0].strip()
            if first:
                return first
        client = getattr(request, "client", None)
        return str(getattr(client, "host", "") or "")
    except Exception:  # noqa: BLE001
        return ""


def geo_for_ip(ip: str) -> dict[str, str]:
    """Best-effort IP → ``{"ip_city", "ip_country"}`` (Wave 3). Stdlib only and a
    NO-OP by default — we add NO geo dependency and make NO network call. A private/
    loopback/empty IP yields a friendly local label; everything else yields empties
    (a future operator-supplied offline geo DB could fill these in). Never raises."""
    addr = (ip or "").strip()
    if not addr:
        return {"ip_city": "", "ip_country": ""}
    try:
        import ipaddress

        parsed = ipaddress.ip_address(addr)
        if parsed.is_loopback or parsed.is_private or parsed.is_link_local:
            return {"ip_city": "", "ip_country": "Local network"}
    except ValueError:
        pass
    return {"ip_city": "", "ip_country": ""}


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
