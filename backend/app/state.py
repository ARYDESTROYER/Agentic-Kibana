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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

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
        # Background receiver runtime is started only with the production poller.
        # Source CRUD may happen in test/demo states created with
        # ``start_poller=False``; those states must not unexpectedly bind sockets or
        # start broker clients.  In a normal runtime, CRUD calls reconcile the live
        # receiver set immediately through this gate.
        self._receivers_enabled = False
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
        # Serialize enable/reset/disable as one lifecycle transaction. Without this,
        # concurrent enables can each create a live ticker before the later request
        # overwrites the only reachable handle, leaking an orphan simulator.
        self._demo_lifecycle_lock = asyncio.Lock()
        # Seeded/manual demo actions share one non-started simulator so explicit ticks
        # and incident-trigger cooldowns retain deterministic logical time. Live mode
        # uses ``_demo_sim`` instead. Both are throwaway and stopped on disable.
        self._demo_incident_sim = None
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
        # Autopilot overhaul (A4): the long-lived REALTIME baseline PRODUCER — a SEPARATE
        # engine from the funnel one, fed every tick with per-cluster + per-source ingest
        # volume so the baseline learns from day one (advisory anomaly + silent-source /
        # flood detection). Warmed from baseline_store on first use; rebuilt on _wire().
        self._realtime_baseline = None
        # Per-source last-event wall clock (v0 flat silent-source check — works BEFORE the
        # baseline warm-up). Kept across _wire() rebuilds so a source edit never resets a
        # source's silence clock. Advisory only — never feeds decide() (#3).
        self._source_last_event: dict[str, datetime] = {}
        # Per-source count of NON-EMPTY observed ticks (how many times this source actually
        # delivered events). Kept across _wire() rebuilds like _source_last_event. Gates the
        # silent-source check (B3): only an ESTABLISHED source — one with a genuine activity
        # history — earns the raised long-quiet tolerance; a barely-seen / just-started
        # source keeps the conservative cold-start flat window. Advisory only — never feeds
        # decide() (#3).
        self._source_event_ticks: dict[str, int] = {}
        # Serialize preference writes. ``config_store.save`` is a full-document replace
        # with no CAS, and ``update_prefs`` assigns ``self.prefs`` outside any lock, so
        # two concurrent writers (e.g. an operator source edit racing the nightly
        # threshold-tuner's bounded-knob write) can interleave their save/assign and lose
        # an update — the symptom being a source rename that "did not persist". This lock
        # makes each write atomic, and ``mutate_prefs`` runs the read-modify-write under
        # it so a caller's edit is applied against the freshest prefs. Created in __init__
        # (not _wire) so it is a single stable lock across credential-driven rewires.
        self._prefs_lock = asyncio.Lock()
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
    def real_memory(self):
        return self._real_memory

    @property
    def real_proposals(self):
        return self._real_proposals

    @property
    def real_tuning_store(self):
        return self._real_tuning_store

    @property
    def real_campaign_store(self):
        return self._real_campaign_store

    @property
    def real_baseline_store(self):
        return self._real_baseline_store

    @property
    def real_batch_job_store(self):
        return self._real_batch_job_store

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
    def execution_audit(self):
        """Audit trail for active cases/agents (demo-swapped with the workload)."""
        return self.audit

    @property
    def control_audit(self):
        """Durable audit trail for auth, RBAC, secrets, users and real settings."""
        return self._real_audit

    @property
    def usage_store(self):
        return self._demo.usage_store if self._demo is not None else self._real_usage_store

    @property
    def memory(self):
        return self._demo.memory if self._demo is not None else self._real_memory

    @property
    def proposals(self):
        return self._demo.proposals if self._demo is not None else self._real_proposals

    @property
    def case_threads(self):
        return self._demo.case_threads if self._demo is not None else self._real_case_threads

    @property
    def case_activity(self):
        return self._demo.case_activity if self._demo is not None else self._real_case_activity

    @property
    def case_tasks(self):
        return self._demo.case_tasks if self._demo is not None else self._real_case_tasks

    @property
    def inbox(self):
        return self._demo.inbox if self._demo is not None else self._real_inbox

    @property
    def tuning_store(self):
        return self._demo.tuning_store if self._demo is not None else self._real_tuning_store

    @property
    def campaign_store(self):
        return self._demo.campaign_store if self._demo is not None else self._real_campaign_store

    @property
    def baseline_store(self):
        return self._demo.baseline_store if self._demo is not None else self._real_baseline_store

    @property
    def batch_job_store(self):
        """Active batch-job ledger; demo reads never expose durable tenant jobs."""
        return self._demo.batch_job_store if self._demo is not None else self._real_batch_job_store

    @property
    def shift_handoff(self):
        return self._demo.shift_handoff if self._demo is not None else self._real_shift_handoff

    @property
    def pipeline(self):
        return self._demo.pipeline if self._demo is not None else self._real_pipeline

    @property
    def execution_prefs(self) -> Preferences:
        """Prefs for whichever execution stack is currently active.

        Demo services must receive the sandbox copy, not the persisted tenant prefs:
        among other isolation controls it disables every network-backed enrichment
        provider while preserving the real configuration untouched.
        """
        return self._demo._demo_prefs() if self._demo is not None else self.prefs

    async def update_execution_prefs(self, prefs: Preferences) -> Preferences:
        """Persist normally, or keep the change inside the active demo sandbox."""
        if self._demo is not None:
            return await self._demo.update_execution_prefs(prefs)
        return await self.update_prefs(prefs)

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

    @property
    def noise_counters(self):
        # In demo, the Noise-Reduction funnel reads the DEMO counters so it reflects the
        # demo's ingested→clustered volume (the demo sink records into
        # ``DemoStack.noise_counters``); off demo, the real store — byte-identical.
        # The REAL poller/ingest sink always writes ``_real_noise_counters`` directly (see
        # ``_noise_and_baseline_sink``), so demo traffic never pollutes real counters and a
        # ``disable_demo`` purge of the demo store leaves real counters intact.
        return self._demo.noise_counters if self._demo is not None else self._real_noise_counters

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
            discounted_policy=lambda: self.prefs.batch,
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
        self._real_memory = self._build_memory()
        # Agent-DRAFTED proposals awaiting human approval (HITL). Backed by the SAME
        # KV as the MEMORY store — no new index/table/migration.
        self._real_proposals = self._build_proposals()
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
            source=self.log_source, playbooks=self.playbooks, memory=self._real_memory,
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
            source=self.log_source, memory=self._real_memory, threads=self._real_case_threads,
        )
        self._real_standup_service = StandupService(
            es, self.gateway, self._real_audit,
            cases=self._real_cases, shift_handoff=self._real_shift_handoff,
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
            inbox=self._real_inbox, notif_prefs=self.notif_prefs,
            users=self.users, event_bus=self.event_bus,
        )
        # Let the pipeline reach the dispatcher (post-save, fire-and-forget hook).
        self._real_pipeline.notifier = self.notifications

        # Threshold automation (F10 / Wave 6): post-decision, #3-safe. It runs AFTER
        # apply()+save and may ONLY tag/recommend/notify/queue a re-investigation
        # (which re-runs decide())/open a HITL Proposal — never set status/close.
        from .engine.threshold_automation import ThresholdAutomation

        self.automation = ThresholdAutomation(
            self._real_proposals, self._real_audit,
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
        # Autopilot overhaul (A4): reset the realtime baseline producer too so it re-warms
        # from the (possibly rebuilt) baseline_store on next observe. Cheap — it is lazily
        # rebuilt on first tick. The per-source silence clock (``_source_last_event``)
        # deliberately SURVIVES a rewire.
        self._realtime_baseline = None
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
            # Autopilot overhaul (A4): the sink is now a COMPOSITE — the durable
            # Noise-Reduction counters (Round-7) PLUS the realtime baseline producer
            # (per-source ingest volume for silent-source / flood detection). Both are
            # advisory + fail-open; the counter behaviour is byte-identical (the baseline
            # branch is a pure additive observer that never raises into the poll/ingest
            # path). ``noise_counters.record`` still receives the FULL payload unchanged.
            self.poller.set_noise_sink(self._noise_and_baseline_sink)
            self._real_ingest_service._noise_sink = self._noise_and_baseline_sink
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
                query_source = self.poller.source_for_id(case.source_id)
                await self._real_pipeline.investigate_cluster(
                    cluster, case.source_surface, self.prefs,
                    force=True, force_playbook_id=playbook_id,
                    query_source=query_source,
                )
            except Exception:  # noqa: BLE001 — a queued re-investigation never breaks anything
                logger.debug("automation playbook re-investigation failed for %s", case.case_id)

        asyncio.create_task(_do())

    async def _automation_cluster_for_case(self, case):
        """Rebuild a cluster for a queued automation re-investigation (read-only).

        Mirrors the routes' ``_cluster_for_case`` but kept dependency-light here to
        avoid a routes import cycle. Returns None when no events remain."""
        from .engine.correlation import cluster_from_events
        from .models import RawEvent

        prefs = self.prefs
        if not case.member_event_ids:
            return None
        query_source = self.poller.source_for_id(case.source_id)
        events = []
        fetch_size = max(len(case.member_event_ids), len(case.member_event_keys or []))
        if query_source is not None:
            try:
                result = await query_source.fetch_by_ids(
                    prefs, case.member_event_ids, size=fetch_size
                )
                events = result.events
            except Exception:  # noqa: BLE001
                return None
        elif (
            case.source_id
            and not prefs.sources
            and case.source_id == getattr(self.log_source, "connector_id", None)
        ):
            try:
                result = await self.log_source.fetch_by_ids(
                    prefs, case.member_event_ids, size=fetch_size
                )
                events = result.events
            except Exception:  # noqa: BLE001
                return None
        elif case.source_id:
            # Push/deleted sources must never fall back to the primary/global log
            # surface. Rebuild a minimal source-local cluster from stored identity.
            for event_id in case.member_event_ids[:200]:
                event = RawEvent(
                    id=event_id,
                    timestamp_millis=case.first_seen_millis,
                    rule=(case.rule_ids[0] if case.rule_ids else None),
                    source={"reconstructed": True},
                    source_id=case.source_id,
                    source_name=case.source_name,
                )
                if case.entity.type.value == "ip":
                    event.ip = case.entity.value
                elif case.entity.type.value == "user":
                    event.user = case.entity.value
                elif case.entity.type.value == "host":
                    event.host = case.entity.value
                events.append(event)
        else:
            # Legacy no-source case: preserve the implicit connector behavior.
            try:
                result = await self.log_source.fetch_by_ids(
                    prefs, case.member_event_ids, size=fetch_size
                )
                events = result.events
            except Exception:  # noqa: BLE001
                return None
        members = [e for e in events if e.entity_value(case.entity.type) == case.entity.value] or events
        if not members:
            return None
        cluster = cluster_from_events(case.entity.type, case.entity.value, members)
        cluster.signature = case.cluster_signature
        cluster.source_id = case.source_id
        cluster.source_name = case.source_name
        cluster.member_event_keys = list(case.member_event_keys or cluster.member_event_keys)
        cluster.trigger_reason = None  # preserve the existing case's trigger reason
        return cluster

    async def cluster_for_case(self, case):
        """Public PollerHost seam for durable deferred-candidate reconstruction."""
        return await self._automation_cluster_for_case(case)

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

    def _new_playbook_registry(self):
        """Build a registry with ownership metadata for the active directory.

        The three Markdown procedures shipped in ``backend/playbooks`` are bundled
        reference content and therefore protected from runtime edits.  A configured
        override directory is operator-owned, so every valid playbook there may be
        edited by a principal holding ``playbooks:manage``.
        """
        from .playbooks.registry import (
            DEFAULT_BUNDLED_PLAYBOOK_FILES,
            PlaybookRegistry,
        )

        directory = self._playbooks_dir()
        bundled_directory = Path(__file__).resolve().parent.parent / "playbooks"
        protected = (
            DEFAULT_BUNDLED_PLAYBOOK_FILES
            if directory.expanduser().resolve(strict=False)
            == bundled_directory.resolve(strict=False)
            else frozenset()
        )
        return PlaybookRegistry(directory, protected_filenames=protected)

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
        self._real_case_threads = CaseThreadStore(kv)
        self._real_case_activity = CaseActivityStore(kv)
        self._real_case_tasks = CaseTaskStore(kv)
        # In-app notification fan-out + per-user delivery prefs (#8).
        self._real_inbox = InboxStore(kv)
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
        self._real_shift_handoff = ShiftHandoffStore(kv)

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
        self._real_tuning_store = TuningStore(kv)
        self._real_campaign_store = CampaignStore(kv)
        self._real_baseline_store = BaselineStore(kv)
        self._real_batch_job_store = BatchJobStore(kv)

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

        self._real_noise_counters = NoiseCounterStore(self._kv)

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
        """The active in-process SSE transport.

        Real activity uses the process singleton. Demo activity uses its throwaway,
        history-free bus so live steps reach the presentation without leaving demo
        case ids in the real replay buffer.
        """
        if self._demo is not None:
            return self._demo.event_bus
        from .realtime import get_event_bus

        return get_event_bus()

    def active_source_for_id(self, source_id: str | None):
        """Resolve a query source from the active real or demo tenant view."""
        if self._demo is not None:
            return self.demo_source_connector(source_id or "demo-splunk")
        return self.poller.source_for_id(source_id) if source_id else self.log_source

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
            audit=self.audit,
            tuning_store=self.tuning_store,
            write_prefs=self.update_execution_prefs,
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
        over the REAL ``batch_job_store`` + the batch-provider factory + the ONE LLM gateway
        ledger (#6 — exactly one UsageDoc per result, deduped by ``custom_id``). Default
        OFF via ``Preferences.batch``; the Wave-4 caller gates + drives it. Nothing runs
        at boot; the service holds no open connections until ``submit``/``poll`` is
        called. Memoised on the AppState (rebuilt on ``_wire()`` since it references the
        rebuilt store/gateway)."""
        svc = getattr(self, "_batch_service", None)
        if svc is None:
            svc = _BatchJobService(
                # Batch submission/polling is an out-of-band production scheduler and
                # remains disabled while Demo Mode is active.  Keep the service pinned
                # to the durable store; demo read routes use the active property above
                # and therefore expose an isolated, empty job list.
                store=self.real_batch_job_store,
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
                    cluster, SourceSurface.AUTOMATED_SCAN, prefs,
                    query_source=self.poller.source_for_id(getattr(_src, "id", None)),
                )
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

    # ------------------------------------------------------------------ #
    # Autopilot overhaul (A4) — the REALTIME baseline PRODUCER + silent-source detector.
    #
    # A pure advisory PRODUCER wired onto the per-tick noise sink: it folds per-source
    # ingest volume (and, when a caller supplies it, per-cluster volume) into a long-lived,
    # persisted baseline so "learn over time" is real from day one. It NEVER triggers an
    # investigation, closes/escalates a case, or touches ``decide()`` (#3) — learning-as-
    # producer is default-ON, learning-as-trigger stays opt-in. Every method is fail-open:
    # a glitch degrades to "no signal this tick", never a dropped/duplicated event.
    # ------------------------------------------------------------------ #
    async def _ensure_realtime_baseline(self):
        """The long-lived REALTIME baseline producer, warmed from the persistent
        ``baseline_store`` on first use (so it resumes a warmed baseline across restarts)
        + LRU-bounded by ``prefs.baseline.max_series``. Built lazily; reset on _wire()."""
        if self._realtime_baseline is None:
            engine = self.build_baseline_engine()
            try:
                series = await self.baseline_store.snapshot()
                for sig, buckets in (series or {}).items():
                    engine.restore(sig, buckets)
            except Exception as exc:  # noqa: BLE001 — a cold baseline is fine
                logger.debug("realtime baseline warm-from-store failed (%s); cold start", exc)
            self._realtime_baseline = engine
        return self._realtime_baseline

    def _baseline_learning_on(self) -> bool:
        """Whether the baseline PRODUCER should observe this tick: baseline learning is
        enabled AND we are not running against isolated demo data."""
        prefs = self.prefs
        if getattr(getattr(prefs, "demo", None), "active", False):
            return False
        return bool(getattr(getattr(prefs, "baseline", None), "enabled", False))

    async def _flush_realtime_baseline(self, engine, signature: str) -> None:
        """Persist the ONE signature's sketches back to the baseline_store (best-effort),
        then delete any signatures the LRU bound evicted this tick so ``max_series`` bounds
        the durable store too, not just memory."""
        try:
            snap = engine.snapshot(signature)
            if snap:
                await self.baseline_store.put(signature, snap)
        except Exception as exc:  # noqa: BLE001 — persistence is best-effort
            logger.debug("realtime baseline flush failed (%s)", exc)
        try:
            for evicted in engine.drain_evictions():
                if evicted != signature:
                    await self.baseline_store.delete(evicted)
        except Exception as exc:  # noqa: BLE001 — eviction cleanup is best-effort
            logger.debug("realtime baseline eviction cleanup failed (%s)", exc)

    async def observe_source_volume(self, source_id, count, *, when: datetime | None = None):
        """Fold ONE tick's PER-SOURCE ingest volume into the baseline (silent-source /
        flood producer, A4). ALWAYS stamps the source's last-event wall clock when
        ``count > 0`` (so the v0 flat silent check works BEFORE the baseline warm-up),
        then — only when baseline learning is on — folds ``count`` into the namespaced
        ``__source_volume__:<id>`` series and persists it. Returns the advisory
        :class:`BaselineSignal` (or None). Advisory only — NEVER triggers an
        investigation / touches ``decide()`` (#3). Fail-open."""
        sid = str(source_id or "").strip()
        if not sid:
            return None
        now = when or datetime.now(timezone.utc)
        try:
            if int(count) > 0:
                self._source_last_event[sid] = now
                # B3: count this non-empty tick so the silent-source check can tell an
                # established source (raised long-quiet tolerance) from a barely-seen one.
                self._source_event_ticks[sid] = self._source_event_ticks.get(sid, 0) + 1
        except (TypeError, ValueError):
            pass
        if not self._baseline_learning_on():
            return None
        try:
            from .engine.baseline import source_volume_signature

            engine = await self._ensure_realtime_baseline()
            sig = source_volume_signature(sid)
            signal = engine.observe(sig, engine.bucket_for_time(now), float(count))
            await self._flush_realtime_baseline(engine, sig)
            return signal
        except Exception as exc:  # noqa: BLE001 — the producer must never break a tick
            logger.debug("source-volume baseline observe failed (%s)", exc)
            return None

    async def observe_cluster_volume(self, signature, count, *, when: datetime | None = None):
        """Fold ONE tick's PER-CLUSTER volume into the baseline for an advisory anomaly
        chip (A4). A hook a caller (the poll/ingest batch) may invoke per correlated
        cluster; no-op unless baseline learning is on. Returns the advisory
        :class:`BaselineSignal` (or None). It can NEVER trigger an investigation by
        itself (#3) — the signal is presentation-only. Fail-open."""
        sig = str(signature or "").strip()
        if not sig or not self._baseline_learning_on():
            return None
        now = when or datetime.now(timezone.utc)
        try:
            engine = await self._ensure_realtime_baseline()
            signal = engine.observe(sig, engine.bucket_for_time(now), float(count))
            await self._flush_realtime_baseline(engine, sig)
            return signal
        except Exception as exc:  # noqa: BLE001 — the producer must never break a tick
            logger.debug("cluster-volume baseline observe failed (%s)", exc)
            return None

    #: Multiplier on ``poll_interval_seconds`` for the COLD-START flat check — the
    #: conservative fallback used before a source has a genuine activity history. k=4 ~
    #: four missed polls, an "it stopped" signal, not a single jittered gap.
    _SILENT_SOURCE_K = 4.0
    #: Absolute floor (seconds) on the silence threshold for an ESTABLISHED source. B3
    #: recalibration: the old flat check flagged a source SILENT after only ~k×poll_interval
    #: (~2 min at the default 30s interval), which false-positives constantly on the
    #: legitimately quiet / bursty ALERT feeds this overhaul makes standard. A source with a
    #: real activity history is therefore tolerated quiet for at least this long (30 minutes)
    #: before being called silent — so a true outage still surfaces without spamming normal
    #: quiet gaps. Advisory only — never feeds decide() (#3).
    _SILENT_SOURCE_FLOOR_SECONDS = 30 * 60
    #: Number of prior NON-EMPTY observed ticks that makes a source "established" (and thus
    #: eligible for the raised floor above). Below this a source keeps the conservative
    #: cold-start flat check — a barely-seen / just-started source is judged on the short
    #: window; an established one on the long window (so brief quiet gaps never spam).
    _SILENT_SOURCE_ESTABLISHED_OBS = 2

    def silent_sources(self, prefs: Preferences | None = None, *, now: datetime | None = None,
                       k: float | None = None) -> list[str]:
        """SILENT-SOURCE check: enabled sources whose last observed event is older than the
        silence threshold. Pure + advisory (feeds a UI flag, never ``decide()``, #3) and
        works BEFORE the ~14d baseline warm-up.

        Two-tier threshold (B3 recalibration — stop false-positives on quiet/bursty ALERT
        feeds): an ESTABLISHED source (one that has delivered at least
        ``_SILENT_SOURCE_ESTABLISHED_OBS`` non-empty ticks) is only flagged once quiet past
        ``max(k×poll_interval, _SILENT_SOURCE_FLOOR_SECONDS)`` — a raised, minutes-to-hours
        floor — so a normal quiet gap on a real feed is never spammed as silent. A barely-
        seen / just-started source keeps the conservative cold-start flat check
        (``k×poll_interval``). A source never yet seen is NOT flagged (it is 'awaiting first
        event', not 'went silent')."""
        prefs = prefs or self.prefs
        now = now or datetime.now(timezone.utc)
        kk = float(self._SILENT_SOURCE_K if k is None else k)
        interval = max(1, int(getattr(prefs, "poll_interval_seconds", 30) or 30))
        base = kk * interval
        floor = float(self._SILENT_SOURCE_FLOOR_SECONDS)
        silent: list[str] = []
        for s in getattr(prefs, "sources", []) or []:
            if not getattr(s, "enabled", False):
                continue
            sid = getattr(s, "id", None)
            last = self._source_last_event.get(sid)
            if last is None:
                continue  # never reported yet — awaiting first event, not silent
            # Established sources (a real activity history) get the raised long-quiet
            # tolerance; cold-start sources keep the short flat window. Observation counts
            # come from observe_source_volume; a directly-stamped clock with no count reads
            # as 0 → the conservative cold-start window.
            established = self._source_event_ticks.get(sid, 0) >= self._SILENT_SOURCE_ESTABLISHED_OBS
            threshold = max(base, floor) if established else base
            if last.tzinfo is None:
                last = last.replace(tzinfo=timezone.utc)
            if (now - last).total_seconds() > threshold:
                silent.append(s.id)
        return silent

    async def _noise_and_baseline_sink(self, payload: dict) -> None:
        """Composite per-tick sink (wired in _wire): the durable Noise-Reduction counters
        PLUS the realtime baseline producer. Both are advisory + fail-open; a glitch in
        either NEVER breaks a poll/ingest tick (#3). Counter behaviour is byte-identical —
        ``noise_counters.record`` receives the FULL payload unchanged; the baseline branch
        is a pure additive observer."""
        try:
            # The REAL poller/ingest tick always records to the REAL store (never the
            # demo-swap property) so demo mode never pollutes real counters (#isolation).
            await self._real_noise_counters.record(payload)
        except Exception as exc:  # noqa: BLE001 — counters never break a tick
            logger.debug("noise-counter record failed: %s", exc)
        try:
            await self._observe_tick_volume(payload)
        except Exception as exc:  # noqa: BLE001 — the producer never breaks a tick
            logger.debug("realtime baseline tick observe failed: %s", exc)

    async def _observe_tick_volume(self, payload: dict) -> None:
        """Extract the per-source ingest total from a noise-sink payload and feed it to the
        realtime baseline producer. ``source_id`` is threaded onto the payload by the
        poller/ingest sink call sites (coverage-observability); when it is absent (an older
        call site) there is no per-source key to attribute the volume to, so the per-source
        producer is skipped — direct callers (and the observability batch) can still invoke
        ``observe_source_volume``/``observe_cluster_volume`` explicitly."""
        if not isinstance(payload, dict):
            return
        source_id = payload.get("source_id")
        if not source_id:
            return
        ingested = payload.get("ingested") or {}
        total = 0
        if isinstance(ingested, dict):
            for v in ingested.values():
                try:
                    total += int(v)
                except (TypeError, ValueError):
                    continue
        await self.observe_source_volume(source_id, total)
        cluster_volumes = payload.get("cluster_volumes") or {}
        if isinstance(cluster_volumes, dict):
            for signature, count in cluster_volumes.items():
                try:
                    await self.observe_cluster_volume(signature, int(count))
                except (TypeError, ValueError):
                    continue

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
        disabled. Fresh installations enable tuning and campaign correlation through the
        autopilot defaults, while setup state and the global runtime gates still prevent
        premature work; batch remains opt-in. Started once; cancelled in shutdown()."""
        if self._scheduler_running:
            return
        self._scheduler_running = True
        self._scheduler_tasks = [
            asyncio.create_task(self._tuner_scheduler_loop()),
            asyncio.create_task(self._campaign_scheduler_loop()),
            asyncio.create_task(self._batch_scheduler_loop()),
        ]
        logger.info("Background schedulers started; runtime feature gates apply per tick")

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
        # A transient store-read glitch degrades to an EMPTY list inside UserStore._load
        # (it swallows read errors), and an empty view collapses the synced auth snapshot
        # to the env base layer alone — on an OOBE-only deployment (no env-seeded admin)
        # that evicts EVERY persisted account and locks all logins out until a restart. An
        # empty list is therefore AMBIGUOUS: treat it as a failed read (keep the current
        # view, like the exception branch above) UNLESS the store is AUTHORITATIVELY empty.
        # ``has_any()`` is the raising probe — a read glitch propagates (→ keep view) and a
        # genuinely non-empty store is detected (→ keep view); only a clean "zero users"
        # answer authorises the empty base-only view.
        allow_empty = False
        if not users:
            try:
                store_has_users = await self.users.has_any()
            except Exception as exc:  # noqa: BLE001 — an unconfirmable empty is a failed read
                logger.warning(
                    "refresh_users: users.list() was empty and the has_any() authoritative "
                    "probe failed (%s); keeping the current auth view (a transient empty "
                    "read must never evict accounts)", exc,
                )
                return
            if store_has_users:
                logger.warning(
                    "refresh_users: users.list() returned empty but the store reports "
                    "accounts present — treating as a transient read and keeping the "
                    "current auth view"
                )
                return
            allow_empty = True  # the store is authoritatively empty → base-only view is valid
        try:
            self.auth.set_users(users, allow_empty=allow_empty)
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
        reg = self._new_playbook_registry()
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
        if str(self.playbooks._directory) != str(self._playbooks_dir()):
            self.playbooks = self._new_playbook_registry()
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
            if self.prefs.sources:
                from .connectors.unavailable import UnavailablePullConnector

                return UnavailablePullConnector(connector_id="no-pull-source")
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
            self._receivers_enabled = True
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

                # Durable cursor for object-store / stream receivers (audit #7): persist
                # the last-processed marker keyed by this source id so a restart resumes.
                if hasattr(receiver, "attach_cursor_io"):
                    _cs = self.cursor_store
                    receiver.attach_cursor_io(
                        load=lambda _k=src.id: _cs.load_keyed(_k),
                        save=lambda cur, _k=src.id: _cs.save_keyed(_k, cur),
                    )

                async def _emit(events, _self=self, _sid=src.id):
                    # Real push receivers ALWAYS feed the REAL ingest path (even while
                    # demo is engaged) so live telemetry lands in the real store
                    # (hidden during demo, never mixed into the demo store).
                    await _self._real_ingest_service.ingest(events, _self.prefs, source_id=_sid)

                task = asyncio.create_task(
                    self._run_receiver(receiver, _emit, src.id)
                )
                task.add_done_callback(
                    lambda completed, _sid=src.id: self._receiver_done(_sid, completed)
                )
                self._receivers.append(receiver)
                self._receiver_tasks.append(task)
                logger.info("Started push receiver %s (%s)", src.id, src.source_type.value)
            except Exception as exc:  # noqa: BLE001 — one bad source must not block startup
                logger.error("Could not start receiver %s (%s): %s", src.id, src.source_type.value, exc)

    async def _run_receiver(self, receiver, emit, source_id: str) -> None:
        """Supervise one long-running receiver with bounded exponential backoff.

        Processing failures intentionally propagate out of transport loops so their
        offsets/messages remain unacknowledged. Without a supervisor that safety
        behavior permanently stopped the consumer. Restart the same configured
        receiver until reconciliation/shutdown cancels the task.
        """
        delay = 1.0
        while self._receivers_enabled:
            try:
                await receiver.start(emit, self.prefs)
                if not self._receivers_enabled:
                    return
                logger.warning("Push receiver %s stopped; restarting", source_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — supervised transport boundary
                logger.error(
                    "Push receiver %s failed; retrying in %.0fs: %s",
                    source_id,
                    delay,
                    exc,
                )
            try:
                await receiver.stop()
            except Exception:  # noqa: BLE001 — restart must continue after cleanup failure
                pass
            await asyncio.sleep(delay)
            delay = min(60.0, delay * 2.0)

    def _receiver_done(self, source_id: str, task: asyncio.Task) -> None:
        """Surface a receiver task exit instead of failing silently in the background."""
        if task.cancelled():
            return
        try:
            exc = task.exception()
        except asyncio.CancelledError:
            return
        if exc is None:
            if self._receivers_enabled:
                logger.warning("Push receiver %s stopped unexpectedly", source_id)
            return
        logger.error("Push receiver %s failed: %s", source_id, exc, exc_info=exc)

    async def reconcile_receivers(self) -> None:
        """Apply the current source/secret configuration to the live receivers.

        Reconciliation is intentionally idempotent and coarse-grained in version 0.1:
        stop the existing set cleanly, then start exactly the enabled configured set.
        This makes create/edit/delete/secret rotation effective without a process
        restart and prevents deleted file/syslog/queue consumers from lingering.
        Runtime states created with ``start_poller=False`` remain side-effect free.
        """
        if not self._receivers_enabled:
            return
        await self._start_receivers()

    async def _stop_receivers(self) -> None:
        for receiver in self._receivers:
            try:
                await receiver.stop()
            except Exception:  # noqa: BLE001
                pass
        tasks = list(self._receiver_tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._receivers = []
        self._receiver_tasks = []

    async def reload_prefs(self) -> Preferences:
        self.prefs = await self.config_store.load()
        return self.prefs

    async def update_prefs(self, prefs: Preferences) -> Preferences:
        """Persist + publish a fully-built ``Preferences`` document atomically.

        Serialized under ``self._prefs_lock`` so a concurrent writer cannot interleave
        its ``config_store.save`` / ``self.prefs = …`` with this one (last-writer-wins
        lost update). A caller doing a read-modify-write should prefer
        :meth:`mutate_prefs`, which performs the read INSIDE the same lock so it builds
        on the freshest prefs rather than a snapshot that a background writer may already
        have superseded."""
        async with self._prefs_lock:
            return await self._apply_prefs_locked(prefs)

    async def mutate_prefs(
        self, mutate: Callable[[Preferences], Preferences]
    ) -> Preferences:
        """Atomic read-modify-write of ``Preferences`` under the write lock.

        ``mutate`` receives the CURRENT ``self.prefs`` (read inside the lock) and returns
        the new document to persist. Because the read, the transform, and the save all
        happen while the lock is held, a caller's edit can no longer be clobbered by a
        concurrent full-document write that started from a stale snapshot — the fix for a
        source rename silently not persisting. ``mutate`` must be a pure, non-blocking
        transform (typically ``prefs.model_copy(update=…)``) and must NOT call back into
        ``update_prefs``/``mutate_prefs`` (the lock is not reentrant)."""
        async with self._prefs_lock:
            new_prefs = mutate(self.prefs)
            return await self._apply_prefs_locked(new_prefs)

    async def _apply_prefs_locked(self, prefs: Preferences) -> Preferences:
        """Persist ``prefs`` + refresh the live components that cache it. MUST be called
        with ``self._prefs_lock`` held (via :meth:`update_prefs` / :meth:`mutate_prefs`)."""
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
            # ``_wire()`` rebuilt a FRESH AuthService whose synced view is only the env
            # base layer — the persisted (store) accounts have been dropped. Without a
            # refresh, an ES-credential change would silently lock every OOBE/stored
            # account out until the next user mutation or a restart. Re-fold the store
            # into the auth view now (guarded: a transient empty read can't evict, and a
            # genuinely-empty store is honoured). Best-effort — never break a credential
            # change on a user-store read.
            try:
                await self.refresh_users()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Refreshing users after credential change failed (%s)", exc)
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
        async with self._demo_lifecycle_lock:
            return await self._enable_demo_unlocked(
                mode=mode,
                seed=seed,
                history_days=history_days,
                tick_seconds=tick_seconds,
                tick_jitter=tick_jitter,
                incident_rate=incident_rate,
                alert_interval_seconds=alert_interval_seconds,
                event_rate_per_second=event_rate_per_second,
                preseed_recent_minutes=preseed_recent_minutes,
                preseed_case_count=preseed_case_count,
                preseed_event_count=preseed_event_count,
                force_capabilities=force_capabilities,
            )

    async def _enable_demo_unlocked(
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
            await self._disable_demo_unlocked()

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
        # Build and seed OFF to the side. Until the final synchronous swap, every
        # public read continues to see the complete real tenant; no caller can observe
        # a half-seeded demo (for example the 42 historical rows before capability
        # seeds finish). The closure serves pending prefs during construction and the
        # live prefs after this exact stack becomes active.
        pending_prefs = self.prefs.model_copy(deep=True)
        pending_prefs.demo = new_demo
        demo_stack = None

        def pending_or_live_prefs() -> Preferences:
            return (
                self.prefs
                if demo_stack is not None and self._demo is demo_stack
                else pending_prefs
            )

        demo_stack = DemoStack(
            self.secrets, pending_or_live_prefs, run_id=new_demo.run_id,
        )

        # Eagerly seed the SHARED demo RAG corpus so the Knowledge page shows a populated
        # corpus immediately (idempotent; picks up any CLOSED demo cases too).
        try:
            await demo_stack.rag_service.ensure_seeded()
        except Exception as exc:  # noqa: BLE001 — a cold RAG never breaks enable
            logger.debug("demo RAG eager-seed failed: %s", exc)

        # Pre-generate the backdated historical spread so "old" cases exist instantly.
        org = build_org(new_demo.seed)
        now_ms = to_millis(now_utc())
        cases = generate_historical_cases(
            new_demo.seed, org, history_days=new_demo.history_days,
            run_id=new_demo.run_id, now_millis=now_ms,
        )
        seeded_counter_cases = list(cases)
        for case in cases:
            self._write_guard(case, demo=True)
            await demo_stack.cases.save(case)

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
            await demo_stack.cases.save(case)
        seeded_counter_cases.extend(recent_cases)
        # Materialise the ~100 already-processed benign events now; the coherent
        # ingested/clustered counter delta is recorded after every seeded case is known
        # (including capability cases) so the visible funnel can never claim fewer
        # clusters than cases.
        preseed_raws = []
        if recent_hits:
            try:
                dprefs = demo_stack._demo_prefs()  # noqa: SLF001 — same module owner
                preseed_raws = hits_to_raw(recent_hits, dprefs)
                demo_stack.preseed_events = len(preseed_raws)
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
                    await demo_stack.cases.save(case)
                seeded_counter_cases.extend((*hitl_cases, *tuner_cases))
                # Fire threshold-automation on the NEEDS_HUMAN pair → >= 1 demo HITL proposal
                # (deterministic, $0 — runs on the already-saved demo cases; no LLM).
                await demo_stack.seed_hitl_proposals(hitl_cases)
            except Exception as exc:  # noqa: BLE001 — capability seeding never blocks enable
                logger.warning("demo capability seeding failed: %s", exc)

        # Seed one coherent, deterministic 24h funnel delta. The transient benign batch
        # contributes inbound volume only. Every seeded case in the current dashboard
        # window contributes one correlated cluster plus at least one source event (or
        # its actual member count), which mirrors how a real cluster becomes a case.
        # Recording the aggregate instead of replaying fixtures through the live spine
        # preserves deterministic case ids while guaranteeing the presenter sees the
        # truthful invariant ``events >= clusters >= cases`` from the first paint.
        try:
            from .constants import SEVERITY_BANDS
            from .engine import noise_counters as nc
            from .utils import parse_es_timestamp

            ingested = nc.count_events_by_band(preseed_raws, "ocsf_0_100")
            clustered = nc.zero_bands()
            case_events = nc.zero_bands()
            cutoff_ms = now_ms - 24 * 60 * 60 * 1000
            for case in seeded_counter_cases:
                created = parse_es_timestamp(case.created_at)
                if created is None or to_millis(created) < cutoff_ms:
                    continue
                band = case.severity_band if case.severity_band in SEVERITY_BANDS else "info"
                clustered[band] += 1
                members = case.member_event_keys or case.member_event_ids
                case_events[band] += max(1, len(members))
            ingested = nc.merge_bands(ingested, case_events)
            await demo_stack.noise_counters.record({
                "ingested": ingested,
                "clustered": clustered,
                "suppressed": 0,
                "ignored": 0,
            })
        except Exception as exc:  # noqa: BLE001 — metrics never block demo enable
            logger.warning("demo coherent funnel seed failed: %s", exc)

        # Run ONE synchronous capability pass so even a 'seeded' demo (no ticker) shows a
        # campaign + a tuning observation immediately.
        try:
            await demo_stack.run_capability_pass()
        except Exception as exc:  # noqa: BLE001 — never break enable on a capability pass
            logger.debug("demo initial capability pass failed: %s", exc)

        # Commit the fully-built stack. update_prefs() does not yield after assigning
        # self.prefs; the following synchronous assignment therefore presents one
        # atomic off→ready transition to other asyncio tasks.
        await self.update_prefs(pending_prefs)
        self._demo = demo_stack
        # Start the live simulator only after the complete stack is publicly visible.
        if new_demo.mode == "live":
            self._demo_sim = DemoSimulator(demo_stack, self.get_prefs, seed=new_demo.seed)
            self._demo_sim.start()
        logger.info("Demo mode ENABLED (mode=%s run_id=%s seeded %d + %d recent cases)",
                    new_demo.mode, new_demo.run_id, len(cases), len(recent_cases))
        return await self.demo_status()

    async def reset_demo(self) -> dict:
        async with self._demo_lifecycle_lock:
            return await self._reset_demo_unlocked()

    async def _reset_demo_unlocked(self) -> dict:
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
        await self._disable_demo_unlocked()
        return await self._enable_demo_unlocked(
            mode=mode, seed=seed, history_days=hd, tick_seconds=ts,
            tick_jitter=tj, incident_rate=ir,
            alert_interval_seconds=ais, event_rate_per_second=erps,
            preseed_recent_minutes=prm, preseed_case_count=pcc, preseed_event_count=pec,
            force_capabilities=fc,
        )

    async def disable_demo(self) -> dict:
        async with self._demo_lifecycle_lock:
            return await self._disable_demo_unlocked()

    async def _disable_demo_unlocked(self) -> dict:
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
        if self._demo_incident_sim is not None:
            try:
                await self._demo_incident_sim.stop()
            except Exception:  # noqa: BLE001
                pass
            self._demo_incident_sim = None
        if self._demo is not None:
            try:
                await self._demo.purge()
                await self._demo.aclose()
            except Exception:  # noqa: BLE001
                pass
            self._demo = None
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
        sim = self._demo_control_simulator()
        stats = await sim.tick_once()
        stats["demo"] = True
        return stats

    def _demo_control_simulator(self):
        """Return the persistent simulator used by live or seeded/manual controls."""
        if self._demo_sim is not None:
            return self._demo_sim
        if self._demo_incident_sim is None:
            from .engine.demo_runtime import DemoSimulator

            seed = int(getattr(getattr(self.prefs, "demo", None), "seed", 1337) or 1337)
            self._demo_incident_sim = DemoSimulator(self._demo, self.get_prefs, seed=seed)
        return self._demo_incident_sim

    async def trigger_demo_incident(self, story_id: str | None = None) -> dict:
        """Trigger one cooldown-aware coherent attack inside the throwaway demo only."""
        if self._demo is None:
            return {
                "triggered": False,
                "reason": "demo mode is off",
                "scenario_id": story_id or "",
                "events": 0,
                "native_alerts": 0,
                "system_detections": 0,
                "cooldown_seconds": 0.0,
                "sources": {},
            }
        return await self._demo_control_simulator().trigger_incident(story_id)

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
        source_activity: list[dict] = []
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
                sources = [str(row["id"]) for row in self.demo_sources_overlay()]
            except Exception:  # noqa: BLE001
                sources = []
            try:
                snapshot = self._demo.source_runtime_snapshot(
                    running=self._demo_sim is not None,
                )
                source_activity = list(snapshot.get("sources", []))
            except Exception:  # noqa: BLE001
                source_activity = []
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
            "ticking": self._demo_sim is not None,
            "case_count": case_count,
            "preseed_events": int(getattr(self._demo, "preseed_events", 0)) if self._demo else 0,
            "proposals_open": proposals_open,
            "campaigns_found": campaigns_found,
            "tuning_events": tuning_events,
            "rag_chunks": rag_chunks,
            "sources": sources,
            "source_activity": source_activity,
        }

    def demo_sources_overlay(self) -> list[dict]:
        """The four native demo sources shaped like a ``SourceInstance.model_dump`` for the
        read-time-only active source view on GET /api/sources + /sources/health. Built from
        the live ``DemoStack`` — NEVER written into ``Preferences.sources`` (so the real
        PollerManager / PUT /api/settings / the wizard never see them). Returns ``[]``
        when demo is off; real source configuration remains preserved and hidden until
        Demo Mode is disabled."""
        if self._demo is None:
            return []
        from .engine.demo_sources import DEMO_SOURCE_SPECS

        rows: list[dict] = []
        for spec in DEMO_SOURCE_SPECS.values():
            source_type = (
                spec.source_type.value
                if hasattr(spec.source_type, "value") else str(spec.source_type)
            )
            ingest_mode = (
                spec.ingest_mode.value
                if hasattr(spec.ingest_mode, "value") else str(spec.ingest_mode)
            )
            rows.append({
                "id": spec.source_id,
                "display_name": spec.display_name,
                "source_type": source_type,
                "category": spec.category,
                "enabled": True,
                "is_primary": False,
                "ingest_mode": ingest_mode,
                "protocol": spec.protocol,
                "format": spec.wire_format,
                "can_browse": True,
                "demo": True,
                "config": {
                    "protocol": spec.protocol,
                    "format": spec.wire_format,
                },
                "configured_secrets": [],
            })
        return rows

    def demo_source_connector(self, source_id: str):
        """Return one isolated native demo adapter by public source id.

        This is a read-only route seam: the adapters and their bounded rings live on
        the throwaway ``DemoStack`` and are never registered as tenant connectors or
        persisted in ``Preferences.sources``. ``None`` is returned off-demo/unknown.
        """
        if self._demo is None:
            return None
        try:
            from .engine.demo_sources import DEMO_SOURCE_SPECS

            key = next(
                (key for key, spec in DEMO_SOURCE_SPECS.items()
                 if spec.source_id == source_id),
                None,
            )
            return self._demo.sources.get(key) if key else None
        except Exception:  # noqa: BLE001 — browse degrades to a normal not-found
            return None

    def demo_source_health_overlay(self) -> list[dict]:
        """Truthful, non-secret runtime health rows for the four demo adapters.

        Runtime counters come from the adapters' bounded activity rings. Static vendor
        identity comes from ``DEMO_SOURCE_SPECS``. No durable poll cursor is fabricated:
        these are push-style simulators, so ``last_poll_*`` remains ``None``/``0``.
        """
        if self._demo is None:
            return []
        runtime: dict[str, dict] = {}
        try:
            snapshot = self._demo.source_runtime_snapshot(
                running=self._demo_sim is not None,
            )
            runtime = {
                str(row.get("source_id") or row.get("id")): dict(row)
                for row in snapshot.get("sources", [])
                if isinstance(row, dict) and (row.get("source_id") or row.get("id"))
            }
        except Exception:  # noqa: BLE001 — health is advisory and fail-soft
            runtime = {}

        rows: list[dict] = []
        for source in self.demo_sources_overlay():
            sid = str(source["id"])
            activity = runtime.get(sid, {})
            last_event = int(activity.get("last_event_millis") or 0)
            events_total = int(
                activity.get("events_received", activity.get("events_total", 0)) or 0
            )
            alerts_total = int(
                activity.get("alerts_emitted", activity.get("alerts_total", 0)) or 0
            )
            system_detections_total = int(
                activity.get("system_detections_total", 0) or 0
            )
            try:
                events_per_min = float(activity.get("events_per_min") or 0.0)
            except (TypeError, ValueError):
                events_per_min = 0.0
            rows.append({
                "source_id": sid,
                "source_name": source.get("display_name") or sid,
                "source_type": source.get("source_type"),
                "enabled": True,
                "is_primary": False,
                "ingest_mode": source.get("ingest_mode"),
                "kind": "push",
                "protocol": source.get("protocol"),
                "format": source.get("format"),
                "can_browse": True,
                "buffer_depth": int(activity.get("buffer_depth") or 0),
                "events_total": events_total,
                "alerts_total": alerts_total,
                "system_detections_total": system_detections_total,
                # Human-readable API aliases retained for UI consumers.
                "events_received": events_total,
                "alerts_emitted": alerts_total,
                "last_poll_millis": 0,
                "last_poll_at": None,
                "last_poll_ok": None,
                "last_poll_error": None,
                "last_event_millis": last_event,
                "events_per_min": events_per_min,
                "silent": bool(activity.get("silent", False)),
                "healthy": bool(activity.get("healthy", True)),
                "state": activity.get("state") or "ready",
                "last_error": activity.get("last_error"),
                "demo": True,
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
        self._receivers_enabled = False
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
