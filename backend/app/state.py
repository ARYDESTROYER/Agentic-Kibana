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
        # Round-4 Wave-3: the lazily-built batch service is memoised here; _wire()
        # clears it so a credential/store rebuild re-binds it to the fresh gateway/store.
        self._batch_service = None
        # Round-4 Wave-4: the gated background schedulers (threshold-tuner / campaign /
        # batch-jobs). Started in startup() (behind start_poller), cancelled in
        # shutdown(). All default-OFF: each loop is a NO-OP until its Preferences block is
        # enabled, so a byte-identical boot spawns tasks that immediately go back to sleep.
        self._scheduler_tasks: list[asyncio.Task] = []
        self._scheduler_running = False
        # The single, long-lived streaming baseline model behind the EVENT-feed detection
        # funnel (Wave-4). Warmed from baseline_store on first use; None until built. It
        # holds per-(signature, bucket) sketches in memory so the funnel's anomaly pass
        # improves across polls. Rebuilt on _wire() (fresh prefs/store handles).
        self._funnel_baseline = None
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

    # ------------------------------------------------------------------ #
    # Public accessors for the REAL (never demo-swapped) collaborators + KV.
    #
    # Round 5 (Coupling-F / G8): the multi-source poller, the reset engine, and the
    # tuning/rules/reset routers reach the REAL store side directly (even under demo
    # mode a poll/reset/rule-write always operates on the real backend — never the
    # throwaway demo store). These name-stable public properties are the ONE seam those
    # collaborators depend on (the :class:`app.engine.poller_manager.PollerHost` /
    # :class:`app.engine.reset.ResetHost` Protocols), so they no longer reach into the
    # ``_real_*``/``_kv`` privates. Behaviour is byte-identical — same objects, just a
    # documented public surface + a decoupling firewall. The demo-aware ``cases``/
    # ``audit``/``pipeline`` accessors above still swap; these deliberately DO NOT.
    # ------------------------------------------------------------------ #
    @property
    def real_cases(self):
        """The REAL case store (never the demo-swapped one)."""
        return self._real_cases

    @property
    def real_audit(self):
        """The REAL append-only audit logger (never the demo-swapped one)."""
        return self._real_audit

    @property
    def real_pipeline(self):
        """The REAL investigation pipeline (never the demo-swapped one)."""
        return self._real_pipeline

    @property
    def real_ingest_service(self):
        """The REAL push/queue ingest service (never the demo-swapped one)."""
        return self._real_ingest_service

    @property
    def kv(self):
        """The shared KV doc store backing every KV-over-KVStore store (public alias
        for the historically-private ``_kv``)."""
        return self._kv

    @property
    def oidc_state(self):
        """The single-use OIDC ``state``-token store (Round 5 / Coupling-F) — the
        public seam the SSO routes use to stash/consume the Authorization-Code state
        instead of reaching into ``_kv``. Built lazily over the shared KV; rebound on a
        ``_wire()`` KV rebuild."""
        store = getattr(self, "_oidc_state_store", None)
        kv = getattr(self, "_kv", None)
        if store is None or getattr(store, "_kv", None) is not kv:
            from .auth.oidc import OidcStateStore

            store = OidcStateStore(kv)
            self._oidc_state_store = store
        return store

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

    @property
    def rag_service(self):
        # In demo, the RAG service is the demo's SHARED (pipeline+chat) vector store so
        # the Knowledge surface reflects the demo corpus; off demo, the real service.
        return self._demo.rag_service if self._demo is not None else self.rag

    def _wire(self) -> None:
        es = self.es
        # OWN-state backend (Epoch A): cases/audit/usage/config/cursor live EITHER
        # in Elasticsearch (default) or a SQL database (sqlite/postgres). The
        # agent's read-only LOG surface always stays on the connector layer below.
        self._build_state_backend()
        # Round-3 Wave-2 (F9): construct the wave-1 KV stores BEFORE the gateway so the
        # operator PriceOverlayStore + a pre-flight BudgetGate are LIVE on every LLM
        # call. These stores depend only on self._kv (set in _build_state_backend just
        # above), so building them here is safe and they are NOT rebuilt later — the
        # later _build_wave1_stores() call below is removed in favour of this one.
        self._build_wave1_stores()
        # Round-4 Wave-3: the 4 new default-OFF KV stores (tuning ledger / campaign list /
        # anomaly-baseline sketch / batch-job registry) over the SAME shared KV. Built here
        # so a live handle survives every _wire() rebuild (same rationale as the Round-3
        # stores). Their engines/schedulers/API are Wave-4 and do NOT run at boot.
        self._build_round4_stores()
        # Round-5 (G7): per-user custom-dashboard store over the SAME shared KV — no new
        # index/table/migration. Built here so a live handle survives every _wire()
        # rebuild, exactly like the Round-3/4 stores. Advisory presentation state only
        # (#3-safe); never read by case_manager.decide().
        self._build_round5_stores()
        # Round-7: durable Noise-Reduction counter store over the SAME shared KV — no new
        # index/table/migration. Built here (BEFORE the poller/ingest service below) so its
        # ``record`` is available to wire as their fail-open counter sink, and so a live
        # handle survives every ``_wire()`` rebuild like the Round-3/4/5 stores. Advisory
        # presentation state only (#3-safe); never read by case_manager.decide().
        self._build_round7_stores()
        # Drop any memoised batch service so it re-binds to the freshly-built store +
        # gateway on the next access (a credential change rebuilds both).
        self._batch_service = None
        from .engine.budget import BudgetGate

        # Read-only pre-flight ceiling: reads the live BudgetConfig + usage ledger. A
        # block raises GatewayError → fail-to-human (never closes a case, #3). Demo/$0
        # calls bypass it inside the gateway. Fail-open on a ledger glitch.
        self.budget_gate = BudgetGate(
            get_budget=lambda: self.prefs.budget, usage_store=self._real_usage_store
        )
        self.gateway = LLMGateway(
            self.secrets, self._real_usage_store, self._provider_overrides,
            price_overlay=self.price_overlay, budget_gate=self.budget_gate,
            custom_models=self.custom_models,
        )
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
        # Round-3 Wave-1 collaboration / notification / RBAC / pricing / shift-handoff
        # stores. Each mirrors the user_prefs/memory/sessions template EXACTLY:
        # backend-agnostic over the SAME shared KV (no new index/table/migration),
        # read-modify-write, never raises (degrades to a safe default). They hold ONLY
        # collaboration/notification/observability/pricing data — NONE feeds the
        # deterministic case_manager.decide() (#3); every free-text field they persist
        # is PLAIN data the UI render-escapes (#9). Built here (after user_prefs) so a
        # live handle survives every _wire() rebuild, just like sessions/user_prefs.
        # NOTE (Round-3 Wave-2): _build_wave1_stores() is now called EARLY (just before
        # the LLM gateway, above) so the PriceOverlayStore + BudgetGate are live on every
        # LLM call. It is NOT re-called here — re-calling would mint a fresh PriceOverlay
        # handle the already-built gateway would not see.
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
            # Round 5 (Coupling-F): the realtime EventBus is a module-global singleton
            # already available here, so inject it at construction (an optional ctor
            # kwarg) rather than the post-hoc setter it used to be. ``notifier`` +
            # ``automation`` still setter-inject BELOW because they depend on
            # collaborators built AFTER the pipeline — the _wire() ordering (#6) is
            # preserved; only this already-available collaborator moves to the ctor.
            event_bus=self.event_bus,
        )
        self._real_chat_engine = ChatEngine(
            es, self.gateway, self._real_audit, self._real_cases, self.rag,
            source=self.log_source, memory=self.memory, threads=self.case_threads,
        )
        self._real_standup_service = StandupService(
            es, self.gateway, self._real_audit,
            cases=self._real_cases, shift_handoff=self.shift_handoff,
        )
        self._real_overview_service = OverviewService(self.gateway, self.secrets, self.cache, self._real_audit)
        # Round 4: fan the poller out across EVERY enabled PULL source (not just the
        # primary). The PollerManager owns N per-source Pollers (the primary child
        # wraps ``self.log_source``; non-primary sources get their own #1-safe
        # per-source client + connector). It IS ``self.poller`` and preserves the
        # single Poller's external contract (start/stop/poll_once/_source/_attach).
        from .engine.poller_manager import PollerManager

        self.poller = PollerManager(self)
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
            inbox=self.inbox, notif_prefs=self.notif_prefs, users=self.users, event_bus=self.event_bus,
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
        # (The realtime EventBus is now injected at pipeline CONSTRUCTION above — Round 5
        # Coupling-F — instead of this post-hoc setter. The bus is the module-global
        # singleton, best-effort + #3/#11-safe, and a no-op when realtime is off.)

        # Round-4 Wave-4: wire the EVENT-feed detection-funnel hook onto the poller so a
        # ``role=events`` feed is routed to the funnel (aggregate→rules→anomaly→batched
        # detection) INSTEAD OF the realtime correlate — but ONLY when batch + baseline
        # are BOTH enabled (checked live inside the poller). Default OFF → the poller
        # never calls the hook and the realtime path is byte-identical. Rebuilt on _wire()
        # (fresh baseline model). Best-effort — a rewire never breaks on this assignment.
        self._funnel_baseline = None
        try:
            # Assign the hook DIRECTLY to the PRIMARY child so correctness does not depend
            # on a subsequent rebuild() running first (FINDING #8). The poller-concurrency
            # owner (H2) propagates the SAME ``_event_funnel`` attribute to ALL fan-out
            # children inside rebuild()/_build_child_for — the attribute name/contract is
            # kept stable so both edits compose.
            self.poller._primary._event_funnel = self._route_event_feed
        except Exception as exc:  # noqa: BLE001 — funnel wiring must never break a rewire
            logger.warning("event-funnel hook wiring failed (%s); routing disabled", exc)

        # Round-7: wire the Noise-Reduction counter sink onto BOTH ingest paths as SEPARATE
        # statements ALONGSIDE the EVENT-feed funnel above (P0 name-collision avoidance —
        # this never replaces ``_event_funnel``). ``PollerManager.set_noise_sink`` fans the
        # store's ``record`` out to EVERY child (primary + non-primary) and re-propagates it
        # on ``rebuild()`` (so a source edit keeps it wired — no re-attach needed); the push
        # ``IngestService`` records directly. Fail-open: the poll/ingest path is byte-identical
        # when the sink is unset, and a counter-wiring glitch never breaks a rewire.
        try:
            self.poller.set_noise_sink(self.noise_counters.record)
            self._real_ingest_service._noise_sink = self.noise_counters.record
        except Exception as exc:  # noqa: BLE001 — counter wiring must never break a rewire
            logger.warning("noise-counter sink wiring failed (%s); counters disabled", exc)

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

    def is_sql_backend(self) -> bool:
        """Public alias for :meth:`_is_sql_backend` — the ``ResetHost`` seam the reset
        engine uses to pick the SQL-truncate vs ES-delete clear path (Round 5)."""
        return self._is_sql_backend()

    @property
    def sql_engine(self):
        """The SQLAlchemy async engine when on a SQL state backend (else ``None``) —
        the ``ResetHost`` seam for the SQL-truncate reset path (Round 5)."""
        return self._sql_engine

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

    def _build_wave1_stores(self) -> None:
        """Construct the 8 Round-3 Wave-1 KV-backed stores over the active backend's KV
        (the SAME shared ``self._kv`` the MEMORY/USER/USER-PREFS stores use — works on
        ES + SQL, no new index/table/migration). Each takes only ``self._kv`` so it
        survives every ``_wire()`` rebuild. Called from ``_wire()`` after user_prefs.

        Keying contract for the route layer:
          * case_threads / case_activity / case_tasks — keyed by ``case.case_id``.
          * inbox / notif_prefs — keyed by user_id (None → the shared 'default'
            bucket via the bundled ``normalize_user_id`` when auth is off).
          * custom_roles / price_overlay — ORG-scoped (single 'default' bucket).
        None of these influences the close/escalate decision (#3); every free-text
        field they persist is PLAIN data the UI render-escapes (#9)."""
        from .stores.case_activity import CaseActivityStore
        from .stores.case_tasks import CaseTaskStore
        from .stores.case_thread import CaseThreadStore
        from .stores.custom_models import CustomModelStore
        from .stores.custom_roles import CustomRoleStore
        from .stores.inbox import InboxStore
        from .stores.notif_prefs import NotificationPrefsStore
        from .stores.price_overlay import PriceOverlayStore
        from .stores.shift_handoff import ShiftHandoffStore

        kv = self._kv
        # Collaboration (#4 collaboration surface beside the authoritative audit trail).
        self.case_threads = CaseThreadStore(kv)
        self.case_activity = CaseActivityStore(kv)
        self.case_tasks = CaseTaskStore(kv)
        # In-app notification fan-out + per-user delivery prefs (#8).
        self.inbox = InboxStore(kv)
        self.notif_prefs = NotificationPrefsStore(kv)
        # Operator-defined RBAC roles (org-scoped); folded into effective_matrix().
        self.custom_roles = CustomRoleStore(kv)
        # Advisory price overlay for the LLM cost LEDGER (#6) — never alters routing.
        self.price_overlay = PriceOverlayStore(kv)
        # Operator-added self-hosted / LiteLLM (OpenAI-compatible) models registered at
        # RUNTIME from the UI. Built here (BEFORE the gateway, like price_overlay) so the
        # gateway can resolve a bare custom model id's base_url + $0 price on every call.
        # Plain config data only; never feeds decide() (#3).
        self.custom_models = CustomModelStore(kv)
        # Shift-handoff action items + acknowledgements (org-scoped).
        self.shift_handoff = ShiftHandoffStore(kv)

    def _build_round4_stores(self) -> None:
        """Construct the 4 Round-4 Wave-3 KV-backed stores over the active backend's KV
        (the SAME shared ``self._kv`` the Round-3 stores use — works on ES + SQL, no new
        index/table/migration). Each takes only ``self._kv`` so it survives every
        ``_wire()`` rebuild, exactly like ``_build_wave1_stores`` above.

        ALL FOUR ARE ADVISORY / PLUMBING and DEFAULT-OFF (their engines only run when the
        matching ``Preferences.{threshold_tuning,campaign,baseline,batch}.enabled`` flag
        is set — the schedulers + feed-routing + API are Wave 4, NOT wired here):
          * tuning_store    — the auto-tuning audit/rollback ledger (never writes a case).
          * campaign_store  — the cross-case campaign list (references case ids only, #4).
          * baseline_store  — the anomaly-baseline sketch state (pure math, #3-safe).
          * batch_job_store — durable async LLM batch-job tracking (exactly-once #6).
        None feeds the deterministic ``case_manager.decide()`` (#3); none recomputes a
        ``cluster_signature`` (#4)."""
        from .stores.baseline import BaselineStore
        from .stores.batch_jobs import BatchJobStore
        from .stores.campaigns import CampaignStore
        from .stores.tuning import TuningStore

        kv = self._kv
        self.tuning_store = TuningStore(kv)
        self.campaign_store = CampaignStore(kv)
        self.baseline_store = BaselineStore(kv)
        self.batch_job_store = BatchJobStore(kv)

    def _build_round5_stores(self) -> None:
        """Construct the Round-5 KV-backed stores over the active backend's KV (the SAME
        shared ``self._kv`` the Round-3/4 stores use — works on ES + SQL, no new
        index/table/migration). Each takes only ``self._kv`` so it survives every
        ``_wire()`` rebuild, exactly like ``_build_round4_stores`` above.

        * ``dashboards``   — G7 per-user custom-dashboard layouts (advisory presentation
                             state only).
        * ``rule_versions`` — G6 per-rule immutable version ledger + rollback (a
                             config-adjacent audit ledger; it never writes ``Preferences``
                             itself, never touches a case/verdict/signature, and NEVER
                             imports ``case_manager.decide()`` #3).

        NONE of these feeds the deterministic ``case_manager.decide()`` (#3); every
        dashboard/widget/rule name is PLAIN data the UI render-escapes (#9)."""
        from .stores.dashboards import DashboardStore
        from .stores.rule_versions import RuleVersionStore

        self.dashboards = DashboardStore(self._kv)
        self.rule_versions = RuleVersionStore(self._kv)

    def _build_round7_stores(self) -> None:
        """Construct the Round-7 KV-backed store over the active backend's KV (the SAME
        shared ``self._kv`` the Round-3/4/5 stores use — works on ES + SQL, no new
        index/table/migration). Built here so a live handle survives every ``_wire()``
        rebuild, exactly like ``_build_round5_stores`` above.

        * ``noise_counters`` — durable raw-alert-by-severity ingest counters backing the
          Noise-Reduction funnel ("total alerts by severity → what the AI reduced it to").

        ADVISORY accounting only: it NEVER feeds the deterministic ``case_manager.decide()``
        (#3), recomputes a ``cluster_signature`` (#4), or slows the poll/ingest path (its
        record path is fail-open)."""
        from .stores.noise_counters import NoiseCounterStore

        self.noise_counters = NoiseCounterStore(self._kv)

    @property
    def enrichment_registry(self):
        """The process-wide :class:`app.enrichment.registry.ProviderRegistry`
        singleton (lazy; static manifests, per-request instances). Exposed read-only
        for symmetry so routes can reach it via ``state.enrichment_registry`` without
        constructing or holding anything — it needs no secrets at construction."""
        from .enrichment import get_provider_registry

        return get_provider_registry()

    @property
    def event_bus(self):
        """The process-wide :class:`app.realtime.EventBus` singleton (in-process SSE
        transport). Survives ``_wire()`` rebuilds (module-global). Safe to publish to
        even when ``Preferences.realtime.enabled`` is False / there are no subscribers
        — the route gates serving with 204. Pure transport: #3 untouched, #6 N/A."""
        from .realtime import get_event_bus

        return get_event_bus()

    # ------------------------------------------------------------------ #
    # Round-4 Wave-3 services — LAZY, default-OFF, wired for Wave-4 to drive.
    #
    # Each is a thin, constructable/lazy accessor over the Wave-3 KV stores +
    # engine modules. NOTHING here starts a scheduler loop, reroutes an EVENT feed,
    # or makes an LLM call at construction — they are inert until a Wave-4 caller
    # (a route or a nightly loop) explicitly invokes them, AND each engine itself
    # no-ops unless its ``Preferences.{threshold_tuning,campaign,baseline,batch}``
    # block is enabled. None imports ``case_manager`` / calls ``decide()`` (#3) or
    # recomputes a ``cluster_signature`` (#4).
    # ------------------------------------------------------------------ #
    @property
    def threshold_tuner(self):
        """The deterministic nightly threshold-tuning observer, exposed as a bound
        ``run_once`` callable Wave-4 schedules. It reads CLOSED cases + the live
        ``Preferences.threshold_tuning`` block (default OFF → immediate no-op), writes
        only to the ``tuning_store`` ledger + the HITL Proposal queue, and persists any
        auto-applied config change through ``update_prefs`` (config-writer only). It
        NEVER runs at boot; a caller must invoke ``state.threshold_tuner(...)``.

        Signature mirrors ``engine.threshold_tuner.run_once`` with this AppState's
        stores/writer pre-bound: ``await state.threshold_tuner(prefs, cases, **kw)``."""
        from functools import partial

        from .engine.threshold_tuner import run_once as _run_once

        return partial(
            _run_once,
            proposals=self.proposals,
            audit=self._real_audit,
            tuning_store=self.tuning_store,
            write_prefs=self.update_prefs,
        )

    @property
    def campaign_correlator(self):
        """The deterministic cross-case CAMPAIGN pass, exposed as a bound
        ``correlate_campaigns`` callable Wave-4 schedules. It is a read-time aggregator
        over already-persisted cases (default OFF via ``Preferences.campaign`` — the
        Wave-4 caller gates on it), upserted into ``campaign_store``. It NEVER
        investigates, mutates a case, calls an LLM (#6), or touches ``decide()`` (#3).

        Call as ``await state.campaign_correlator(cases, prefs)`` (pass ``cases=None``
        + this AppState's case store to page the trailing window)."""
        from functools import partial

        from .engine.campaigns import correlate_campaigns

        return partial(correlate_campaigns, cases_store=self.cases)

    def build_baseline_engine(self):
        """Construct a fresh streaming anomaly-BASELINE model from the live
        ``Preferences.baseline`` config (default OFF). Pure math advisory PRODUCER — it
        holds per-(signature, bucket) sketches in memory and is warmed/flushed via the
        ``baseline_store`` snapshot/restore bridge by the Wave-4 caller. NOTHING runs at
        construction; #3/#4/#6-safe. A fresh instance per call (the caller owns warming
        it from ``baseline_store.snapshot()``)."""
        from .engine.baseline import BaselineEngine

        return BaselineEngine(getattr(self.prefs, "baseline", None))

    def build_batch_provider(self, name: str):
        """Construct a batch-inference provider (``anthropic`` | ``openai``) with this
        deployment's API key + any ``base_url`` override, for the Wave-4 batch service to
        submit/poll. Reads ``self.secrets`` live; makes NO network call at construction.
        Raises ``KeyError`` on an unknown provider name."""
        from .llm.batch import make_batch_provider

        key = ""
        base_url = None
        if name == "anthropic":
            key = self.secrets.anthropic_api_key or ""
        elif name == "openai":
            key = self.secrets.openai_api_key or ""
            base_url = getattr(self.secrets, "openai_base_url", None) or None
        return make_batch_provider(name, api_key=key, base_url=base_url)

    @property
    def batch_service(self):
        """The durable BATCH-inference service (submit / poll / process), lazily built
        over the ``batch_job_store`` + the batch-provider factory + the ONE LLM gateway
        ledger (#6 — exactly one UsageDoc per result, deduped by ``custom_id``). Default
        OFF via ``Preferences.batch``; the Wave-4 caller gates + drives it. Nothing runs
        at boot; the service holds no open connections until ``submit``/``poll`` is
        called. Memoised on the AppState (rebuilt on ``_wire()`` since it references the
        rebuilt store/gateway)."""
        svc = getattr(self, "_batch_service", None)
        if svc is None:
            svc = _BatchJobService(
                store=self.batch_job_store,
                gateway=self.gateway,
                make_provider=self.build_batch_provider,
                get_prefs=self.get_prefs,
                reenter=self._reenter_detections,
            )
            self._batch_service = svc
        return svc

    # ------------------------------------------------------------------ #
    # Round-4 Wave-4 — EVENT-feed detection-funnel driver + gated schedulers.
    # ------------------------------------------------------------------ #
    async def _route_event_feed(self, events: list, prefs: Preferences) -> None:
        """Route one EVENT feed's batch through the detection funnel (Wave-4).

        The poller calls this ONLY when batch + baseline are both enabled (it gates
        before calling). We run the cheap-first funnel (aggregate→rules→anomaly) over a
        long-lived, warmed baseline model, turn the survivors into an aggregate-only,
        fenced BATCH request set (#7/#9), and SUBMIT it out-of-band to the batch service
        (the batch-jobs scheduler later polls + folds the confirmations back into the
        SAME correlate→pipeline path, #4). Best-effort + never raises — a funnel/batch
        glitch degrades to "nothing routed" (the events were already correlated out of
        the realtime path by design; a missed batch just means no anomaly candidate this
        tick, never a dropped/duplicated case)."""
        if not events:
            return
        from .engine import event_detection as evdet

        try:
            baseline = await self._ensure_funnel_baseline()
            candidates = evdet.funnel(events, prefs, baseline)
            # Persist the warmed sketches back so the baseline keeps improving across
            # polls/restarts (the funnel folded EVERY bucket's observation in above).
            await self._flush_funnel_baseline(baseline, candidates, events)
            if not candidates:
                return
            requests = evdet.build_batch(candidates, prefs)
            if not requests:
                return
            model = evdet.model_for_funnel(prefs)
            provider = self._funnel_batch_provider(prefs)
            # Persist the survivors (aggregate summary + member events + detection_source)
            # keyed by custom_id ALONGSIDE the BatchJob, so the batch scheduler can rebuild
            # them and re-enter the pipeline (same cluster_signature #4) when the
            # confirmations return. The member events never enter the batch prompt (#7).
            serialised = {c.custom_id: evdet.candidate_to_json(c) for c in candidates}
            await self.batch_service.submit(provider, model, requests, candidates=serialised)
        except Exception as exc:  # noqa: BLE001 — the funnel must never break a poll cycle
            logger.warning("event-detection funnel run failed: %s", exc)

    async def _reenter_detections(self, job, results) -> int:
        """Re-enter LLM-CONFIRMED event-detections into the SAME pipeline path (#4/#3).

        Called by the batch scheduler AFTER ``process_results`` records the ledger (#6).
        Reconstructs the persisted funnel candidates for THIS job, maps the batch results
        (by ``custom_id``) onto the confirmed ones via
        :func:`event_detection.results_to_candidates` (fail-closed: an unconfirmed /
        unparseable result is NOT re-entered), and feeds each confirmed cluster through the
        EXISTING pipeline entry — ``register_candidate`` (idempotent, visible, $0) then
        ``investigate_cluster`` — so it acquires the SAME ``cluster_signature`` the normal
        correlate path would (#4), attaches to any open case for that signature, and runs
        the UNCHANGED deterministic ``decide()`` inside ``investigate_cluster`` (#3 — this
        method NEVER calls decide() directly). An entirely-suppressed cluster is dropped
        (the same defence-in-depth gate the realtime path uses). Best-effort + never
        raises; returns the number of clusters investigated (for logs/tests).

        Gated by the same default-OFF batch/detection toggle as the funnel; a job with no
        persisted candidates (a plain investigation batch) re-enters nothing."""
        from .constants import SourceSurface
        from .engine import event_detection as evdet
        from .engine.cost_gate import passes_suppression

        prefs = self.prefs
        if not (getattr(getattr(prefs, "batch", None), "enabled", False)
                and getattr(getattr(prefs, "baseline", None), "enabled", False)):
            return 0
        raw_candidates = getattr(job, "candidates", None) or {}
        if not raw_candidates:
            return 0
        try:
            candidates = []
            for raw in raw_candidates.values():
                cand = evdet.candidate_from_json(raw)
                if cand is not None:
                    candidates.append(cand)
            if not candidates:
                return 0
            results_by_id = {}
            for res in results or []:
                cid = str(getattr(res, "custom_id", "") or "")
                if cid:
                    results_by_id[cid] = res
            confirmed = evdet.results_to_candidates(candidates, results_by_id)
            if not confirmed:
                return 0
            count = 0
            for cluster, _src in confirmed:
                # Defence-in-depth: an entirely-suppressed cluster is the intended drop
                # (same gate the realtime handle_clusters walks). NEVER drops a single
                # below-floor event (#4) — that concept doesn't apply to a confirmed
                # aggregate detection.
                if not passes_suppression(cluster, prefs):
                    continue
                # register_candidate makes the case idempotent + visible ($0);
                # investigate_cluster runs the ReAct investigation + the UNCHANGED decide()
                # and dedups on the same signature (one open case per signature, #4).
                await self._real_pipeline.register_candidate(
                    cluster, SourceSurface.AUTOMATED_SCAN, prefs)
                await self._real_pipeline.investigate_cluster(
                    cluster, SourceSurface.AUTOMATED_SCAN, prefs)
                count += 1
            return count
        except Exception as exc:  # noqa: BLE001 — re-entry must never break a batch tick
            logger.warning("event-detection re-entry failed for job %s: %s", getattr(job, "id", "?"), exc)
            return 0

    async def _ensure_funnel_baseline(self):
        """The single long-lived streaming baseline behind the funnel, warmed from the
        persistent baseline_store on first build so the anomaly pass carries history
        across restarts. Built lazily; rebuilt (None) on _wire()."""
        if self._funnel_baseline is None:
            engine = self.build_baseline_engine()
            try:
                series = await self.baseline_store.snapshot()
                for sig, buckets in (series or {}).items():
                    engine.restore(sig, buckets)
            except Exception as exc:  # noqa: BLE001 — a cold baseline is fine
                logger.debug("funnel baseline warm-from-store failed (%s); cold start", exc)
            self._funnel_baseline = engine
        return self._funnel_baseline

    async def _flush_funnel_baseline(self, baseline, candidates, events) -> None:
        """Persist the sketches the funnel just touched back to the baseline_store so
        the base improves over time (#4-safe: the store only keys by signature, never a
        cluster_signature recompute). Best-effort; only the signatures observed this
        tick are re-written."""
        try:
            seen: set[str] = set()
            for c in candidates:
                seen.add(c.signature)
            # Also flush any signature the pre-aggregate observed (candidates are a
            # subset; the full observed set warms the base even for benign buckets).
            for sig in seen:
                snap = baseline.snapshot(sig)
                if snap:
                    await self.baseline_store.put(sig, snap)
        except Exception as exc:  # noqa: BLE001 — persistence is best-effort
            logger.debug("funnel baseline flush failed (%s)", exc)

    def _funnel_batch_provider(self, prefs: Preferences) -> str:
        """Pick the batch provider for the funnel: the first configured
        ``prefs.batch.providers`` entry this deployment has a key for, else 'anthropic'
        (the locked default). Read-only; makes no network call."""
        providers = list(getattr(getattr(prefs, "batch", None), "providers", []) or [])
        for name in providers:
            if name == "anthropic" and (self.secrets.anthropic_api_key or self._provider_overrides):
                return "anthropic"
            if name == "openai" and (self.secrets.openai_api_key or self._provider_overrides):
                return "openai"
        return providers[0] if providers else "anthropic"

    async def _run_schedulers(self) -> None:
        """Start the gated Wave-4 background schedulers (idempotent).

        Three loops modelled on the poller lifecycle: a nightly threshold-tuner pass, a
        daily campaign-correlation pass, and a batch-jobs poller loop. Each is a
        long-running task that, per tick, re-checks its gate flags (feature enabled +
        polling context + not kill_switch + not demo-active) and NO-OPs when its config is
        disabled — so with every toggle OFF (the default) all three sleep, byte-identical
        to a boot with no schedulers. Started once; cancelled in shutdown()."""
        if self._scheduler_running:
            return
        self._scheduler_running = True
        self._scheduler_tasks = [
            asyncio.create_task(self._tuner_scheduler_loop()),
            asyncio.create_task(self._campaign_scheduler_loop()),
            asyncio.create_task(self._batch_scheduler_loop()),
        ]
        logger.info("Round-4 Wave-4 schedulers started (all gated OFF by default)")

    def _schedulers_gated_off(self) -> bool:
        """The shared gate every scheduler tick honours BEFORE doing any real work:
        never run while polling is paused / setup incomplete / the kill-switch is on /
        demo mode is engaged (so no real scheduler ever fires against demo data or a
        half-configured tenant). Demo keeps ALL real schedulers OFF."""
        prefs = self.prefs
        demo_active = bool(getattr(getattr(prefs, "demo", None), "active", False))
        return (
            not prefs.polling_enabled
            or not prefs.setup_complete
            or bool(getattr(prefs.caps, "kill_switch", False))
            or demo_active
        )

    # How long a tuning cadence window is (seconds) — the scheduler runs run_once AT MOST
    # once per window regardless of the 6h tick, so a rule is never re-raised every tick
    # (FINDING #14). ``manual`` is instant (an operator triggered it explicitly).
    _TUNER_CADENCE_SECONDS = {
        "hourly": 3600,
        "nightly": 24 * 3600,
        "weekly": 7 * 24 * 3600,
        "manual": 0,
    }

    async def _tuner_scheduler_loop(self) -> None:
        """Nightly threshold-tuning pass. Gated on ``prefs.threshold_tuning.enabled``;
        a disabled config makes this a pure sleep loop (NO-OP). Calls the bound
        ``threshold_tuner`` run_once (which itself never calls decide() and only writes
        the tuning ledger / HITL proposals / bounded config knobs). Never closes a case.

        The loop ticks every 6h but run_once fires AT MOST once per configured cadence
        window (``last_run_at`` in the tuning_store): a nightly cadence never re-raises the
        same knob four times a day (FINDING #14 — unbounded n growth)."""
        interval = 6 * 3600
        while self._scheduler_running:
            try:
                cfg = getattr(self.prefs, "threshold_tuning", None)
                if (
                    cfg is not None and cfg.enabled
                    and not self._schedulers_gated_off()
                    and await self._tuner_cadence_elapsed(cfg)
                ):
                    await self.threshold_tuner(
                        self.prefs, self._closed_case_reader(),
                    )
                    # Stamp the effective run so the next tick within the window no-ops.
                    try:
                        await self.tuning_store.set_last_run_at()
                    except Exception as exc:  # noqa: BLE001 — best-effort cadence bookkeeping
                        logger.debug("tuner last_run stamp failed: %s", exc)
            except Exception as exc:  # noqa: BLE001 — the loop must never die
                logger.warning("threshold-tuner scheduler tick failed: %s", exc)
            await asyncio.sleep(interval)

    async def _tuner_cadence_elapsed(self, cfg) -> bool:
        """True when the configured tuning cadence window has elapsed since the last
        effective run (so run_once fires at most once per cadence, FINDING #14). A missing
        / unparseable last_run is treated as "run now"; a read glitch fails OPEN (run) so a
        store outage never silently freezes tuning forever."""
        window = self._TUNER_CADENCE_SECONDS.get(getattr(cfg, "cadence", "nightly"), 24 * 3600)
        if window <= 0:
            return True
        try:
            last_iso = await self.tuning_store.get_last_run_at()
        except Exception:  # noqa: BLE001 — fail OPEN (run) on a read glitch
            return True
        if not last_iso:
            return True
        from datetime import datetime, timezone

        try:
            last = datetime.fromisoformat(str(last_iso).replace("Z", "+00:00"))
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
        except (ValueError, TypeError):
            return True
        elapsed = (datetime.now(timezone.utc) - last).total_seconds()
        return elapsed >= window

    async def _campaign_scheduler_loop(self) -> None:
        """Daily cross-case campaign-correlation pass. Gated on ``prefs.campaign.enabled``;
        disabled → a pure sleep loop (NO-OP). Runs the DETERMINISTIC read-time aggregator
        and upserts the campaign list; it NEVER investigates, mutates a case, or calls
        decide()/an LLM."""
        interval = 6 * 3600
        while self._scheduler_running:
            try:
                cfg = getattr(self.prefs, "campaign", None)
                if cfg is not None and cfg.enabled and not self._schedulers_gated_off():
                    campaigns = await self.campaign_correlator(None, self.prefs)
                    if campaigns:
                        await self.campaign_store.upsert_many(campaigns)
            except Exception as exc:  # noqa: BLE001 — the loop must never die
                logger.warning("campaign scheduler tick failed: %s", exc)
            await asyncio.sleep(interval)

    async def _batch_scheduler_loop(self) -> None:
        """Batch-jobs poller loop. Gated on ``prefs.batch.enabled``; disabled → a pure
        sleep loop (NO-OP). Polls every OPEN durable BatchJob, processes any completed
        results through the ONE gateway ledger (exactly-once #6), and re-enters each
        LLM-CONFIRMED detection as a candidate cluster on the SAME correlate→pipeline
        path (which runs the unchanged decide()); it never closes a case here."""
        interval = 120
        while self._scheduler_running:
            try:
                svc = self.batch_service
                if svc.enabled() and not self._schedulers_gated_off():
                    open_jobs = await svc.store.load_open_jobs()
                    for job in open_jobs:
                        try:
                            polled = await svc.poll(job)
                            await svc.process(polled)
                        except Exception as exc:  # noqa: BLE001 — isolate one job
                            logger.debug("batch job %s poll/process failed: %s", job.id, exc)
            except Exception as exc:  # noqa: BLE001 — the loop must never die
                logger.warning("batch-jobs scheduler tick failed: %s", exc)
            await asyncio.sleep(interval)

    def _closed_case_reader(self):
        """An async ``read(limit, offset) -> list[Case]`` pager over the TERMINAL cases
        (CLOSED **and** RESOLVED) for the threshold-tuner (which pages it, never a naive
        200-cap). Confirmed true-positives are frequently RESOLVED (worked to completion,
        pending final close) rather than CLOSED, so a CLOSED-only reader would leave
        shadow-eval blind to them and defeat the TP-protection rail (FINDING #4). We mirror
        ``routes_tuning._closed_reader``'s scope exactly. Best-effort: a store glitch on one
        status yields an empty page for it (the tuner then just sees fewer cases)."""
        from .constants import TERMINAL_CASE_STATUSES

        async def _read(limit: int, offset: int):
            collected = []
            for status in TERMINAL_CASE_STATUSES:
                try:
                    page, _total = await self.cases.list(
                        status=status, limit=limit, offset=offset,
                        sort_field="updated_at", sort_order="desc",
                    )
                except Exception:  # noqa: BLE001 — a read glitch never breaks tuning
                    continue
                collected.extend(page)
            return collected

        return _read

    async def _stop_schedulers(self) -> None:
        """Cancel the Wave-4 schedulers cleanly (shutdown). Idempotent."""
        self._scheduler_running = False
        tasks = self._scheduler_tasks
        self._scheduler_tasks = []
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass

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

    def schedule_close(self, client) -> None:
        """Public alias for :meth:`_schedule_close` — the ``PollerHost`` seam the
        multi-source poller uses to close a per-source ES client it owns (Round 5)."""
        self._schedule_close(client)

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
        scoped ES client, so this is behaviour-identical for those two.)

        Round 4: also rebuild the PollerManager's per-source fan-out so an added /
        removed / re-primaried source is polled (or stops being polled) immediately —
        ``rebuild()`` re-points the primary child at the fresh ``log_source`` and
        rebuilds every non-primary child (closing any owned clients, no leak)."""
        self.log_source = self._build_log_source()
        self.poller._source = self.log_source
        self._real_pipeline._source = self.log_source
        self._real_chat_engine._source = self.log_source
        try:
            self.poller.rebuild()
        except Exception as exc:  # noqa: BLE001 — fan-out rebuild must never break a source edit
            logger.warning("Poller fan-out rebuild failed (%s); continuing", exc)
        # Round-4 Wave-4: rebuild() minted a FRESH primary Poller (via _build_primary),
        # which does not carry the EVENT-feed funnel hook — re-attach it so a source edit
        # keeps EVENT-feed routing wired. Best-effort; a missing hook only means routing
        # stays off (byte-identical realtime path).
        try:
            self.poller._primary._event_funnel = self._route_event_feed
        except Exception as exc:  # noqa: BLE001
            logger.debug("re-attaching event-funnel hook after rebuild failed (%s)", exc)

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
        # Round 4: now that the PERSISTED prefs (incl. configured sources) are loaded,
        # re-point the primary log surface + (re)build the PollerManager fan-out so a
        # deployment that boots WITH multiple persisted PULL sources polls ALL of them,
        # not just the primary. Byte-identical for the 0/1-source case (the fallback
        # connector is rebuilt identically). Best-effort — never blocks startup.
        try:
            self.rebuild_log_source()
        except Exception as exc:  # noqa: BLE001 — never block startup on a source rebuild
            logger.warning("Log-source / poller rebuild on startup failed (%s); continuing", exc)
        # Round-3 Wave-1: apply the operator's realtime heartbeat cadence onto the
        # process-wide EventBus singleton (idempotent, tolerates None). The bus is a
        # default-OFF transport — publishing is always safe; the /api/events endpoint
        # gates serving on Preferences.realtime.enabled. Never blocks startup.
        try:
            from .realtime import configure_event_bus

            configure_event_bus(getattr(self.prefs, "realtime", None))
        except Exception as exc:  # noqa: BLE001 — realtime config is best-effort
            logger.warning("Realtime bus configuration failed (%s); continuing", exc)
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
            # Round-4 Wave-4: start the gated background schedulers alongside the poller.
            # All three loops are NO-OPs until their Preferences block is enabled (default
            # OFF), so this is byte-identical to a boot with no schedulers. Started under
            # the SAME ``start_poller`` guard the offline tests already use to skip
            # background tasks, so the test suite never spawns them unless asked.
            await self._run_schedulers()
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
        # Keep the realtime EventBus heartbeat cadence live after a settings change
        # (Round-3 Wave-1). Idempotent + best-effort; never blocks a prefs write.
        try:
            from .realtime import configure_event_bus

            configure_event_bus(getattr(prefs, "realtime", None))
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
        alert_interval_seconds: float | None = None,
        event_rate_per_second: float | None = None,
        preseed_recent_minutes: int | None = None,
        preseed_case_count: int | None = None,
        preseed_event_count: int | None = None,
        force_capabilities: bool | None = None,
    ) -> dict:
        """Engage demo mode: stamp a run_id, build the isolated stack, pre-generate a
        backdated historical case spread + a tight "just happened" pre-seed (recent
        cases + already-processed events), eagerly seed the shared RAG corpus, run one
        demo-local capability pass, and (in ``live``) start the simulator. If a demo is
        already running it is disabled first (clean re-seed)."""
        from .config import DemoConfig
        from .engine.demo_generator import (
            build_org, generate_historical_cases, generate_recent_preseed, hits_to_raw,
        )
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
            alert_interval_seconds=float(
                alert_interval_seconds if alert_interval_seconds is not None
                else cur.alert_interval_seconds),
            event_rate_per_second=float(
                event_rate_per_second if event_rate_per_second is not None
                else cur.event_rate_per_second),
            preseed_recent_minutes=int(
                preseed_recent_minutes if preseed_recent_minutes is not None
                else cur.preseed_recent_minutes),
            preseed_case_count=int(
                preseed_case_count if preseed_case_count is not None
                else cur.preseed_case_count),
            preseed_event_count=int(
                preseed_event_count if preseed_event_count is not None
                else cur.preseed_event_count),
            force_capabilities=bool(
                force_capabilities if force_capabilities is not None
                else cur.force_capabilities),
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

        # Eagerly seed the SHARED demo RAG corpus so the Knowledge page shows a populated
        # corpus immediately (idempotent; picks up any CLOSED demo cases too).
        try:
            await self._demo.rag_service.ensure_seeded()
        except Exception as exc:  # noqa: BLE001 — a cold RAG never breaks enable
            logger.debug("demo RAG eager-seed failed: %s", exc)

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

        # Pre-seed a tight "just happened" window: a varied trio of recent cases (1
        # TP-escalate, 1 NEEDS_HUMAN, 1 FP — not all terminal) + ~100 events already
        # batch-processed (fed through ingest ONCE so they count as ingested/correlated
        # volume in the noise-reduction/metrics surfaces, not decoration).
        recent_cases, recent_hits = generate_recent_preseed(
            new_demo.seed, org, run_id=new_demo.run_id, now_millis=now_ms,
            recent_minutes=new_demo.preseed_recent_minutes,
            case_count=new_demo.preseed_case_count,
            event_count=new_demo.preseed_event_count,
        )
        for case in recent_cases:
            self._write_guard(case, demo=True)
            await self._demo.cases.save(case)
        # Count the ~100 pre-seed events as ALREADY-processed ingested volume in the
        # DEMO noise-reduction counters (benign noise the AI already cleared → ingested,
        # not clustered). We record a DETERMINISTIC counter delta instead of running the
        # case-creating pipeline over them: the realtime EVERY,n=1 path would mint a
        # VARIABLE number of ``case-<uuid>`` cases (non-deterministic ids + count),
        # breaking the demo's determinism guarantees. This keeps the "already
        # batch-processed" volume visible without polluting the case list.
        if recent_hits:
            try:
                from .engine import noise_counters as nc

                dprefs = self._demo._demo_prefs()  # noqa: SLF001 — same module owner
                raws = hits_to_raw(recent_hits, dprefs)
                ingested = nc.count_events_by_band(raws, "ocsf_0_100")
                await self._demo.noise_counters.record({
                    "ingested": ingested, "clustered": nc.zero_bands(),
                    "suppressed": 0, "ignored": 0,
                })
                self._demo.preseed_events = len(raws)
            except Exception as exc:  # noqa: BLE001 — a bad pre-seed count never breaks enable
                logger.warning("demo pre-seed event counting failed: %s", exc)

        # Capability seeding: make the HITL / campaign / adaptive-tuning capabilities show
        # REAL signal on a fresh enable (previously only RAG did). Deterministic + demo-
        # scoped — a shared-entity NEEDS_HUMAN pair (→ fired threshold-automation opens
        # HITL proposals AND the pair folds into >= 1 campaign) plus a block of same-rule
        # CLOSED false-positives (→ the tuner clears its min-samples/Wilson-LB bar and
        # records one bounded observation). Every write lands in the DEMO stores; the real
        # HITL/tuning/campaign ledgers are untouched. Gated on force_capabilities because
        # the seeded automation rule + the tuner/campaign blocks are only forced ON there.
        if new_demo.force_capabilities:
            try:
                from .engine.demo_generator import generate_capability_seed_cases

                hitl_cases, tuner_cases = generate_capability_seed_cases(
                    new_demo.seed, org, run_id=new_demo.run_id, now_millis=now_ms,
                )
                for case in (*hitl_cases, *tuner_cases):
                    self._write_guard(case, demo=True)
                    await self._demo.cases.save(case)
                # Fire threshold-automation on the NEEDS_HUMAN pair → >= 1 demo HITL proposal
                # (deterministic, $0 — runs on the already-saved demo cases; no LLM).
                await self._demo.seed_hitl_proposals(hitl_cases)
            except Exception as exc:  # noqa: BLE001 — capability seeding never blocks enable
                logger.warning("demo capability seeding failed: %s", exc)

        # Run ONE synchronous capability pass so even a 'seeded' demo (no ticker) shows a
        # campaign + a tuning observation immediately.
        try:
            await self._demo.run_capability_pass()
        except Exception as exc:  # noqa: BLE001 — never break enable on a capability pass
            logger.debug("demo initial capability pass failed: %s", exc)

        # Start the live simulator (only ticks in 'live' mode).
        if new_demo.mode == "live":
            self._demo_sim = DemoSimulator(self._demo, self.get_prefs, seed=new_demo.seed)
            self._demo_sim.start()
        logger.info("Demo mode ENABLED (mode=%s run_id=%s seeded %d + %d recent cases)",
                    new_demo.mode, new_demo.run_id, len(cases), len(recent_cases))
        return await self.demo_status()

    async def reset_demo(self) -> dict:
        """Delete the current demo data + re-seed from the SAME seed/run knobs (a
        fresh run_id). A no-op error-path when demo is not active."""
        cur = getattr(self.prefs, "demo", None)
        if self._demo is None or cur is None or not cur.active:
            return await self.demo_status()
        mode, seed = cur.mode, cur.seed
        hd, ts, tj, ir = cur.history_days, cur.tick_seconds, cur.tick_jitter, cur.incident_rate
        # Carry ALL the overhaul fields through the disable→enable round-trip so a reset
        # never silently drops them back to the DemoConfig defaults.
        ais, erps = cur.alert_interval_seconds, cur.event_rate_per_second
        prm, pcc, pec = cur.preseed_recent_minutes, cur.preseed_case_count, cur.preseed_event_count
        fc = cur.force_capabilities
        await self.disable_demo()
        return await self.enable_demo(
            mode=mode, seed=seed, history_days=hd, tick_seconds=ts,
            tick_jitter=tj, incident_rate=ir,
            alert_interval_seconds=ais, event_rate_per_second=erps,
            preseed_recent_minutes=prm, preseed_case_count=pcc, preseed_event_count=pec,
            force_capabilities=fc,
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
        proposals_open = 0
        campaigns_found = 0
        tuning_events = 0
        rag_chunks = 0
        sources: list[str] = []
        if self._demo is not None:
            try:
                _cases, case_count = await self._demo.cases.list(limit=1)
            except Exception:  # noqa: BLE001
                case_count = 0
            # Per-capability signal so the UI can show "these are live" (all best-effort).
            try:
                proposals_open = await self._demo.open_proposal_count()
            except Exception:  # noqa: BLE001
                proposals_open = 0
            try:
                # CampaignStore.list() returns (page, total).
                _cpage, campaigns_found = await self._demo.campaign_store.list()
                campaigns_found = int(campaigns_found)
            except Exception:  # noqa: BLE001
                campaigns_found = 0
            try:
                tuning_events = len(await self._demo.tuning_store.list())
            except Exception:  # noqa: BLE001
                tuning_events = 0
            try:
                rag_chunks = int((await self._demo.vectorstore.stats()).get("total_chunks", 0))
            except Exception:  # noqa: BLE001
                rag_chunks = 0
            try:
                sources = list(self._demo.sources.keys())
                from .engine.demo_generator import SEGMENT_SOURCE_IDS
                sources = [SEGMENT_SOURCE_IDS.get(s, s) for s in sources]
            except Exception:  # noqa: BLE001
                sources = []
        return {
            "mode": mode,
            "active": bool(demo and demo.active),
            "run_id": run_id,
            "seed": getattr(demo, "seed", 0) if demo else 0,
            "history_days": getattr(demo, "history_days", 0) if demo else 0,
            "tick_seconds": getattr(demo, "tick_seconds", 0.0) if demo else 0.0,
            "incident_rate": getattr(demo, "incident_rate", 0.0) if demo else 0.0,
            "alert_interval_seconds": getattr(demo, "alert_interval_seconds", 0.0) if demo else 0.0,
            "event_rate_per_second": getattr(demo, "event_rate_per_second", 0.0) if demo else 0.0,
            "preseed_recent_minutes": getattr(demo, "preseed_recent_minutes", 0) if demo else 0,
            "preseed_case_count": getattr(demo, "preseed_case_count", 0) if demo else 0,
            "preseed_event_count": getattr(demo, "preseed_event_count", 0) if demo else 0,
            "force_capabilities": bool(getattr(demo, "force_capabilities", True)) if demo else True,
            "simulator_running": self._demo_sim is not None,
            "case_count": case_count,
            "preseed_events": int(getattr(self._demo, "preseed_events", 0)) if self._demo else 0,
            "proposals_open": proposals_open,
            "campaigns_found": campaigns_found,
            "tuning_events": tuning_events,
            "rag_chunks": rag_chunks,
            "sources": sources,
        }

    def demo_sources_overlay(self) -> list[dict]:
        """The three demo sources shaped like a ``SourceInstance.model_dump`` for the
        read-time-only overlay on GET /api/sources + /sources/health. Built PURELY from
        the live ``DemoStack`` — NEVER written into ``Preferences.sources`` (so the real
        PollerManager / PUT /api/settings / the wizard never see them). Returns ``[]``
        when demo is off. Collision-guarding against a real source id is the caller's
        job (see routes.list_sources / sources_health)."""
        if self._demo is None:
            return []
        from .engine.demo_generator import (
            DEMO_INDEX, SEGMENT_CATEGORIES, SEGMENT_SOURCE_IDS, SEGMENT_SOURCE_NAMES,
        )

        rows: list[dict] = []
        for seg in self._demo.sources:
            sid = SEGMENT_SOURCE_IDS.get(seg, f"demo-{seg}")
            rows.append({
                "id": sid,
                "display_name": SEGMENT_SOURCE_NAMES.get(seg, sid),
                "source_type": "generic",
                "category": SEGMENT_CATEGORIES.get(seg, "siem"),
                "enabled": True,
                "is_primary": False,
                "ingest_mode": "pull",
                "demo": True,
                "config": {"data_view_pattern": DEMO_INDEX},
                "configured_secrets": [],
            })
        return rows

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
            await self._stop_schedulers()
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


class _BatchJobService:
    """Durable BATCH-inference service (Round-4 Wave-3 — submit / poll / process).

    A THIN orchestrator that ties the batch-provider SPI (``llm/batch.py``) to the
    durable :class:`app.stores.batch_jobs.BatchJobStore` + the ONE LLM gateway ledger.
    It is INERT until Wave-4 calls it: constructing it opens no connection and reads no
    network; each provider is built on demand and closed after use.

    Ledger invariant (#6): result folding is delegated to
    ``BatchJobStore.process_results`` which writes EXACTLY ONE ``UsageDoc`` per result
    (deduped by ``custom_id``, at the 0.5× batch rate) — so a re-poll/restart never
    double-writes. It NEVER imports ``case_manager`` / calls ``decide()`` (#3) — folding
    verdict text into cases is the pipeline's job downstream."""

    def __init__(self, *, store, gateway, make_provider, get_prefs, reenter=None) -> None:
        self._store = store
        self._gateway = gateway
        self._make_provider = make_provider
        self._get_prefs = get_prefs
        # Optional ``async reenter(job, results) -> int`` hook: re-enters LLM-CONFIRMED
        # event-detections into the SAME correlate→pipeline path (#4/#3). None → results
        # are only billed (a plain investigation batch), never re-entered here.
        self._reenter = reenter

    @property
    def store(self):
        return self._store

    def enabled(self) -> bool:
        """Whether batch inference is turned on (``Preferences.batch.enabled``). Wave-4
        gates on this; default OFF so nothing routes to batch out of the box."""
        return bool(getattr(getattr(self._get_prefs(), "batch", None), "enabled", False))

    async def submit(self, provider: str, model: str, requests: list[dict], *, candidates=None):
        """Submit a batch to ``provider`` and PERSIST the resulting job (resume-safe).
        Returns the stored :class:`app.models.BatchJob`.

        ``candidates`` — an optional ``{custom_id -> serialised CandidateAlert}`` map for an
        EVENT-detection batch. Persisted onto the job so :meth:`process` can reconstruct
        the survivors and RE-ENTER the pipeline (same-signature cluster #4) when the
        confirmations return. None/empty for a plain investigation batch."""
        prov = self._make_provider(provider)
        try:
            job = await prov.submit(model, requests)
        finally:
            await prov.aclose()
        if candidates:
            job.candidates = dict(candidates)
        return await self._store.save(job)

    async def poll(self, job):
        """Refresh one job's state from its provider and persist it. Returns the job."""
        prov = self._make_provider(job.provider)
        try:
            job = await prov.poll(job)
        finally:
            await prov.aclose()
        return await self._store.save(job)

    async def process(self, job, *, role: str = "investigator", surface: str = "batch"):
        """Stream a completed job's results, fold them through the ONE gateway ledger
        EXACTLY once (deduped by ``custom_id``, #6), then RE-ENTER any LLM-CONFIRMED
        event-detection into the SAME correlate→pipeline path (#4/#3) via the injected
        ``reenter`` hook. Returns the newly-recorded results.

        Only the NEWLY-recorded (first-seen) succeeded results are handed to ``reenter``,
        so a re-poll / restart re-enters each confirmed detection at most once (the ledger
        dedup and the re-entry are driven by the same first-retrieval event). Re-entry is
        best-effort and never blocks the ledger fold."""
        prov = self._make_provider(job.provider)
        try:
            results = list(await prov.results(job))
        finally:
            await prov.aclose()
        recorded = await self._store.process_results(
            job, results, self._gateway, role=role, surface=surface
        )
        if self._reenter is not None and recorded:
            try:
                await self._reenter(job, recorded)
            except Exception:  # noqa: BLE001 — re-entry never breaks the ledger fold
                pass
        return recorded


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
