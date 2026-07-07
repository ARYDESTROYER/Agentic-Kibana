"""Demo Mode runtime (Wave 5) — the isolated demo store stack + the live simulator.

Two pieces, both completely SEPARATE from the real state:

* :class:`DemoStack` — a throwaway store stack built on a FRESH ``InMemoryESClient``:
  its own CaseStore / AuditLogger / UsageStore + a $0 deterministic mock gateway +
  an InvestigationPipeline + IngestService bound to it, PLUS demo-scoped
  Proposal/Campaign/Baseline/Tuning stores and ONE shared vector store so the
  overhaul's "all capabilities ON" showcase runs in a fully ISOLATED sandbox. NOTHING
  here can reach the real ES/SQL stores or the real HITL/tuning/campaign/baseline
  ledgers. The whole thing is garbage-collected when demo is disabled.

* :class:`DemoSimulator` — an asyncio task (mirrors the receiver tasks) that, while
  demo is in ``live`` mode, drives the three demo segments: SIEM as a low-volume
  ALERT feed (~1 alert / ``alert_interval_seconds``) and XDR+EDR as EVENT feeds whose
  ``event_rate_per_second`` LOGICAL volume is pre-aggregated through the SAME
  ``event_detection.funnel()`` real EVENT feeds use (bounded memory — never N retained
  objects/sec). Confirmed candidates are investigated SYNCHRONOUSLY through the REAL
  pipeline against the MOCK LLM + a SANDBOXED AutoClosePolicy copy (proving the
  deterministic #3 gate without touching the real policy). Every write lands in the
  demo store; the real durable cursor is never advanced. On an accelerated cadence the
  ticker also runs a demo-local capability pass (threshold-tuning + campaigns) so the
  console visibly shows those features working — all in the demo scope.
"""

from __future__ import annotations

import asyncio
import logging
import random
from typing import Callable

from ..audit.audit_log import AuditLogger
from ..cache import Cache
from ..config import AutoClosePolicy, Preferences, Secrets
from ..constants import SourceSurface
from ..es.fake import InMemoryESClient
from ..llm.gateway import LLMGateway
from ..llm.providers import DemoMockProvider
from ..realtime import EventBus
from ..stores.cases import CaseStore
from ..stores.usage import UsageStore
from ..utils import now_utc, to_millis
from .ingest import IngestService
from . import demo_generator as gen

logger = logging.getLogger("tlsoc.engine.demo")

DEMO_TAG = "demo"

# The XDR/EDR EVENT feeds share the logical ``event_rate_per_second`` budget; XDR
# server-fleet telemetry is chattier than a single laptop, so it gets the larger split.
_XDR_EVENT_SHARE = 0.6


class _DemoCaseStore(CaseStore):
    """A CaseStore over the throwaway demo ES that TAGS every saved case ``demo`` and
    asserts isolation (a write-guard, #4). Cases produced by the demo pipeline get the
    ``demo`` tag here, so the read endpoints' SAMPLE badge + the disable-by-run_id
    purge both work, and no demo row can be mistaken for a real one."""

    def __init__(self, es: InMemoryESClient, run_id: str) -> None:
        super().__init__(es)
        self._run_id = run_id

    async def save(self, case) -> None:  # noqa: ANN001
        tags = list(getattr(case, "tags", []) or [])
        if DEMO_TAG not in tags:
            tags.append(DEMO_TAG)
        run_tag = f"run:{self._run_id[:12]}" if self._run_id else ""
        if run_tag and run_tag not in tags:
            tags.append(run_tag)
        case.tags = tags
        await super().save(case)


def sandbox_policy(base: AutoClosePolicy) -> AutoClosePolicy:
    """A SANDBOXED copy of the auto-close policy for the demo pipeline.

    decide()/apply() are NEVER edited (#3); passing a *different policy instance* to
    the pure decide() is the supported way to isolate demo behaviour. The demo copy
    keeps FALSE_POSITIVE auto-close ENABLED (so the benign baseline auto-closes and
    showcases the deterministic gate) and NEEDS_HUMAN never auto-closes (code-enforced
    regardless). The real ``prefs.auto_close`` is untouched."""
    return base.model_copy(deep=True)


class DemoStack:
    """The isolated demo store stack (built once per enable; GC'd on disable)."""

    def __init__(self, secrets: Secrets, get_prefs: Callable[[], Preferences],
                 *, run_id: str = "") -> None:
        # A FRESH in-memory ES client — physically separate from the real store.
        self.es = InMemoryESClient()
        self.run_id = run_id
        # An ISOLATED, throwaway realtime bus for the demo pipeline's ``agent.step``
        # frames. ``history_per_topic=0`` disables the replay ring so a publish is a
        # true no-op (nothing retained/replayed) and nothing leaks. It has NO
        # subscribers and is garbage-collected with the stack on disable, so demo
        # progress frames NEVER reach the live global EventBus singleton (isolation
        # boundary, mirrors the separate stores). The pipeline is explicitly bound to
        # this bus below so ``_emit_step``'s ``get_event_bus()`` fallback never fires.
        self.event_bus = EventBus(history_per_topic=0)
        self.cases = _DemoCaseStore(self.es, run_id)
        self.audit = AuditLogger(self.es)
        self.usage_store = UsageStore(self.es)
        # A KV adapter over the demo ES (same one the real _wire() uses for the ES
        # backend). Every demo-scoped store below writes into CONFIG_INDEX on this ES,
        # so ``purge()``'s ``self.es.docs.clear()`` ALREADY wipes them all — one-flip.
        from ..stores.memory import EsKVStore
        self.kv = EsKVStore(self.es)
        # Demo-scoped capability stores. NONE of these is the real HITL/tuning/campaign/
        # baseline ledger — every write here is fully isolated to the demo ES.
        from ..stores.proposals import ProposalStore
        from ..stores.campaigns import CampaignStore
        from ..stores.baseline import BaselineStore
        from ..stores.tuning import TuningStore
        self.proposals = ProposalStore(self.kv)
        self.campaign_store = CampaignStore(self.kv)
        self.baseline_store = BaselineStore(self.kv)
        self.tuning_store = TuningStore(self.kv)
        # Durable raw-alert-by-severity ingest counters backing the demo's
        # noise-reduction surface (over the demo ES — purged on disable).
        from ..stores.noise_counters import NoiseCounterStore
        self.noise_counters = NoiseCounterStore(self.kv)
        # How many pre-seed "already processed" events were counted (for status/tests).
        self.preseed_events = 0
        # ONE shared vector store for BOTH the pipeline RAG and the chat RAG (the old
        # code built two disconnected InMemoryVectorStores → chat could not see what the
        # pipeline indexed and vice-versa). Sharing it is the RAG-building fix.
        from ..tools.vectorstore import InMemoryVectorStore
        self.vectorstore = InMemoryVectorStore()
        # Sticky, demo-isolated tuned correlation-n bumps: the threshold-tuner's writer
        # stashes bumps here (never on the real prefs) and ``_demo_prefs`` merges them
        # every call so a tuned change is visible on the next tick.
        from ..config import CorrelationRule
        self._tuned_correlation_rules: dict[str, CorrelationRule] = {}
        # The long-lived streaming baseline behind the demo EVENT funnel (warmed/flushed
        # against the demo baseline_store). None → built lazily.
        self._funnel_baseline = None
        # The deterministic, $0 mock provider keyed by storyline.
        self._provider = DemoMockProvider()
        overrides = {"anthropic": self._provider, "openai": self._provider, "mock": self._provider}
        # demo=True → every usage row is pricing_source='zero' with a synthetic $.
        self.gateway = LLMGateway(secrets, self.usage_store, overrides, demo=True)
        self._get_prefs = get_prefs
        # An offline cache (no Redis) for the demo enrich tool.
        self._cache = Cache(None)
        # THREE segment connectors built once + reused by the pipeline / simulator.
        from ..connectors.demo import DemoPullConnector
        seed = int(getattr(getattr(get_prefs(), "demo", None), "seed", 1337) or 1337)
        self.sources = {
            "siem": DemoPullConnector(seed=seed, segment="siem",
                                      connector_id=gen.SEGMENT_SOURCE_IDS["siem"]),
            "xdr": DemoPullConnector(seed=seed, segment="xdr",
                                     connector_id=gen.SEGMENT_SOURCE_IDS["xdr"]),
            "edr": DemoPullConnector(seed=seed, segment="edr",
                                     connector_id=gen.SEGMENT_SOURCE_IDS["edr"]),
        }
        # Lazily built so we avoid importing the (heavy) pipeline at module import.
        self.pipeline = self._build_pipeline(secrets)
        # A handle on the pipeline's RagService so demo /api/rag/* + the shared-store
        # identity check reach it.
        self.rag_service = self.pipeline._rag  # noqa: SLF001 — same module owner
        self.ingest_service = IngestService(self.cases, self.audit, self.pipeline, self._demo_prefs)
        # Wire the demo noise sink so LIVE ticks record raw-alert-by-severity volume into
        # the DEMO counters (the noise-reduction surface then reflects the demo traffic).
        self.ingest_service._noise_sink = self.noise_counters.record  # noqa: SLF001
        # A chat engine bound to the DEMO gateway/audit/cases (NOT the real ones), so a
        # /chat turn while demo is engaged spends $0 (demo gateway → pricing_source
        # 'zero'), writes ONLY demo audit rows (purged on disable), and an in-case chat
        # reads the DEMO case store (so it finds the demo case). This mirrors the
        # demo-switchable active-store @properties on AppState — chat is no exception.
        self.chat_engine = self._build_chat_engine()
        # A standup service over the demo ES (case stats reflect the demo store).
        from ..agents.standup import StandupService

        self.standup_service = StandupService(self.es, self.gateway, self.audit)
        from ..agents.overview import OverviewService

        self.overview_service = OverviewService(self.gateway, secrets, self._cache, self.audit)

    def _build_pipeline(self, secrets: Secrets):
        from ..agents.pipeline import InvestigationPipeline
        from ..engine.threshold_automation import ThresholdAutomation

        prefs = self._get_prefs()
        source = self.sources["siem"]  # the internet-facing system an analyst queries most
        from ..tools.rag import RagService

        rag = RagService(self.gateway, prefs, store=self.vectorstore, cases=self.cases)
        # Wire the demo-scoped HITL automation so a matching case opens a demo Proposal
        # (never the real HITL queue). Leave notifier=None — demo never sends real
        # emails/Slack/webhooks (mirrors the intentional memory=None below).
        automation = ThresholdAutomation(self.proposals, self.audit)
        pipeline = InvestigationPipeline(
            self.es, secrets, self._cache, self.gateway, rag, self.cases, self.audit,
            source=source, automation=automation,
        )
        # Bind the demo's ISOLATED bus so live ``agent.step`` frames never touch the
        # global singleton (isolation boundary). Without this the pipeline's
        # ``_emit_step`` would fall back to ``get_event_bus()`` and leak demo frames.
        pipeline.event_bus = self.event_bus
        return pipeline

    def _build_chat_engine(self):
        """A ChatEngine wired to the DEMO gateway/audit/cases + a demo log source +
        the SHARED demo RAG store, so chat during demo is $0 and isolated — never the
        real gateway/audit/cases. No operator MEMORY is injected in demo (memory=None)
        so a real operator's durable facts never bleed into the demo."""
        from ..agents.chat import ChatEngine
        from ..tools.rag import RagService

        prefs = self._get_prefs()
        source = self.sources["siem"]
        rag = RagService(self.gateway, prefs, store=self.vectorstore, cases=self.cases)
        return ChatEngine(
            self.es, self.gateway, self.audit, self.cases, rag,
            source=source, memory=None,
        )

    def _demo_prefs(self) -> Preferences:
        """Prefs the demo pipeline runs under: the live prefs but with a SANDBOXED
        auto-close policy (so decide() runs against the demo copy, not the real
        policy), EVERY-mode correlation (so each synthetic storyline event forms a
        cluster) and background scan ON. When ``force_capabilities`` (the default) is
        set, the threshold-tuning / baseline / campaign / threshold-automation / batch
        blocks are forced ON in the SANDBOX COPY ONLY — the REAL prefs (which these are
        read from) are never mutated (this is a model_copy). Read live so settings
        tweaks still apply during the demo."""
        from ..config import (
            CaseAutomationRule, CorrelationRule, ThresholdAutomationConfig,
        )
        from ..constants import CorrelationMode

        prefs = self._get_prefs()
        every = CorrelationRule(mode=CorrelationMode.EVERY, n=1)
        updates: dict = {
            "auto_close": sandbox_policy(prefs.auto_close),
            "default_correlation": every,
            "background_scan_enabled": True,
        }
        demo = getattr(prefs, "demo", None)
        force = bool(getattr(demo, "force_capabilities", True)) if demo is not None else True
        if force:
            # Force the capability blocks ON in the SANDBOX only (real prefs untouched).
            updates["threshold_tuning"] = prefs.threshold_tuning.model_copy(update={"enabled": True})
            updates["baseline"] = prefs.baseline.model_copy(update={"enabled": True})
            updates["campaign"] = prefs.campaign.model_copy(update={"enabled": True})
            # The EVENT funnel gates on BOTH batch.enabled AND baseline.enabled; force
            # batch ON in the sandbox so the XDR/EDR pre-aggregating funnel actually runs
            # (the demo processes survivors SYNCHRONOUSLY — it never submits to the real
            # batch service).
            updates["batch"] = prefs.batch.model_copy(update={"enabled": True})
            # Threshold automation: force ON + seed a request_approval rule when the
            # operator has none (never clobber their own rules).
            ta = prefs.threshold_automation
            if not ta.rules:
                ta = ThresholdAutomationConfig(enabled=True, rules=[CaseAutomationRule(
                    id="demo-seed-approval",
                    name="Escalate ambiguous verdicts for review",
                    enabled=True, priority=10,
                    conditions={"verdict": "NEEDS_HUMAN"},
                    action="request_approval",
                    payload={"note": "Demo: ambiguous verdict — approve/reject to see HITL."},
                )])
            else:
                ta = ta.model_copy(update={"enabled": True})
            updates["threshold_automation"] = ta
        # Sticky tuned correlation-n bumps (isolated to the sandbox) on top, every call.
        if self._tuned_correlation_rules:
            merged = dict(prefs.correlation_rules)
            merged.update(self._tuned_correlation_rules)
            updates["correlation_rules"] = merged
        return prefs.model_copy(update=updates)

    # ------------------------------------------------------------------ #
    # EVENT-feed routing (XDR/EDR) — pre-aggregate → funnel → sync investigate.
    # ------------------------------------------------------------------ #
    def _demo_event_prefs(self) -> Preferences:
        """Prefs for the HIGH-VOLUME XDR/EDR EVENT funnel. Identical to ``_demo_prefs``
        EXCEPT the correlation default is a high threshold instead of the SIEM ALERT
        path's ``EVERY, n=1`` — otherwise ``event_detection._rule_fires`` would treat
        EVERY benign bucket as a rule hit (a case per event → unbounded). With this the
        funnel relies on the ANOMALY path, so only genuine deviations survive (bounded
        memory + bounded cases).

        It ALSO pins the funnel's grouping entity to HOST. The benign generator stamps a
        random source IP on every event, so an IP-keyed pre-aggregate mints a NEW baseline
        signature per unique IP — the demo baseline_store then grows unboundedly (~5000
        per-IP signatures) tick over tick. Grouping by the BOUNDED host pool (~a few dozen
        hosts) caps the signature cardinality (and therefore the per-tick baseline flush)
        to a small, saturating set — mirroring the real path's bounded-write intent while
        still letting every benign bucket warm the base across ticks."""
        from ..config import CorrelationRule
        from ..constants import CorrelationMode, EntityType

        prefs = self._demo_prefs()
        return prefs.model_copy(update={
            "default_correlation": CorrelationRule(
                mode=CorrelationMode.THRESHOLD, n=10_000, group_by=EntityType.HOST,
            ),
        })

    async def seed_hitl_proposals(self, cases: list) -> int:
        """Fire threshold-automation on each seeded NEEDS_HUMAN demo case so the seeded
        ``request_approval`` rule opens a demo HITL Proposal — DETERMINISTIC + $0 (no LLM,
        no ``case-<uuid>`` minted; the automation runs on already-persisted demo cases).
        Writes ONLY the demo proposal store (never the real HITL queue). Best-effort —
        never raises. Returns the number of proposals opened (for status/tests)."""
        automation = getattr(self.pipeline, "automation", None)
        if automation is None or not cases:
            return 0
        dprefs = self._demo_prefs()
        opened = 0
        for case in cases:
            try:
                before = await self.open_proposal_count()
                await automation.run(case, dprefs, save=self.cases.save)
                after = await self.open_proposal_count()
                opened += max(0, after - before)
            except Exception as exc:  # noqa: BLE001 — a HITL seed glitch never breaks enable
                logger.debug("demo HITL proposal seed failed for %s: %s",
                             getattr(case, "case_id", "?"), exc)
        return opened

    def build_baseline_engine(self):
        """A fresh streaming anomaly-BASELINE model from the demo prefs' baseline block
        (forced ON in the sandbox). Warmed/flushed against the DEMO baseline_store."""
        from ..engine.baseline import BaselineEngine

        return BaselineEngine(getattr(self._demo_prefs(), "baseline", None))

    async def _ensure_funnel_baseline(self):
        if self._funnel_baseline is None:
            engine = self.build_baseline_engine()
            try:
                series = await self.baseline_store.snapshot()
                for sig, buckets in (series or {}).items():
                    engine.restore(sig, buckets)
            except Exception as exc:  # noqa: BLE001 — a cold baseline is fine
                logger.debug("demo funnel baseline warm-from-store failed (%s); cold start", exc)
            self._funnel_baseline = engine
        return self._funnel_baseline

    async def route_event_batch(self, events: list, segment: str) -> int:
        """Route ONE transient EVENT batch (XDR/EDR) through the cheap-first funnel and
        investigate the survivors SYNCHRONOUSLY, then DROP the raw list.

        The funnel pre-aggregates ``events`` into a bounded number of per-(signature,
        bucket) sketches, folds every bucket into the (demo) baseline (so it warms), and
        emits only the anomalous/rule-fired handful. Memory is bounded by the sketch
        size, NEVER by the retained-events count — this is what keeps ``40/s`` sane and
        $0. Confirmed survivors go straight to ``register_candidate`` +
        ``investigate_cluster`` (mock LLM, fast, deterministic, UNCHANGED decide() #3) —
        never the real batch service. Best-effort; never raises. Returns the number of
        clusters investigated (for logs/tests)."""
        if not events:
            return 0
        from ..engine import event_detection as evdet
        from ..engine.cost_gate import passes_suppression

        prefs = self._demo_event_prefs()
        try:
            baseline = await self._ensure_funnel_baseline()
            # pre_aggregate is a pure read (no observe) — compute the observed signatures
            # up front so we can flush EVERY warmed bucket (not just the candidate ones)
            # and the baseline visibly learns across ticks.
            summaries = evdet.pre_aggregate(events, prefs)
            candidates = evdet.funnel(events, prefs, baseline)
            await self._flush_funnel_baseline(baseline, summaries)
            count = 0
            for cand in candidates:
                cluster = evdet.shape_candidate_cluster(cand)
                # Same defence-in-depth gate the realtime path walks: an entirely-
                # suppressed cluster is the intended drop.
                if not passes_suppression(cluster, prefs):
                    continue
                await self.pipeline.register_candidate(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
                await self.pipeline.investigate_cluster(cluster, SourceSurface.AUTOMATED_SCAN, prefs)
                count += 1
            return count
        except Exception as exc:  # noqa: BLE001 — a bad batch must never break the ticker
            logger.warning("demo event-batch routing failed (%s): %s", segment, exc)
            return 0

    async def _flush_funnel_baseline(self, baseline, summaries) -> None:
        """Persist EVERY observed signature's sketch back to the demo baseline_store so
        the base visibly warms across ticks. Best-effort; never raises."""
        try:
            for s in summaries:
                snap = baseline.snapshot(s.signature)
                if snap:
                    await self.baseline_store.put(s.signature, snap)
        except Exception as exc:  # noqa: BLE001 — persistence is best-effort
            logger.debug("demo funnel baseline flush failed (%s)", exc)

    # ------------------------------------------------------------------ #
    # Capability pass (threshold-tuning + campaigns) — demo-scoped, isolated.
    # ------------------------------------------------------------------ #
    def _closed_case_reader(self):
        """An async ``read(limit, offset) -> list[Case]`` pager over the DEMO terminal
        cases (CLOSED + RESOLVED) for the threshold-tuner. Mirrors AppState's, bound to
        the demo case store. Best-effort per status."""
        from ..constants import TERMINAL_CASE_STATUSES

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

    async def _demo_write_prefs(self, new_prefs: Preferences) -> Preferences:
        """The tuner's config-writer, ISOLATED: it NEVER calls state.update_prefs (which
        would persist to the REAL tenant). Instead it stashes the tuned correlation
        rules on the DemoStack so ``_demo_prefs`` merges them on the next tick."""
        try:
            self._tuned_correlation_rules.update(dict(new_prefs.correlation_rules or {}))
        except Exception:  # noqa: BLE001
            pass
        return new_prefs

    async def run_capability_pass(self) -> None:
        """One demo-local capability pass: threshold-tuning + campaign correlation, both
        against the DEMO-scoped stores. NEVER touches the real tuning/campaign/proposal
        ledgers. Best-effort — a failure in one leg never breaks the other or the ticker.

        (a) threshold-tuning: since the 3 demo sources are deliberately NOT in
        ``prefs.sources``, a severity_floor suggestion can't locate its source and the
        tuner falls back to a HITL Proposal (a FEATURE, not a bug — the demo naturally
        exercises BOTH auto-tune (correlation_n) AND the approval path). Do NOT "fix"
        this by adding demo sources to prefs.sources.
        (b) campaigns: a pure read-time aggregator over the demo cases (no decide()/LLM)."""
        prefs = self._demo_prefs()
        # (a) threshold tuning.
        try:
            from ..engine.threshold_tuner import run_once

            await run_once(
                prefs, self._closed_case_reader(),
                self.proposals, self.audit,
                tuning_store=self.tuning_store,
                write_prefs=self._demo_write_prefs,
            )
        except Exception as exc:  # noqa: BLE001 — tuning must never break the pass
            logger.debug("demo tuning pass failed: %s", exc)
        # (b) campaigns.
        try:
            from ..engine.campaigns import correlate_campaigns

            campaigns = await correlate_campaigns(None, prefs, cases_store=self.cases)
            if campaigns:
                await self.campaign_store.upsert_many(campaigns)
        except Exception as exc:  # noqa: BLE001 — campaigns must never break the pass
            logger.debug("demo campaign pass failed: %s", exc)

    async def open_proposal_count(self) -> int:
        """Number of PENDING (awaiting-review) demo HITL proposals (best-effort → 0)."""
        try:
            props = await self.proposals.list(status="pending")
            return len(props)
        except Exception:  # noqa: BLE001
            try:
                return len(await self.proposals.list())
            except Exception:  # noqa: BLE001
                return 0

    async def purge(self) -> None:
        """Hard-delete ALL demo data (cases/audit/usage/events + the demo-scoped
        capability stores, which all live on this ES) by dropping the demo ES client's
        in-memory docs. Idempotent; never raises."""
        # Defense-in-depth: the demo pipeline publishes onto ``self.event_bus`` (an
        # isolated, history-disabled throwaway bus), so the global singleton should
        # already be clean. But if a FUTURE wiring regression ever let a demo
        # ``cases:{id}`` frame land in the global bus replay ring, scrub it here so a
        # demo run can never leave frames replayable past teardown. Collect the demo
        # case ids BEFORE we drop the in-memory docs below. Best-effort; never raises.
        try:
            from ..realtime import get_event_bus

            demo_case_ids = {
                str(doc.get("case_id"))
                for index in self.es.docs.values()
                for doc in index.values()
                if isinstance(doc, dict) and doc.get("case_id")
            }
            global_bus = get_event_bus()
            history = getattr(global_bus, "_history", None)
            if isinstance(history, dict) and demo_case_ids:
                for topic in list(history.keys()):
                    if topic.startswith("cases:") and topic.split("cases:", 1)[1] in demo_case_ids:
                        history.pop(topic, None)
        except Exception:  # noqa: BLE001 — purge is best-effort, never raises
            pass
        try:
            self.event_bus.clear()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.es.docs.clear()
            self.es.alias_to_index.clear()
        except Exception:  # noqa: BLE001
            pass

    async def aclose(self) -> None:
        try:
            await self.gateway.aclose()
        except Exception:  # noqa: BLE001
            pass


# A capability pass runs roughly every ~60s of demo wall-clock regardless of the tick
# cadence (a live demo session is minutes long, not the real "nightly/daily").
_CAPABILITY_TARGET_SECONDS = 60.0


class DemoSimulator:
    """The live demo ticker (only runs in ``mode == 'live'``).

    Mirrors a push-receiver task: a guarded loop that sleeps a jittered tick and, each
    tick, (1) drives the SIEM ALERT feed at its own ~``alert_interval_seconds`` cadence
    (one benign SIEM event, or — with probability ``incident_rate`` — one SIEM storyline
    ignition), and (2) routes the XDR+EDR EVENT feeds' logical ``event_rate_per_second``
    volume through the pre-aggregating funnel (bounded memory). On an accelerated cadence
    it also runs a demo-local capability pass. The RNG is seeded from ``demo.seed`` so a
    run is reproducible; the loop never raises (a bad tick is logged + skipped) and is
    cleanly cancellable on disable — a capability pass is only ever awaited INSIDE this
    task so cancelling the ticker tears down any in-flight pass."""

    def __init__(
        self,
        stack: DemoStack,
        get_prefs: Callable[[], Preferences],
        *,
        seed: int,
    ) -> None:
        self._stack = stack
        self._get_prefs = get_prefs
        self._rng = random.Random(seed ^ 0x71C)
        self._task: asyncio.Task | None = None
        self._running = False
        # Segment storyline queues, cycled deterministically per segment.
        self._siem_stories = gen.storylines_for_segment("siem") or list(gen.STORYLINES)
        self._siem_idx = 0
        self._capability_tick = 0

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._running = True
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def tick_once(self) -> dict[str, int]:
        """One simulation tick (also callable directly from tests for determinism).

        Drives the SIEM ALERT feed (low-volume, high-signal) + the XDR/EDR EVENT feeds
        (high-volume, pre-aggregated). Returns ``{benign, story, events}`` counts."""
        prefs = self._get_prefs()
        demo = getattr(prefs, "demo", None)
        if demo is None or not demo.active:
            return {"benign": 0, "story": 0, "events": 0}
        now = to_millis(now_utc())
        dprefs = self._stack._demo_prefs()  # noqa: SLF001 — same module owner
        benign_n = 0
        story_n = 0
        # 1. SIEM ALERT feed — fire ~once per ``alert_interval_seconds`` (a per-tick
        #    coin-flip so the cadence composes with ``tick_seconds``). Within a SIEM tick
        #    it is a benign alert OR, with prob ``incident_rate``, a storyline ignition.
        tick_s = float(getattr(demo, "tick_seconds", 10.0) or 10.0)
        alert_s = float(getattr(demo, "alert_interval_seconds", 120.0) or 120.0)
        p_siem = min(1.0, tick_s / max(1.0, alert_s))
        if self._rng.random() < p_siem:
            siem = self._stack.sources["siem"]
            if self._rng.random() < float(demo.incident_rate) and self._siem_stories:
                story = self._siem_stories[self._siem_idx % len(self._siem_stories)]
                self._siem_idx += 1
                events = siem.storyline_raw(story, self._rng, now, dprefs)
                story_n = 1
            else:
                events = siem.benign_batch_raw(self._rng, now - now % gen._MS_PER_HOUR, 1, dprefs)
                benign_n = len(events)
            await self._stack.ingest_service.ingest(
                events, dprefs, source_surface=SourceSurface.AUTOMATED_SCAN,
                source_id=gen.SEGMENT_SOURCE_IDS["siem"],
            )
        # 2. XDR + EDR EVENT feeds — the logical ~event_rate_per_second budget, split
        #    across the two segments, materialised TRANSIENTLY and dropped after the
        #    funnel (never N retained objects/sec).
        events_n = await self._route_event_feeds(now, dprefs, demo)
        return {"benign": benign_n, "story": story_n, "events": events_n}

    async def _route_event_feeds(self, now: int, dprefs: Preferences, demo) -> int:
        """Materialise the logical XDR+EDR event volume for this tick, feed it straight
        through the funnel via ``DemoStack.route_event_batch``, and DROP the raw list."""
        tick_s = float(getattr(demo, "tick_seconds", 10.0) or 10.0)
        rate = float(getattr(demo, "event_rate_per_second", 40.0) or 0.0)
        weight = gen.diurnal_weight(now)
        total = int(round(rate * tick_s * weight))
        if total <= 0:
            return 0
        hour_start = now - now % gen._MS_PER_HOUR
        n_xdr = int(round(total * _XDR_EVENT_SHARE))
        n_edr = max(0, total - n_xdr)
        routed = 0
        for seg, n in (("xdr", n_xdr), ("edr", n_edr)):
            if n <= 0:
                continue
            src = self._stack.sources[seg]
            # Materialise transiently — this list is DROPPED right after route_event_batch.
            events = src.benign_batch_raw(self._rng, hour_start, n, dprefs)
            routed += await self._stack.route_event_batch(events, seg)
        return routed

    async def _run(self) -> None:
        logger.info("Demo simulator started")
        while self._running:
            prefs = self._get_prefs()
            demo = getattr(prefs, "demo", None)
            base = float(getattr(demo, "tick_seconds", 10.0) or 10.0) if demo else 10.0
            jitter = float(getattr(demo, "tick_jitter", 0.3) or 0.0) if demo else 0.0
            delay = max(0.5, base * (1.0 + self._rng.uniform(-jitter, jitter)))
            try:
                if demo is not None and demo.mode == "live":
                    await self.tick_once()
                    self._capability_tick += 1
                    every_n = max(1, round(_CAPABILITY_TARGET_SECONDS / max(1.0, base)))
                    if self._capability_tick % every_n == 0:
                        # Awaited INSIDE this task so a disable/stop() cancel tears down
                        # any in-flight capability pass cleanly (never create_task'd).
                        await self._stack.run_capability_pass()
            except Exception as exc:  # noqa: BLE001 — a bad tick must not kill the loop
                logger.warning("demo tick failed (loop continues): %s", exc)
            await asyncio.sleep(delay)
